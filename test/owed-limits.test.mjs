// A send-back loop the engine used to leave unbounded — rebinding an adapter, re-deriving a
// test, re-recovering a requirement, a stage asked again and again by one line of work — has
// a limit in policy (`policy.loops.<kind>`, two by default). Past it, the stage still runs,
// and what it produces is escalated by the runner to its gate's escalation target rather than
// handed to the gate holder for another round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { git } from "../src/lib/git.mjs";
import { DEFAULT_OWED_LOOP, owedLoopLimit } from "../src/config/policy.mjs";
import { close, open, read, settle } from "../src/spec/owed.mjs";
import { checkOwedLimits } from "../src/runner/owed-limits.mjs";
import { finishStage } from "../src/runner/finish-stage.mjs";
import { requestedRevision } from "../src/stages/proposals.mjs";
import { stageFor } from "../src/stages/registry.mjs";
import { parseConfig } from "../src/config/load.mjs";

const COMMIT = ["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m"];

const CONFIG = `
pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: p, domains: [a] }
policy:
  gates:
    G0: { holder: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;

function repo(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-owed-limits-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]);
  writeFileSync(join(d, "README.md"), "x\n");
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "config.yaml"), CONFIG);
  writeFileSync(join(d, ".gitignore"), ".sdlc/run-state.json\n");
  run(["add", "-A"]);
  run([...COMMIT, "start"]);
  return { d, run };
}

const GATES = {
  G1: { holder: "tech-lead" },
  G2: { holder: "agent:architect", escalate_to: "tech-lead" },
  G3: { holder: "agent:reviewer", escalate_to: "tech-lead" },
};
const config = (loops = {}) => ({ policy: { gates: GATES, loops } });

// An item sent `n` times: every send but the last answered, the last still open.
function sent(d, kind, entry, n) {
  for (let i = 1; i <= n; i++) {
    open(d, kind, [{ ...entry, why: `attempt ${i}` }]);
    if (i < n) close(d, kind, () => true, { outcome: "met", why: `answered ${i}`, by: "runner" });
  }
  return read(d, kind).filter((e) => !e.closed);
}

test("each bounded kind defaults to two sends and takes its own limit from policy", () => {
  assert.equal(DEFAULT_OWED_LOOP, 2);
  for (const kind of ["rebind", "redo", "recovery", "request"]) {
    assert.equal(owedLoopLimit({}, kind), 2, kind);
    assert.equal(owedLoopLimit({ policy: { loops: { [kind]: 5 } } }, kind), 5, kind);
  }
});

test("the schema accepts a limit for each bounded kind and refuses one below one", () => {
  const base = parseYaml(CONFIG);
  const ok = (loops) => parseConfig(stringifyYaml({ ...base, policy: { ...base.policy, loops } })).errors.length === 0;
  assert.ok(ok({ rebind: 1, redo: 3, recovery: 2, request: 4 }));
  assert.ok(!ok({ redo: 0 }));
  assert.ok(!ok({ rebind: "two" }));
});

test("a stage handed an item within its limit runs as it always has", (t) => {
  const { d } = repo(t);
  const handed = sent(d, "redo", { id: "R-1.1", version: 1 }, 2);
  const ctx = { config: config(), deriveTestsRedo: handed };
  const r = checkOwedLimits(d, stageFor("derive-tests"), ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.owedOverLimit, []);
});

test("an item sent more times than its limit is marked for escalation, with every send's reason", (t) => {
  const { d } = repo(t);
  const handed = sent(d, "redo", { id: "R-1.1", version: 1 }, 3);
  const ctx = { config: config(), deriveTestsRedo: handed };
  const r = checkOwedLimits(d, stageFor("derive-tests"), ctx);
  assert.equal(r.ok, true, "G3 names somebody to escalate to");
  assert.equal(ctx.owedOverLimit.length, 1);
  const [over] = ctx.owedOverLimit;
  assert.deepEqual([over.kind, over.item, over.sends, over.limit], ["redo", "R-1.1", 3, 2]);
  assert.deepEqual(over.whys, ["attempt 1", "attempt 2", "attempt 3"]);

  const raised = { config: config({ redo: 3 }), deriveTestsRedo: handed };
  checkOwedLimits(d, stageFor("derive-tests"), raised);
  assert.deepEqual(raised.owedOverLimit, [], "a project that allows three sends is not escalated on the third");
});

test("rebind and recovery items are counted the same way, from what their stages are handed", (t) => {
  const { d } = repo(t);
  const rebind = sent(d, "rebind", { id: "R-1.2", target: "old" }, 3);
  open(d, "rebind", [{ id: "R-1.2", target: "new", why: "another adapter" }]);
  const bindCtx = { config: config(), target: "old", bindAdapterRebind: rebind };
  checkOwedLimits(d, stageFor("bind-adapter"), bindCtx);
  assert.deepEqual(bindCtx.owedOverLimit.map((o) => o.item), ["old:R-1.2"], "a finding about another target's adapter is another item");

  open(d, "recovery", ["a", "b", "c"].map((why) => ({ id: "R-2.1", domain: "content", version: 1, why })));
  const archaeology = stageFor("archaeology");
  const handed = archaeology.owedHanded(d, { domain: "content" });
  assert.equal(handed.length, 0, "a domain with no file holds no row to recover again");
  const recCtx = { config: config({ recovery: 2 }), domain: "content" };
  const over = checkOwedLimits(d, { ...archaeology, owedHanded: () => read(d, "recovery") }, recCtx);
  assert.equal(over.ok, false, "G1 names nobody to escalate to");
  assert.match(over.messages[0], /policy\.gates\.G1 names no escalate_to/);
  assert.match(over.messages[0], /policy\.loops\.recovery/);
});

test("a stage asked by one line of work more times than its limit is counted by ruling, not by line", (t) => {
  const { d } = repo(t);
  const ask = (from, why) => ({ stage: "plan", why, from, gate: "G3", by: "agent:reviewer", at: `2026-01-01T00:00:0${from.length % 10}.000Z` });
  open(d, "request", [ask("build-slice-2", "move R-1.2"), ask("build-slice-2", "split R-1.4")]);
  settle(d, "request", { close: read(d, "request") });
  open(d, "request", [ask("build-slice-2-2", "move R-1.2 again")]);
  open(d, "request", [ask("build-slice-3", "a different line of work")]);
  const ctx = { config: config(), revision: requestedRevision(d, "plan") };
  checkOwedLimits(d, stageFor("plan"), ctx);
  assert.deepEqual(ctx.owedOverLimit, [], "two rulings from one line of work, one of them routing two conditions, is two sends");

  settle(d, "request", { close: read(d, "request").filter((e) => !e.closed) });
  open(d, "request", [ask("build-slice-2-3", "and again")]);
  const third = { config: config(), revision: requestedRevision(d, "plan") };
  checkOwedLimits(d, stageFor("plan"), third);
  assert.equal(third.owedOverLimit.length, 1);
  assert.equal(third.owedOverLimit[0].sends, 3);
  assert.deepEqual(third.owedOverLimit[0].whys, ["move R-1.2", "split R-1.4", "move R-1.2 again", "and again"]);
});

test("a gate with no escalation target refuses the run rather than leaving the item nowhere to go", (t) => {
  const { d } = repo(t);
  const handed = sent(d, "redo", { id: "R-1.1", version: 1 }, 3);
  const noTarget = { policy: { gates: { ...GATES, G3: { holder: "agent:reviewer" } } } };
  const r = checkOwedLimits(d, stageFor("derive-tests"), { config: noTarget, deriveTestsRedo: handed });
  assert.equal(r.ok, false);
  assert.match(r.messages[0], /R-1\.1: sent to derive-tests 3 times/);
  assert.match(r.messages[0], /add escalate_to to G3/);
});

test("past the limit the proposal is opened as usual and escalated by the runner, recorded as the runner's", async (t) => {
  const { d } = repo(t);
  const ask = (from, why) => ({ stage: "plan", why, from, gate: "G3", by: "agent:reviewer", at: "2026-01-01T00:00:00.000Z" });
  for (const from of ["build-slice-2", "build-slice-2-2"]) {
    open(d, "request", [ask(from, `asked by ${from}`)]);
    settle(d, "request", { close: read(d, "request").filter((e) => !e.closed) });
  }
  open(d, "request", [ask("build-slice-2-3", "asked a third time")]);
  git(["add", "-A"], d);
  git([...COMMIT, "file requests"], d);

  const stage = {
    name: "plan", title: "plan (revise)", gate: "G2", postChecks: () => [],
    proposal: () => ({ name: "plan-2", question: "Is the revised cut right?", recommendation: "the slices were recut" }),
  };
  const ctx = { revise: true, config: config(), revision: requestedRevision(d, "plan") };
  assert.equal(checkOwedLimits(d, stage, ctx).ok, true);
  const r = await finishStage(d, stage, ctx, { text: "## Journal\n\nRecut.", cost: 0, turns: 1, sessionId: "mock" });
  assert.equal(r.ok, true, JSON.stringify(r.messages));
  assert.equal(r.proposal.escalatedTo, "tech-lead");

  const gate = parseYaml(git(["show", "proposal/plan-2:.sdlc/gates/plan-2.yaml"], d));
  assert.equal(gate.verdict, "escalated");
  assert.equal(gate.by, "runner:plan");
  assert.equal(gate.held_by, "runner");
  assert.equal(gate.escalate_to, "tech-lead");
  assert.match(gate.rationale, /sent to plan 3 times/);
  assert.match(gate.rationale, /policy\.loops\.request/);
  assert.match(gate.rationale, /asked a third time/);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  assert.ok(read(d, "request").every((e) => e.closed), "the round is still taken up by the run that answered it");
});

test("within the limit nothing is escalated and the gate holder rules as before", async (t) => {
  const { d } = repo(t);
  open(d, "request", [{ stage: "plan", why: "once", from: "build-slice-2", gate: "G3", by: "agent:reviewer", at: "1" }]);
  git(["add", "-A"], d);
  git([...COMMIT, "file request"], d);
  const stage = {
    name: "plan", title: "plan (revise)", gate: "G2", postChecks: () => [],
    proposal: () => ({ name: "plan-2", question: "Is the revised cut right?", recommendation: "recut" }),
  };
  const ctx = { revise: true, config: config(), revision: requestedRevision(d, "plan") };
  checkOwedLimits(d, stage, ctx);
  const r = await finishStage(d, stage, ctx, { text: "## Journal\n\nRecut.", cost: 0, turns: 1, sessionId: "mock" });
  assert.equal(r.proposal.escalatedTo, undefined);
  assert.throws(() => git(["show", "proposal/plan-2:.sdlc/gates/plan-2.yaml"], d), "no gate file: the proposal waits for its holder");
});

// A ruler withdraws an open revision request with the line a condition is withdrawn with,
// naming it `request/<proposal>#<n>`, from either seat and on either verdict
// (`docs/decisions/0084`). The reference is printed wherever an open request is listed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { git, gitOk } from "../src/lib/git.mjs";
import { rule, ruleByAgent } from "../src/commands/rule.mjs";
import { buildPersonaPrompt } from "../src/runner/persona.mjs";
import { openFor, openOn } from "../src/spec/owed.mjs";
import { checkConditions } from "../src/checks/conditions.mjs";

const CONFIG = `
pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: p, domains: [a] }
policy:
  gates:
    G0: { holder: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: tech-lead }
    G2: { holder: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead }
    G-POL: { holder: "agent:tech-lead", escalate_to: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;

// The live case: a build ruling asked bind-adapter to re-run a test it cannot see, and a run of
// bind-adapter deferred it. The first request from the same ruling was taken up.
const RERUN = "R-1.3 read '' at an assertion on target new, and the result does not say which one. Re-run R-1.3 and report which step read ''.";
const REQUESTS = [
  { stage: "bind-adapter", target: "new", why: "the upload control must treat a row with a download link as stored", from: "build-slice-1-1", gate: "G3", by: "agent:tech-lead",
    at: "2026-10-01T09:50:03.359Z", taken: "2026-10-01T09:59:04.225Z", taken_by: "bind-adapter-new-28" },
  { stage: "bind-adapter", target: "new", why: RERUN, from: "build-slice-1-1", gate: "G3", by: "agent:tech-lead", at: "2026-10-01T09:50:03.359Z",
    deferred: { at: "2026-10-01T10:07:10.465Z", why: "the criterion's test isn't in this workspace and the suite can't run here", proposal: "bind-adapter-new-30" } },
  { stage: "plan", why: "move R-1.2 to the slice that builds its screen", from: "build-slice-9", gate: "G3", by: "tech-lead", at: "2026-10-01T09:00:00.000Z" },
];
const REF = "request/build-slice-1-1#2";
const WITHDRAW = `condition-withdrawn ${REF}: bind-adapter is blind to the tests and cannot run them; verify now names the failing line`;

function put(d, rel, text) {
  mkdirSync(join(d, rel, ".."), { recursive: true });
  writeFileSync(join(d, rel), text);
}

function commit(d, m) {
  git(["add", "-A"], d);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", m], d);
}

// `main` holds the requests above; `proposal/build-slice-1-2` is the open revision of the build,
// verified passing.
function project(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-withdraw-request-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], d);
  put(d, ".sdlc/config.yaml", CONFIG);
  put(d, ".gitattributes", ".sdlc/runs/*.md merge=union\n");
  for (const p of ["reviewer", "tech-lead"]) put(d, `.sdlc/personas/${p}.md`, `# Persona: ${p}\n\nRules.\n`);
  put(d, "spec/criteria-index.json", JSON.stringify({ criteria: [{ id: "R-1.1", domain: "a", version: 1, state: "accepted" }] }));
  put(d, "plan/tasks.md", "# Tasks\n\n### Slice 1 · orders\n\n- criteria: R-1.1\n");
  put(d, ".sdlc/revision-requests.yaml", stringifyYaml({ requests: REQUESTS }));
  commit(d, "init");
  git(["checkout", "-q", "-b", "proposal/build-slice-1-2"], d);
  put(d, "app/index.ts", "export {};\n");
  put(d, ".sdlc/proposals/build-slice-1-2.md",
    "---\ngate: G3\nquestion: \"Does it work?\"\nrecommendation: \"Yes.\"\nopened: 2026-10-01T11:00:00.000Z\n---\n\n# Does it work?\n");
  commit(d, "open build-slice-1-2");
  put(d, "tests/results/new/slice-1.json", JSON.stringify({
    slice: 1, proposal: "build-slice-1-2", app_tree: git(["rev-parse", "HEAD:app"], d), at: "2026-10-01T11:00:00.000Z", verdict: "pass",
    rows: [{ id: "R-1.1", version: 1, domain: "a", file: "tests/acceptance/a/R-1.1.spec.ts", result: "pass" }],
  }));
  commit(d, "verify slice 1");
  git(["checkout", "-q", "main"], d);
  return d;
}

function withMock(t, entries) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const names = join(mkdtempSync(join(tmpdir(), "sdlc-withdraw-request-egress-")), "names.txt");
  writeFileSync(names, "");
  process.env.SDLC_EGRESS_NAMES = names;
  process.env.SDLC_EXECUTOR = "mock";
  const dir = mkdtempSync(join(tmpdir(), "sdlc-withdraw-request-mock-"));
  const turn = ({ verdict, rationale, conditions = [] }) => ({ text: `\`\`\`json\n${JSON.stringify({ verdict, rationale, conditions })}\n\`\`\`` });
  writeFileSync(join(dir, "rule.json"), JSON.stringify({ sequence: (entries ?? []).map(turn) }));
  process.env.SDLC_MOCK_DIR = dir;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    if (prevEgress === undefined) delete process.env.SDLC_EGRESS_NAMES; else process.env.SDLC_EGRESS_NAMES = prevEgress;
  });
}

const onMain = (d) => parseYaml(git(["show", "main:.sdlc/revision-requests.yaml"], d)).requests;

test("a person's approval withdraws the request it names, recording who, when and why, and nothing else moves", (t) => {
  const d = project(t);
  const r = rule(d, "build-slice-1-2", "approve", { by: "tech-lead", note: "fine", conditions: [WITHDRAW] });
  assert.equal(r.verdict, "approve");
  assert.deepEqual(r.closed, [{ ref: REF, outcome: "withdrawn" }]);
  const stored = onMain(d);
  assert.equal(stored[1].withdrawn.by, "tech-lead");
  assert.match(stored[1].withdrawn.why, /blind to the tests/);
  assert.match(stored[1].withdrawn.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(stored[1].taken, undefined, "a withdrawal is not a run taking it up");
  assert.equal(stored[1].deferred.proposal, "bind-adapter-new-30", "the run's account of why it deferred stays on file");
  assert.equal(stored[0].taken_by, "bind-adapter-new-28");
  assert.equal(stored[2].withdrawn, undefined);
  assert.deepEqual(openFor(d, "bind-adapter", { kinds: ["request"] }), [], "no run of bind-adapter is handed it again");
  assert.match(git(["log", "--format=%s", "main"], d), new RegExp(`build-slice-1-2 closes ${REF} withdrawn`));
});

test("a return withdraws it too", (t) => {
  const d = project(t);
  rule(d, "build-slice-1-2", "return", { by: "tech-lead", note: "the badge is wrong", conditions: [WITHDRAW, "app/index.ts must export the badge"] });
  assert.equal(onMain(d)[1].withdrawn.by, "tech-lead");
});

test("a request is not closed by saying it was met, nor withdrawn when nothing open has that reference", (t) => {
  const d = project(t);
  assert.throws(() => rule(d, "build-slice-1-2", "return", { by: "tech-lead", note: "x", conditions: [`condition-met ${REF}: done`] }),
    /is a revision request, and a request is met only by the run of its stage that takes it up/);
  assert.throws(() => rule(d, "build-slice-1-2", "return", { by: "tech-lead", note: "x", conditions: ["condition-withdrawn request/build-slice-1-1#1: no longer wanted"] }),
    /"request\/build-slice-1-1#1" is not an open revision request\. The revision requests still open are: request\/build-slice-1-1#2 \(to bind-adapter: .*\); request\/build-slice-9#1 \(to plan: "move R-1\.2 to the slice that builds its screen"\)/);
  assert.throws(() => rule(d, "build-slice-1-2", "return", { by: "tech-lead", note: "x", conditions: ["condition-withdrawn request/build-slice-1-1: no position"] }),
    /is not an open revision request/);
  assert.equal(gitOk(["cat-file", "-e", "proposal/build-slice-1-2:.sdlc/gates/build-slice-1-2.yaml"], d), false, "nothing is ruled");
  assert.equal(onMain(d)[1].withdrawn, undefined);
});

test("an agent's wrong reference is re-prompted once with the open list, and the corrected withdrawal lands under its seat", async (t) => {
  withMock(t, [
    { verdict: "approve", rationale: "passes", conditions: ["condition-withdrawn request/build-slice-1-1#5: cannot be answered"] },
    { verdict: "approve", rationale: "passes", conditions: [WITHDRAW] },
  ]);
  const d = project(t);
  const r = await ruleByAgent(d, "build-slice-1-2", { persona: "reviewer" });
  assert.equal(r.verdict, "approve");
  assert.equal(r.reprompted, true);
  assert.equal(onMain(d)[1].withdrawn.by, "agent:reviewer");
});

test("the ruler is shown the deferred request and its own line's requests with their references, and how to withdraw one", async (t) => {
  withMock(t);
  const d = project(t);
  git(["checkout", "-q", "proposal/build-slice-1-2"], d);
  const prompt = await buildPersonaPrompt(d, "build-slice-1-2", "reviewer", { tier: "STANDARD", gate: "G3" });
  const section = prompt.split("## Revision requests still open")[1]?.split("\n## ")[0] ?? "";
  assert.ok(section, "the section is there");
  assert.match(section, /- `request\/build-slice-1-1#2` — to bind-adapter, ruled at G3 on build-slice-1-1: "R-1\.3 read '' .*" Deferred by bind-adapter-new-30: "the criterion's test isn't in this workspace/);
  assert.doesNotMatch(section, /request\/build-slice-1-1#1/, "a request already taken up is not open");
  assert.doesNotMatch(section, /request\/build-slice-9#1/, "another line's request nobody deferred is not this section's; the checks above list it");
  assert.match(section, /condition-withdrawn <ref>: <why it is no longer asked for>/);
});

// A run takes a request up on its own proposal branch, and that reaches `main` only when the
// proposal is approved; the ruler of that proposal must not be shown it as open, or a condition
// closing it is refused against the branch.
test("a request the proposal under ruling took up on its branch is not shown to its ruler as open", async (t) => {
  withMock(t);
  const d = project(t);
  git(["checkout", "-q", "proposal/build-slice-1-2"], d);
  const taken = REQUESTS.map((r, i) => (i === 1 ? { ...r, deferred: undefined, taken: "2026-10-01T11:30:00.000Z", taken_by: "build-slice-1-2" } : r));
  put(d, ".sdlc/revision-requests.yaml", stringifyYaml({ requests: taken }));
  commit(d, "take request");
  const prompt = await buildPersonaPrompt(d, "build-slice-1-2", "reviewer", { tier: "STANDARD", gate: "G3" });
  assert.doesNotMatch(prompt, new RegExp(REF.replace(/[/#.]/g, "\\$&")), "the request it took is not listed as open");
});

test("sdlc checks leads each open request with its reference and names the withdrawal", (t) => {
  const d = project(t);
  const c = checkConditions(d);
  const line = c.warnings.find((w) => w.startsWith(`${REF}: `));
  assert.ok(line, JSON.stringify(c.warnings));
  assert.match(line, /A run opening bind-adapter-new-30 deferred it/);
  assert.match(line, /or withdraw it on a ruling with `condition-withdrawn <ref>: <why it is no longer asked for>`/);
  rule(d, "build-slice-1-2", "approve", { by: "tech-lead", note: "fine", conditions: [WITHDRAW] });
  assert.ok(!checkConditions(d).warnings.some((w) => w.startsWith(`${REF}: `)), "a withdrawn request is no longer listed");
  assert.deepEqual(openOn(d, "request").map((e) => e.ref), ["request/build-slice-9#1"]);
});

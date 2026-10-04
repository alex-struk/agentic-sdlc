import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runSuite } from "../src/testrun/playwright.mjs";
import { verify, verifyVerdict, mergeFailureText, unboundReasons } from "../src/stages/verify.mjs";
import { DEFAULT_VERIFY_RETURNS as MAX_VERIFY_RETURNS } from "../src/config/policy.mjs";
import { build } from "../src/stages/build.mjs";
import { buildVerified } from "../src/commands/rule.mjs";
import { buildProposalBase } from "../src/stages/slices.mjs";
import { nextProposalName } from "../src/stages/proposals.mjs";
import { registerStage } from "../src/stages/registry.mjs";
import { runStage } from "../src/commands/run.mjs";
import { COMMANDS } from "../src/cli.mjs";

// The fixture's `new` target signs in through the sandbox's own identity provider, and
// verify refuses to start one of those without `SDLC_SANDBOX_PASSWORD` set. Only that the
// variable is set matters anywhere in this file; nothing reads its value, and no real
// sign-in happens, since every suite run here is mocked.
process.env.SDLC_SANDBOX_PASSWORD = "set-for-tests";

test("a suite run given spec files runs exactly those", (t) => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-files-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  mkdirSync(join(d, "tests", "acceptance", "users"), { recursive: true });
  mkdirSync(join(d, "tests", "test-results"), { recursive: true });
  writeFileSync(join(d, "tests", "test-results", "results.json"), '{"suites":[]}');
  // The target has an adapter: without one there is nothing to drive and no run happens.
  mkdirSync(join(d, "tests", "adapters", "new"), { recursive: true });
  writeFileSync(join(d, "tests", "adapters", "new", "index.ts"), "export const surface = {};\n");
  const calls = [];
  const exec = (cmd, args) => { calls.push(args); return { status: 0, stdout: '{"suites":[]}', stderr: "" }; };
  runSuite({ projectDir: d, target: "new", baseUrl: "http://x", files: ["tests/acceptance/users/R-4.1.spec.ts"], exec });
  const run = calls.find((a) => a.includes("playwright"));
  assert.ok(run.includes("acceptance/users/R-4.1.spec.ts"));
  assert.ok(!run.some((a) => a === "acceptance/users/"));
});

const row = (id, result, error) => ({ id, result, file: `tests/acceptance/users/${id}.spec.ts`, tests: error ? [{ status: "failed", error }] : [] });

test("a slice passes only when every criterion it claims was asserted against the application and met", () => {
  assert.equal(verifyVerdict([row("R-1", "pass"), row("R-2", "pass")], ["R-1", "R-2"]).verdict, "pass");
  assert.equal(verifyVerdict([row("R-1", "pass"), row("R-2", "stale")], ["R-1", "R-2"]).verdict, "fail", "a stale test cannot verify a slice (spec 7.2)");
  assert.equal(verifyVerdict([row("R-1", "pass")], ["R-1", "R-2"]).verdict, "fail", "a claimed criterion with no row is not verified");
  const u = verifyVerdict([row("R-1", "pass"), row("R-2", "unbound")], ["R-1", "R-2"]);
  assert.equal(u.verdict, "unbound");
  assert.deepEqual(u.unbound, ["R-2"]);
  assert.equal(verifyVerdict([row("R-1", "fail", "x"), row("R-2", "unbound")], ["R-1", "R-2"]).verdict, "fail");
});

// A `not-testable` row is a criterion the contract surface offers no way to exercise, and an
// `attested` row is one somebody vouched for in place of a test. Neither is a failure and
// neither is evidence about the application, so a slice carrying one is not a slice whose
// claims were all asserted — and the verdict has to be able to say so.
test("a criterion nobody asserted against the application is neither a failure nor a clean pass", () => {
  const v = verifyVerdict([row("R-1", "pass"), row("R-2", "not-testable"), row("R-3", "attested")], ["R-1", "R-2", "R-3"]);
  assert.equal(v.verdict, "pass-unasserted");
  assert.deepEqual(v.unasserted.map((r) => r.id), ["R-2", "R-3"]);
  assert.deepEqual(v.unasserted.map((r) => r.result), ["not-testable", "attested"]);
  assert.equal(v.failing.length, 0, "it is not reported as a failing criterion either");
  // A criterion that was exercised and came out wrong, and one that could not be exercised
  // at all, each still decide the verdict over one that was never asserted.
  assert.equal(verifyVerdict([row("R-1", "fail", "x"), row("R-2", "not-testable")], ["R-1", "R-2"]).verdict, "fail");
  assert.equal(verifyVerdict([row("R-1", "unbound"), row("R-2", "attested")], ["R-1", "R-2"]).verdict, "unbound");
});

// A real project, a build proposal on its branch, the suite and the sandbox both mocked.
function buildProject(t, { escalateTo = "tech-lead", notTestable = [], policy = [] } = {}) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-verify-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]);
  mkdirSync(join(d, ".sdlc", "proposals"), { recursive: true });
  mkdirSync(join(d, "plan"), { recursive: true });
  mkdirSync(join(d, "app", "compose"), { recursive: true });
  mkdirSync(join(d, "tests", "acceptance", "users"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "config.yaml"), [
    "pipeline: { repo: a, ref: main }", "profile: greenfield", "stack: openshift-ts", "project: { name: p, domains: [users] }",
    "targets:", "  new: { base_url: \"http://localhost:8080\", identity: sandbox-idp }",
    "policy:", "  gates:",
    ...["G0", "G1", "G-DESIGN", "G2"].map((g) => `    ${g}: { holder: tech-lead }`),
    escalateTo ? `    G3: { holder: "agent:reviewer", escalate_to: ${escalateTo} }` : "    G3: { holder: reviewer }",
    "    G-POL: { holder: \"agent:tech-lead\", escalate_to: tech-lead }",
    "  default_tier: STANDARD", ...policy.map((l) => `  ${l}`), "skills: { packs: [] }", "egress: { rules: [E-2] }", "",
  ].join("\n"));
  writeFileSync(join(d, ".gitattributes"), ".sdlc/runs/*.md merge=union\n");
  writeFileSync(join(d, "plan", "tasks.md"), "### Slice 1 · Sign in\n- criteria: R-4.1, R-4.2\n");
  // A criterion recorded not-testable has no spec file and an entry carrying its reason,
  // which is the shape `checkTests` requires of the pair and the only place that reason
  // is written down.
  for (const id of ["R-4.1", "R-4.2"].filter((id) => !notTestable.includes(id))) writeFileSync(join(d, "tests", "acceptance", "users", `${id}.spec.ts`), "");
  if (notTestable.length) {
    writeFileSync(join(d, "tests", "acceptance", "not-testable.yaml"),
      `criteria:\n${notTestable.map((id) => `  - { id: ${id}, version: 1, reason: "the contract surface offers no way to observe it" }\n`).join("")}`);
  }
  writeFileSync(join(d, "app", "compose", "compose.yaml"), "services: {}\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "start"]);
  run(["checkout", "-q", "-b", "proposal/build-slice-1"]);
  writeFileSync(join(d, ".sdlc", "proposals", "build-slice-1.md"), "---\ngate: G3\nquestion: \"q\"\nrecommendation: \"r\"\n---\n");
  writeFileSync(join(d, "app", "index.ts"), "export {};\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "propose"]);
  run(["checkout", "-q", "main"]);
  return d;
}

function mockSuite(t, rows) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-verify-rows-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // `runSuite`'s mock reader (`src/testrun/playwright.mjs`) always reads
  // `SDLC_MOCK_DIR/calibrate.json`, whatever the caller — the same file every other
  // mocked suite run in this repo writes to.
  writeFileSync(join(dir, "calibrate.json"), JSON.stringify({ rows: rows.map((r) => ({ ...r, domain: "users", version: 1 })) }));
  process.env.SDLC_TEST_RUNNER = "mock"; process.env.SDLC_MOCK_DIR = dir;
  t.after(() => { delete process.env.SDLC_TEST_RUNNER; delete process.env.SDLC_MOCK_DIR; });
}

// The new target's adapter, committed on main, and its tree: the adapter a row verify
// records was found under.
function commitAdapter(d) {
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  mkdirSync(join(d, "tests", "adapters", "new"), { recursive: true });
  writeFileSync(join(d, "tests", "adapters", "new", "index.ts"), "export const surface = {};\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "adapter"]);
  return execFileSync("git", ["rev-parse", "main:tests/adapters/new"], { cwd: d, encoding: "utf8" }).trim();
}

// `bind-adapter --target new` already sent for `id` as often as policy.loops.rebind allows
// (two by default), under the adapter on main now: against the application tree `appTree`
// where one is given, and against no build in particular otherwise.
function spendBinding(d, id, adapter, appTree = "") {
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  const tree = appTree ? `, app_tree: ${appTree}` : "";
  const sent = (n) => `  - { id: ${id}, target: new, why: "unbound: a.b — gone", found: unbound, adapter: ${adapter}, slice: 1${tree}, by: "runner:verify", at: "2026-01-0${n}T00:00:00.000Z", closed: { outcome: met, why: "sent", at: "2026-01-0${n}T00:00:00.000Z" } }\n`;
  writeFileSync(join(d, "tests", "adapters", "rebind.yaml"), `rebind:\n${sent(1)}${sent(2)}`);
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "spent"]);
}

const ctxFor = (d) => ({ slice: 1, config: parseYaml(readFileSync(join(d, ".sdlc", "config.yaml"), "utf8")), sandbox: { up: async () => ({ ok: true, baseUrl: "http://localhost:8080" }), down: () => ({ ok: true }) } });
const onBranch = (d, path) => execFileSync("git", ["show", `proposal/build-slice-1:${path}`], { cwd: d, encoding: "utf8" });

test("a passing slice records its result on the proposal branch, and main is untouched", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const mainBefore = execFileSync("git", ["rev-parse", "main"], { cwd: d, encoding: "utf8" });
  const ctx = ctxFor(d);
  assert.ok(verify.preChecks(d, ctx).every((c) => c.ok));
  const r = await verify.execute(d, ctx);
  assert.match(r.text, /slice 1 verified/);
  const result = JSON.parse(onBranch(d, "tests/results/new/slice-1.json"));
  assert.equal(result.verdict, "pass");
  assert.equal(result.proposal, "build-slice-1");
  assert.equal(result.app_tree, execFileSync("git", ["rev-parse", "proposal/build-slice-1^:app"], { cwd: d, encoding: "utf8" }).trim(),
    "the tree verified is the application the proposal contained, before verify's own commit");
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d, encoding: "utf8" }).trim(), "main");
  assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: d, encoding: "utf8" }), mainBefore);
});

// The sentence a reviewer reads before approving a build is the last thing the pipeline
// says about it. Where a criterion was never asserted against the application, that
// sentence may not claim every claimed criterion passes against it, and the verdict on the
// branch may not read as the one a fully asserted slice earns.
test("a slice carrying a criterion nobody asserted says so, and stays rulable", async (t) => {
  const d = buildProject(t, { notTestable: ["R-4.2"] });
  mockSuite(t, [row("R-4.1", "pass")]);
  const ctx = ctxFor(d);
  assert.ok(verify.preChecks(d, ctx).every((c) => c.ok));
  const r = await verify.execute(d, ctx);

  assert.ok(!/every claimed criterion passes/.test(r.text), "the universal is not printed over a criterion nobody asserted");
  assert.match(r.text, /1 of the 2 criteria/, "the terminal says how many were asserted and met");
  assert.match(r.text, /the other 1 was never asserted against it at all — R-4\.2/, "and names which were not");
  assert.match(r.text, /R-4\.2 \(not-testable\): the contract surface offers no way to observe it/, "with the reason recorded for it");
  assert.equal(r.notPassed, undefined, "the run did what it was asked, so it is not reported as a run that did not pass");

  const result = JSON.parse(onBranch(d, "tests/results/new/slice-1.json"));
  assert.equal(result.verdict, "pass-unasserted");
  assert.deepEqual(result.unasserted, [{ id: "R-4.2", result: "not-testable", reason: "the contract surface offers no way to observe it" }]);

  // Whether a slice may be approved with a criterion nobody asserted is the ruling's
  // question. This changes what the ruler is told, and not what may reach the gate.
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["checkout", "-q", "proposal/build-slice-1"]);
  assert.equal(buildVerified(d, "build-slice-1").ok, true, "the proposal is still rulable as approved");
  run(["checkout", "-q", "main"]);
});

// The one outcome that earns the universal.
test("a slice whose every claimed criterion was asserted and met keeps the sentence that says so", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.match(r.text, /every claimed criterion passes against the application/);
  assert.equal(JSON.parse(onBranch(d, "tests/results/new/slice-1.json")).verdict, "pass");
});

test("a failing slice is returned to the builder with what the application did", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "fail", "Error: expected heading \"Sign in\"\n    at x")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.equal(gate.verdict, "return");
  assert.equal(gate.by, "runner:verify");
  assert.equal(gate.held_by, "runner");
  assert.deepEqual(gate.conditions, ["R-4.2: Error: expected heading \"Sign in\""]);
});

test("the third failing verify of a slice escalates instead of returning again", async (t) => {
  const d = buildProject(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  // Two earlier attempts, each returned by verify.
  for (const k of [2, 3]) {
    run(["checkout", "-q", "-b", `proposal/build-slice-1-${k}`, "proposal/build-slice-1"]);
    run(["checkout", "-q", "main"]);
  }
  for (const name of ["build-slice-1", "build-slice-1-2"]) {
    run(["checkout", "-q", `proposal/${name}`]);
    mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
    writeFileSync(join(d, ".sdlc", "gates", `${name}.yaml`), "gate: G3\nverdict: return\nby: runner:verify\nheld_by: runner\n");
    run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "returned"]);
    run(["checkout", "-q", "main"]);
  }
  mockSuite(t, [row("R-4.1", "fail", "Error: still wrong"), row("R-4.2", "pass")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  assert.equal(ctx.verifyProposal, "build-slice-1-3");
  await verify.execute(d, ctx);
  const gate = parseYaml(execFileSync("git", ["show", "proposal/build-slice-1-3:.sdlc/gates/build-slice-1-3.yaml"], { cwd: d, encoding: "utf8" }));
  assert.equal(MAX_VERIFY_RETURNS, 3);
  assert.equal(gate.verdict, "escalated");
  assert.equal(gate.escalate_to, "tech-lead");
});

// Who G3 escalates to is the project's policy: `rule.mjs` already routes by it, and the
// name verify writes into the gate file is the same answer rendered for a reader. A
// project that escalates G3 somewhere else would otherwise get a gate file naming a role
// that never receives the question.
test("the escalation names whoever the project's G3 policy escalates to", async (t) => {
  const d = buildProject(t, { escalateTo: "delivery-manager" });
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  for (const k of [2, 3]) {
    run(["checkout", "-q", "-b", `proposal/build-slice-1-${k}`, "proposal/build-slice-1"]);
    run(["checkout", "-q", "main"]);
  }
  for (const name of ["build-slice-1", "build-slice-1-2"]) {
    run(["checkout", "-q", `proposal/${name}`]);
    mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
    writeFileSync(join(d, ".sdlc", "gates", `${name}.yaml`), "gate: G3\nverdict: return\nby: runner:verify\nheld_by: runner\n");
    run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "returned"]);
    run(["checkout", "-q", "main"]);
  }
  mockSuite(t, [row("R-4.1", "fail", "Error: still wrong"), row("R-4.2", "pass")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  const gate = parseYaml(execFileSync("git", ["show", "proposal/build-slice-1-3:.sdlc/gates/build-slice-1-3.yaml"], { cwd: d, encoding: "utf8" }));
  assert.equal(gate.escalate_to, "delivery-manager");
  assert.match(r.text, /escalated to delivery-manager/);
});

// How many builds a slice gets before verify stops returning it is the project's policy
// (spec §7.1: retry bounds are policy values in config), counted the same way.
test("the return limit is read from policy.loops.verify_returns", async (t) => {
  const d = buildProject(t, { policy: ["loops: { verify_returns: 2 }"] });
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["checkout", "-q", "-b", "proposal/build-slice-1-2", "proposal/build-slice-1"]);
  run(["checkout", "-q", "proposal/build-slice-1"]);
  mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "gates", "build-slice-1.yaml"), "gate: G3\nverdict: return\nby: runner:verify\nheld_by: runner\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "returned"]);
  run(["checkout", "-q", "main"]);
  mockSuite(t, [row("R-4.1", "fail", "Error: still wrong"), row("R-4.2", "pass")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  assert.equal(ctx.verifyProposal, "build-slice-1-2");
  const r = await verify.execute(d, ctx);
  const gate = parseYaml(execFileSync("git", ["show", "proposal/build-slice-1-2:.sdlc/gates/build-slice-1-2.yaml"], { cwd: d, encoding: "utf8" }));
  assert.equal(gate.verdict, "escalated", "the second failing verify is the limit when the policy says two");
  assert.match(gate.rationale, /returned by verify 2 times|failed verify 2 times/);
  assert.match(r.text, /after 2 builds/);
});

// A slice that reaches the limit is handed to G3's escalation target. A project whose G3
// names none has nowhere to hand it, and a role written in its place is a role the
// project may not have: the gate file would name somebody who never gets the question.
test("verify refuses to run when G3 names no escalation target", (t) => {
  const d = buildProject(t, { escalateTo: null });
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const ctx = ctxFor(d);
  const failed = verify.preChecks(d, ctx).filter((c) => !c.ok);
  assert.equal(failed.length, 1);
  assert.match(failed[0].messages.join("\n"), /policy\.gates\.G3 names no escalate_to/);
});

// Only verify's own returns feed the three-strikes escalation. A reviewer who returns the
// same build proposal is asking for a different change — its gate file says
// `by: agent:reviewer` — and counting it would escalate a slice verify itself had only
// returned once, handing a person a question the pipeline had not finished asking.
test("a return the reviewer wrote is not counted toward verify's escalation", async (t) => {
  const d = buildProject(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  for (const k of [2, 3]) {
    run(["checkout", "-q", "-b", `proposal/build-slice-1-${k}`, "proposal/build-slice-1"]);
    run(["checkout", "-q", "main"]);
  }
  // Two earlier returns of this slice, one from each author. Counted alike they would be
  // the second and third strikes and this run would escalate.
  for (const [name, by] of [["build-slice-1", "agent:reviewer"], ["build-slice-1-2", "runner:verify"]]) {
    run(["checkout", "-q", `proposal/${name}`]);
    mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
    writeFileSync(join(d, ".sdlc", "gates", `${name}.yaml`), `gate: G3\nverdict: return\nby: ${by}\nheld_by: runner\n`);
    run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "returned"]);
    run(["checkout", "-q", "main"]);
  }
  mockSuite(t, [row("R-4.1", "fail", "Error: still wrong"), row("R-4.2", "pass")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  const gate = parseYaml(execFileSync("git", ["show", "proposal/build-slice-1-3:.sdlc/gates/build-slice-1-3.yaml"], { cwd: d, encoding: "utf8" }));
  assert.equal(gate.verdict, "return", "one verify return plus this one is the second strike, not the third");
  assert.equal(gate.escalate_to, undefined);
  assert.match(r.text, /returned/);
});

// A person who returns an escalated slice has answered the escalation; the verify returns
// before that ruling are not held against the build it asked for. An agent seat's return
// does not reset the count, or the loop would never reach a person (`0076`).
for (const [by, expected] of [["tech-lead", "return"], ["agent:tech-lead", "escalated"]]) {
  test(`verify's return count ${expected === "return" ? "starts again after a person's" : "does not restart after an agent seat's"} return (${by})`, async (t) => {
    const d = buildProject(t);
    const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
    for (const k of [2, 3, 4]) {
      run(["checkout", "-q", "-b", `proposal/build-slice-1-${k}`, "proposal/build-slice-1"]);
      run(["checkout", "-q", "main"]);
    }
    for (const [name, who, verdict] of [["build-slice-1", "runner:verify", "return"], ["build-slice-1-2", "runner:verify", "return"], ["build-slice-1-3", by, "return"]]) {
      run(["checkout", "-q", `proposal/${name}`]);
      mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
      writeFileSync(join(d, ".sdlc", "gates", `${name}.yaml`), `gate: G3\nverdict: ${verdict}\nby: ${who}\nheld_by: runner\n`);
      run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "returned"]);
      run(["checkout", "-q", "main"]);
    }
    mockSuite(t, [row("R-4.1", "fail", "Error: still wrong"), row("R-4.2", "pass")]);
    const ctx = ctxFor(d);
    verify.preChecks(d, ctx);
    assert.equal(ctx.verifyProposal, "build-slice-1-4");
    await verify.execute(d, ctx);
    const gate = parseYaml(execFileSync("git", ["show", "proposal/build-slice-1-4:.sdlc/gates/build-slice-1-4.yaml"], { cwd: d, encoding: "utf8" }));
    assert.equal(gate.verdict, expected);
  });
}

// The builder never sees the test, so a condition has to carry what the application did.
test("a return's condition says what the application did, without the runner's colour codes", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [
    row("R-4.1", "fail", "Error: \x1b[2mexpect(\x1b[22m\x1b[31mreceived\x1b[39m\x1b[2m).\x1b[22mtoBeFalsy\x1b[2m()\x1b[22m\n\nReceived: \x1b[31m\"Page not found\"\x1b[39m\n    at x"),
    row("R-4.2", "fail", "TimeoutError: locator.setChecked: Timeout 15000ms exceeded.\nCall log:\n  - waiting for getByRole('checkbox')\n    - <div class=\"checkbox\"></div> intercepts pointer events\n    - <div class=\"checkbox\"></div> intercepts pointer events"),
  ]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.deepEqual(gate.conditions, [
    "R-4.1: Error: expect(received).toBeFalsy() — Received: \"Page not found\"",
    "R-4.2: TimeoutError: locator.setChecked: Timeout 15000ms exceeded. — <div class=\"checkbox\"></div> intercepts pointer events",
  ]);
});

// With several assertions in one test, what the application did does not say which of them
// failed. The place in the test file does, and a place is not the test's code.
test("a return's condition names the place in the test the assertion failed, and the cap never cuts it off", async (t) => {
  const d = buildProject(t);
  const at = (r, line) => ({ ...r, tests: r.tests.map((x) => ({ ...x, line })) });
  mockSuite(t, [
    at(row("R-4.1", "fail", "Error: \x1b[2mexpect(\x1b[22m\x1b[31mreceived\x1b[39m\x1b[2m).\x1b[22mtoBeTruthy\x1b[2m()\x1b[22m\n\nReceived: \x1b[31m\"\"\x1b[39m"), 46),
    at(row("R-4.2", "fail", `Error: ${"the page said something long ".repeat(30)}`), 12),
  ]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.equal(gate.conditions[0], "R-4.1: Error: expect(received).toBeTruthy() — Received: \"\" — at tests/acceptance/users/R-4.1.spec.ts:46");
  assert.match(gate.conditions[1], /^R-4\.2: Error: the page said something long .*… — at tests\/acceptance\/users\/R-4\.2\.spec\.ts:12$/);
  assert.ok(gate.conditions[1].length <= "R-4.2: ".length + 400, gate.conditions[1].length);
});

// A row recorded before the line was, whose message carries the stack, is located from it.
test("a failure whose message carries the stack is located from the spec file's frame, with the path made the project's own", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "fail", `Error: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 1\n    at helper (/srv/ci/p/tests/adapters/new/index.ts:9:3)\n    at /srv/ci/p/tests/acceptance/users/R-4.1.spec.ts:30:5`)]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.equal(gate.conditions[0], "R-4.1: Error: expect(received).toBe(expected) — Expected: 2 — Received: 1 — at tests/acceptance/users/R-4.1.spec.ts:30");
});

// The real chain a fixture cannot fabricate its way around: verify writes `return` onto
// `proposal/build-slice-<n>`, `build --revise`'s own pre-check reads that return and (via
// `recordReturnOnMain`) renames the branch to `returned/build-slice-<n>` and copies the
// gate onto `main` — so the *next* proposal in the family is opened after its predecessor
// has already left `proposal/*` behind. Manually opening that next proposal branch (as
// `buildProject` above does for the first one) stands in for the real build agent's own
// commit, since no agent runs here; everything else — the return, the rename, the
// escalation count — is the pipeline's own code, exercised for real.
test("three real fail-then-revise cycles escalate only on the third verify", async (t) => {
  const d = buildProject(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  const openNextProposal = (name) => {
    run(["checkout", "-q", "-b", `proposal/${name}`]);
    writeFileSync(join(d, "app", "index.ts"), `export const revision = ${JSON.stringify(name)};\n`);
    run(["add", "-A"]);
    run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", `propose ${name}`]);
    run(["checkout", "-q", "main"]);
  };

  let proposalName = "build-slice-1";
  let last;
  for (let attempt = 1; attempt <= MAX_VERIFY_RETURNS; attempt += 1) {
    mockSuite(t, [row("R-4.1", "fail", "Error: still wrong"), row("R-4.2", "pass")]);
    const ctx = ctxFor(d);
    verify.preChecks(d, ctx);
    assert.equal(ctx.verifyProposal, proposalName, `attempt ${attempt}`);
    last = await verify.execute(d, ctx);

    if (attempt < MAX_VERIFY_RETURNS) {
      assert.match(last.text, /returned/, `attempt ${attempt}`);
      const pre = build.preChecks(d, { slice: 1, revise: true });
      assert.ok(pre.every((r) => r.ok), `attempt ${attempt}: ${JSON.stringify(pre)}`);
      proposalName = nextProposalName(d, buildProposalBase(1));
      openNextProposal(proposalName);
    }
  }
  assert.match(last.text, /escalated to tech-lead/);
  const gate = parseYaml(execFileSync("git", ["show", `proposal/${proposalName}:.sdlc/gates/${proposalName}.yaml`], { cwd: d, encoding: "utf8" }));
  assert.equal(gate.verdict, "escalated");
  assert.equal(gate.escalate_to, "tech-lead");
});

test("an unbound slice is neither returned nor passed, and names the whole sequence the binding needs", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "unbound")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.match(r.text, /bind-adapter --target new/);
  // bind-adapter refuses a target that is not answering, and the only tree the
  // application exists in is the proposal's, so the step before it has to be there and
  // has to name that branch — a reader given `bind-adapter` alone runs a command that
  // cannot work (docs/decisions/0016-binding-and-verifying-an-unmerged-proposal.md).
  assert.match(r.text, /sdlc sandbox up --target new --from proposal\/build-slice-1/);
  assert.match(r.text, /sdlc sandbox down --target new --from proposal\/build-slice-1/);
  assert.match(r.text, /rule the bind-adapter proposal/);
  assert.throws(() => onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
});

test("a failure between the write and the commit fails the run and leaves the tree dirty on the proposal branch, not main", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const mainBefore = execFileSync("git", ["rev-parse", "main"], { cwd: d, encoding: "utf8" });
  const proposalBefore = execFileSync("git", ["rev-parse", "proposal/build-slice-1"], { cwd: d, encoding: "utf8" });
  // `.git/index.lock` makes any git command that writes the index (`add`, `commit`) fail
  // while leaving read-only commands (`status`, `rev-parse`) untouched — exactly the
  // shape of the hazard this guards against: the results file has already been written
  // to the working tree by the time `commitOnBranch`'s own `git add` hits the lock and
  // throws, so the branch is left holding an untracked file with no commit to show for
  // it. Written by the sandbox's own `up` (the one hook this test can reach inside
  // `execute`'s try block) and removed by `down`, the way a real teardown would clean up
  // after itself once the run is over.
  const lock = join(d, ".git", "index.lock");
  const ctx = {
    ...ctxFor(d),
    sandbox: {
      up: async () => { writeFileSync(lock, ""); return { ok: true, baseUrl: "http://localhost:8080" }; },
      down: () => { rmSync(lock, { force: true }); return { ok: true }; },
    },
  };
  verify.preChecks(d, ctx);
  // The run fails rather than resolving: a stage that resolves with nothing changed is
  // finished as a deterministic no-op, which would commit the residue onto the proposal
  // branch and exit 0 (see the `runStage` test below).
  await assert.rejects(() => verify.execute(d, ctx), /left dirty.*proposal\/build-slice-1/s);
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d, encoding: "utf8" }).trim(), "proposal/build-slice-1");
  assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: d, encoding: "utf8" }), mainBefore);
  assert.equal(execFileSync("git", ["rev-parse", "proposal/build-slice-1"], { cwd: d, encoding: "utf8" }), proposalBefore,
    "nothing was committed onto the proposal branch");
  // The attempt is still in the run record, where a person looking for what happened
  // reads it — an attempt with no line is indistinguishable from one nobody made.
  const day = new Date().toISOString().slice(0, 10);
  assert.match(readFileSync(join(d, ".sdlc", "runs", `${day}.md`), "utf8"), /verify slice 1: the working tree was left dirty/);
});

// Every other test here calls `execute` directly, and the hazard above lives precisely in
// the gap between `execute` and `runStage`: a stage that resolves with no changed paths is
// finished by `finishDeterministicNoOp`, which commits whatever is dirty and returns ok.
// Reached with HEAD on a proposal branch and a half-written result in the tree, that
// committed the residue onto the proposal, left HEAD there and reported `run verify: ok`.
test("runStage drives verify end to end, and a mid-run failure fails the run instead of committing the residue", async (t) => {
  const sandbox = { up: async () => ({ ok: true, baseUrl: "http://localhost:8080" }), down: () => ({ ok: true }) };
  const withSandbox = (s) => ({ ...verify, execute: (dir, c) => verify.execute(dir, { ...c, sandbox: s }) });

  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  registerStage(withSandbox(sandbox));
  t.after(() => registerStage(verify));

  const ok = await runStage(d, "verify", { slice: 1 });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /slice 1 verified/);
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d, encoding: "utf8" }).trim(), "main");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: d, encoding: "utf8" }), "");

  // A second slice's proposal, verified with the commit sabotaged the same way as above.
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  writeFileSync(join(d, "plan", "tasks.md"), "### Slice 1 · Sign in\n- criteria: R-4.1, R-4.2\n\n### Slice 2 · Sign out\n- criteria: R-4.1\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "slice 2"]);
  run(["checkout", "-q", "-b", "proposal/build-slice-2"]);
  mkdirSync(join(d, ".sdlc", "proposals"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "proposals", "build-slice-2.md"), "---\ngate: G3\nquestion: \"q\"\nrecommendation: \"r\"\n---\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "propose 2"]);
  run(["checkout", "-q", "main"]);
  const proposalBefore = execFileSync("git", ["rev-parse", "proposal/build-slice-2"], { cwd: d, encoding: "utf8" });
  const mainBefore = execFileSync("git", ["rev-parse", "main"], { cwd: d, encoding: "utf8" });

  const lock = join(d, ".git", "index.lock");
  registerStage(withSandbox({
    up: async () => { writeFileSync(lock, ""); return { ok: true, baseUrl: "http://localhost:8080" }; },
    down: () => { rmSync(lock, { force: true }); return { ok: true }; },
  }));
  await assert.rejects(() => runStage(d, "verify", { slice: 2 }), /left dirty/);
  assert.equal(execFileSync("git", ["rev-parse", "proposal/build-slice-2"], { cwd: d, encoding: "utf8" }), proposalBefore,
    "the residue was not committed onto the proposal branch");
  assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: d, encoding: "utf8" }), mainBefore);
});

test("verify refuses a slice with no open build proposal, and a sandbox that will not start", async (t) => {
  const d = buildProject(t);
  const none = { ...ctxFor(d), slice: 2 };
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: d });
  assert.match(verify.preChecks(d, none).find((c) => !c.ok).messages[0], /no open build proposal for slice 2/);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const ctx = { ...ctxFor(d), sandbox: { up: async () => ({ ok: false, messages: ["the application did not answer at http://localhost:8080"] }), down: () => ({ ok: true }) } };
  verify.preChecks(d, ctx);
  // A verification that never happened must not resolve: resolving sends the runner to
  // its no-op path, which prints `run verify: ok` and exits 0 over a sandbox that never
  // came up. Nothing is recorded against the build — the cause may be the machine — but
  // the run itself fails.
  const err = await verify.execute(d, ctx).then(() => null, (e) => e);
  assert.ok(err, "a sandbox that will not start fails the run");
  assert.match(err.message, /did not answer/);
  assert.match(err.message, /nothing was verified/);
  assert.throws(() => onBranch(d, "tests/results/new/slice-1.json"));
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d, encoding: "utf8" }).trim(), "main");
});

// `new` signs in through the sandbox's identity provider. Without the password every test
// in the slice fails at the sign-in form, verify reads that as the application's fault and
// returns the slice to a builder that cannot fix an environment defect — three wasted
// build runs and an escalation for something the runner is meant to halt on and report
// (spec 7.1). `calibrate` and `bind-adapter` check the same thing before they start.
test("verify refuses to verify a sandbox-idp target with no password in the environment", async (t) => {
  const d = buildProject(t);
  const prev = process.env.SDLC_SANDBOX_PASSWORD;
  delete process.env.SDLC_SANDBOX_PASSWORD;
  try {
    const failed = verify.preChecks(d, ctxFor(d)).filter((c) => !c.ok);
    assert.equal(failed.length, 1);
    assert.deepEqual(failed[0].messages, ["export SDLC_SANDBOX_PASSWORD before verifying new"]);
    // The message names the variable and nothing else: no value is read, printed or stored.
    assert.ok(!failed[0].messages.join(" ").includes("set-for-tests"));
  } finally {
    process.env.SDLC_SANDBOX_PASSWORD = prev;
  }
});

// Teardown is the first thing the `finally` does, and it used to be able to throw its way
// past the rest of it — leaving HEAD on the proposal branch with no run-record line and
// the real failure replaced by the sandbox's.
test("a sandbox that will not stop is reported without hiding what the run was already doing", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const ctx = {
    ...ctxFor(d),
    sandbox: {
      up: async () => ({ ok: true, baseUrl: "http://localhost:8080" }),
      down: () => { throw new Error("docker compose down failed"); },
    },
  };
  verify.preChecks(d, ctx);
  await assert.rejects(() => verify.execute(d, ctx), /docker compose down failed/);
  // The result still landed, HEAD still came home, and the attempt is still recorded.
  assert.equal(JSON.parse(onBranch(d, "tests/results/new/slice-1.json")).verdict, "pass");
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d, encoding: "utf8" }).trim(), "main");
  const day = new Date().toISOString().slice(0, 10);
  assert.match(readFileSync(join(d, ".sdlc", "runs", `${day}.md`), "utf8"), /slice 1 verified/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: d, encoding: "utf8" }), "",
    "the record of a failed attempt is committed rather than left to block the next run");
});

// `main` moves while a build proposal is open — a ruled adapter is the case that matters,
// since `bind-adapter` can only run once the slice's application is up, which is after the
// proposal exists (docs/decisions/0016-binding-and-verifying-an-unmerged-proposal.md). The branch has
// to carry what was ruled, or the suite runs against a test rig the project no longer has.
function commitOnMain(d, path, body) {
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["checkout", "-q", "main"]);
  mkdirSync(join(d, path, ".."), { recursive: true });
  writeFileSync(join(d, path), body);
  run(["add", "-A"]);
  run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", `main: ${path}`]);
}

test("verify brings main into the proposal branch before it runs the suite", async (t) => {
  const d = buildProject(t);
  commitOnMain(d, "tests/adapters/new/index.ts", "export default function create() { return {}; }\n");
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  // The adapter ruled onto main after the branch was cut is now on the branch, which is
  // the tree the suite ran against and the tree a reviewer will read.
  assert.match(onBranch(d, "tests/adapters/new/index.ts"), /export default function create/);
  assert.equal(execFileSync("git", ["merge-base", "--is-ancestor", "main", "proposal/build-slice-1"], { cwd: d }).toString(), "");
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d, encoding: "utf8" }).trim(), "main");
});

test("a proposal that no longer merges with main is reported as that, not as a failing slice", async (t) => {
  const d = buildProject(t);
  // The same path written differently on both sides: the slice's own application file.
  commitOnMain(d, "app/index.ts", "export const fromAnotherSlice = true;\n");
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const branchBefore = execFileSync("git", ["rev-parse", "proposal/build-slice-1"], { cwd: d, encoding: "utf8" });
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const err = await verify.execute(d, ctx).then(() => null, (e) => e);
  assert.ok(err, "a branch that cannot be merged fails the run");
  assert.match(err.message, /no longer merges with main/);
  assert.match(err.message, /app\/index\.ts/);
  // Nothing half-merged, nothing written: the branch is exactly as it was, no gate file
  // returns the slice to the builder, and the caller is back on main.
  assert.equal(existsSync(join(d, ".git", "MERGE_HEAD")), false);
  assert.equal(execFileSync("git", ["rev-parse", "proposal/build-slice-1"], { cwd: d, encoding: "utf8" }), branchBefore);
  assert.throws(() => onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d, encoding: "utf8" }).trim(), "main");
});

// A stale proposal and a merge git simply declined need different remedies. Reporting the
// second as the first sends a person to rebuild a slice that has nothing wrong with it, and
// throws away the one line that would have said so.
test("verify tells a conflicted merge apart from a merge that failed for another reason", () => {
  const stale = mergeFailureText(1, "proposal/build-slice-1", {
    ok: false, conflicts: ["app/index.ts", "app/other.ts"], message: "CONFLICT (content): ...",
  });
  assert.match(stale, /no longer merges with main/);
  assert.match(stale, /app\/index\.ts/);
  assert.match(stale, /rebuild the slice on top of main/);

  const declined = mergeFailureText(1, "proposal/build-slice-1", {
    ok: false, conflicts: [], message: "fatal: not something we can merge",
  });
  assert.match(declined, /could not be merged/);
  assert.match(declined, /not a stale proposal/);
  assert.match(declined, /fatal: not something we can merge/, "git's own reason is carried");
  assert.ok(!/rebuild the slice/.test(declined), "the wrong remedy is not prescribed");
});

// A sandbox that will not start has two causes and they need opposite answers. A container
// that came up and died on a file this build wrote is the build's defect, and there is no
// acceptance criterion that can say so: the suite cannot fail on it, verify cannot pass,
// the reviewer's ruling is refused without a pass, and `build --revise` needs a returned
// ruling to start from. Without this path nothing in the pipeline can move
// (docs/decisions/0017-a-sandbox-that-is-not-up.md).
const crashLoop = () => ({
  ok: false,
  cause: "application",
  messages: ["the sandbox is not up: a service of this project is not running"],
  failures: [{
    service: "sandbox-idp", ran: true, state: "restarting",
    reason: "is restarting, so it starts, dies and starts again",
    log: "ERROR: Failed to run import\nERROR: Unrecognized field \"_comment\" (class RealmRepresentation), not marked as ignorable",
  }],
});

const sandboxThat = (up) => ({ up: async () => up, down: () => ({ ok: true }) });

test("a sandbox the application brought down returns the build, with the failed service as the condition", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const ctx = { ...ctxFor(d), sandbox: sandboxThat(crashLoop()) };
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.match(r.text, /returned/);
  assert.match(r.text, /build --slice 1 --revise/);

  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.equal(gate.verdict, "return");
  assert.equal(gate.by, "runner:verify", "verify's own return, so the ceiling counts it");
  assert.equal(gate.held_by, "runner");
  assert.match(gate.conditions.join("\n"), /sandbox sandbox-idp: is restarting/);
  assert.match(gate.conditions.join("\n"), /Unrecognized field/, "the builder is told what the service it wrote actually said");
  // No suite ran, so no row claims one did — and the file is still written, because it is
  // what `rule.mjs` reads to decide whether this proposal may be ruled at all.
  const result = JSON.parse(onBranch(d, "tests/results/new/slice-1.json"));
  assert.equal(result.verdict, "fail");
  assert.deepEqual(result.rows, []);
  assert.match(result.not_verified, /the sandbox did not start/);
  // The whole point: the builder can now be told.
  const pre = build.preChecks(d, { slice: 1, revise: true });
  assert.ok(pre.every((c) => c.ok), JSON.stringify(pre));
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d, encoding: "utf8" }).trim(), "main");
});

test("a sandbox the machine brought down halts the run and records nothing against the build", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const ctx = {
    ...ctxFor(d),
    sandbox: sandboxThat({ ok: false, cause: "environment", failures: [], messages: ["docker compose up failed:\nfailed to bind host port: address already in use"] }),
  };
  verify.preChecks(d, ctx);
  const err = await verify.execute(d, ctx).then(() => null, (e) => e);
  assert.ok(err, "a port already taken is not a verdict about the application");
  assert.match(err.message, /nothing was verified/);
  assert.match(err.message, /address already in use/);
  assert.throws(() => onBranch(d, ".sdlc/gates/build-slice-1.yaml"), "no ruling is written, so no build attempt is spent");
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d, encoding: "utf8" }).trim(), "main");
});

// A result that says nothing about whose fault it is is treated as the machine's: halting
// costs a re-run, and returning a build wrongly costs one of the three attempts the slice
// has before a person is asked.
test("a sandbox failure that names no cause halts rather than guessing at the builder's expense", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const ctx = { ...ctxFor(d), sandbox: sandboxThat({ ok: false, messages: ["the sandbox did not come up"] }) };
  verify.preChecks(d, ctx);
  await assert.rejects(() => verify.execute(d, ctx), /nothing was verified/);
  assert.throws(() => onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
});

// The ceiling exists to stop an unbounded rebuild loop, and a slice whose application has
// not started three times running is the strongest case there is for a person to look at
// it: what is wrong may be the compose file, the stack profile or the machine, and a
// fourth build would not find out which.
test("a third sandbox return escalates rather than asking for a fourth build", async (t) => {
  const d = buildProject(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  for (const k of [2, 3]) {
    run(["checkout", "-q", "-b", `proposal/build-slice-1-${k}`, "proposal/build-slice-1"]);
    run(["checkout", "-q", "main"]);
  }
  // Both earlier attempts were returned for the same reason this one is about to be: the
  // sandbox never came up. Nothing distinguishes a sandbox return from a criteria return
  // in the count — `by: runner:verify` is what is read — and this is the case where all
  // three are the sandbox's.
  for (const name of ["build-slice-1", "build-slice-1-2"]) {
    run(["checkout", "-q", `proposal/${name}`]);
    mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
    writeFileSync(join(d, ".sdlc", "gates", `${name}.yaml`),
      "gate: G3\nverdict: return\nby: runner:verify\nheld_by: runner\nconditions:\n  - \"sandbox sandbox-idp: is restarting, so it starts, dies and starts again.\"\n");
    run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "returned"]);
    run(["checkout", "-q", "main"]);
  }
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const ctx = { ...ctxFor(d), sandbox: sandboxThat(crashLoop()) };
  verify.preChecks(d, ctx);
  assert.equal(ctx.verifyProposal, "build-slice-1-3");
  const r = await verify.execute(d, ctx);
  const gate = parseYaml(execFileSync("git", ["show", "proposal/build-slice-1-3:.sdlc/gates/build-slice-1-3.yaml"], { cwd: d, encoding: "utf8" }));
  assert.equal(gate.verdict, "escalated");
  assert.equal(gate.escalate_to, "tech-lead");
  assert.match(r.text, /escalated to tech-lead/);
});

// `buildVerified` judges an earlier verify result current by the application tree, and a
// commit that writes only a gate file does not change `HEAD:app`. So a `pass` recorded
// before the sandbox broke stays current unless this run overwrites it — and the proposal
// this run just returned would still be rulable as approved.
test("a sandbox return overwrites the pass an earlier verify left on the same application tree", async (t) => {
  const d = buildProject(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  const appTree = execFileSync("git", ["rev-parse", "proposal/build-slice-1:app"], { cwd: d, encoding: "utf8" }).trim();
  run(["checkout", "-q", "proposal/build-slice-1"]);
  mkdirSync(join(d, "tests", "results", "new"), { recursive: true });
  writeFileSync(join(d, "tests", "results", "new", "slice-1.json"), `${JSON.stringify({
    slice: 1, proposal: "build-slice-1", app_tree: appTree, at: "2026-09-19T00:00:00.000Z", verdict: "pass",
    rows: [{ id: "R-4.1", result: "pass" }, { id: "R-4.2", result: "pass" }],
  }, null, 2)}\n`);
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "an earlier verify"]);
  run(["checkout", "-q", "main"]);
  // The application is untouched, so the stale result is still current by `app_tree`.
  run(["checkout", "-q", "proposal/build-slice-1"]);
  assert.equal(buildVerified(d, "build-slice-1").ok, true, "the fixture really does leave a standing pass");
  run(["checkout", "-q", "main"]);

  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const ctx = { ...ctxFor(d), sandbox: sandboxThat(crashLoop()) };
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);

  run(["checkout", "-q", "proposal/build-slice-1"]);
  const verified = buildVerified(d, "build-slice-1");
  assert.equal(verified.ok, false, "a returned build proposal is not rulable as approved");
  assert.match(verified.reason, /did not pass verify/);
  run(["checkout", "-q", "main"]);
});

// A run that did not pass must not read as one that did. `verify` records its verdict
// correctly and then resolves, which sends it through `finishDeterministicNoOp` and out
// of `COMMANDS.run` as `run verify: ok`, exit 0 — over a slice whose criteria failed, or
// were never exercised at all. That trailer and that exit code are what a script, a CI
// step and a person scanning the last line all read
// (docs/decisions/0019-a-run-that-did-not-pass-says-so.md).
test("only a passing slice leaves verify with nothing to report instead of ok", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  assert.equal((await verify.execute(d, ctx)).notPassed, undefined);
});

test("a returned, an escalated and an unbound verify each say what happened instead of ok", async (t) => {
  const failing = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "fail", "Error: expected heading")]);
  const fctx = ctxFor(failing);
  verify.preChecks(failing, fctx);
  const returned = await verify.execute(failing, fctx);
  assert.match(returned.notPassed, /^returned — 1 of 2 criteria fail against the application$/,
    "a criterion that was exercised and came out wrong");

  const unbound = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "unbound", "Error: unbound: x.y — nothing there")]);
  const uctx = ctxFor(unbound);
  verify.preChecks(unbound, uctx);
  const u = await verify.execute(unbound, uctx);
  assert.match(u.notPassed, /^unbound — 1 of 2 criteria could not be exercised at all$/,
    "a criterion that could not be exercised reads differently from one that failed");
});

test("the third failing verify reports the escalation rather than ok", async (t) => {
  const d = buildProject(t, { escalateTo: "principal" });
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  for (const k of [2, 3]) {
    run(["checkout", "-q", "-b", `proposal/build-slice-1-${k}`, "proposal/build-slice-1"]);
    run(["checkout", "-q", "main"]);
  }
  for (const name of ["build-slice-1", "build-slice-1-2"]) {
    run(["checkout", "-q", `proposal/${name}`]);
    mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
    writeFileSync(join(d, ".sdlc", "gates", `${name}.yaml`), "gate: G3\nverdict: return\nby: runner:verify\nheld_by: runner\n");
    run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "returned"]);
    run(["checkout", "-q", "main"]);
  }
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "fail", "Error: still wrong")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.match(r.notPassed, /^escalated to principal — 1 of 2 criteria still fail after 3 builds$/);
});

test("sdlc run verify prints the verdict instead of ok and exits non-zero when it did not pass", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "unbound", "Error: unbound: x.y — nothing there")]);
  const sandbox = { up: async () => ({ ok: true, baseUrl: "http://localhost:8080" }), down: () => ({ ok: true }) };
  registerStage({ ...verify, execute: (dir, c) => verify.execute(dir, { ...c, sandbox }) });
  t.after(() => registerStage(verify));

  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  const origCwd = process.cwd();
  try {
    process.chdir(d);
    console.log = (...a) => logs.push(a.join(" "));
    console.error = (...a) => errs.push(a.join(" "));
    const code = await COMMANDS.run({ pos: ["verify"], flags: { slice: 1 } });
    assert.equal(code, 1, "an unbound verdict is not a successful run");
  } finally {
    console.log = origLog; console.error = origErr; process.chdir(origCwd);
  }
  assert.ok(!logs.some((l) => /^run verify: ok/.test(l)), logs.join(" | "));
  assert.ok(errs.some((l) => /^run verify: unbound — 1 of 2 criteria could not be exercised at all$/.test(l)), errs.join(" | "));
});

test("sdlc run verify still reports ok and exits 0 on a slice that passes", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const sandbox = { up: async () => ({ ok: true, baseUrl: "http://localhost:8080" }), down: () => ({ ok: true }) };
  registerStage({ ...verify, execute: (dir, c) => verify.execute(dir, { ...c, sandbox }) });
  t.after(() => registerStage(verify));

  const logs = [];
  const origLog = console.log;
  const origCwd = process.cwd();
  try {
    process.chdir(d);
    console.log = (...a) => logs.push(a.join(" "));
    assert.equal(await COMMANDS.run({ pos: ["verify"], flags: { slice: 1 } }), 0);
  } finally {
    console.log = origLog; process.chdir(origCwd);
  }
  assert.ok(logs.some((l) => /^run verify: ok/.test(l)), logs.join(" | "));
});

// An unbound verdict has two causes that call for opposite remedies, and the five-step
// bind sequence is the right answer to only one of them. Once the binding has been sent
// for a row as often as policy.loops.rebind allows, printing it again asks for half an hour
// of sandbox, adapter and ruling that drives the same application again and writes the
// same reasons back.
test("an unbound slice whose binding has been sent its limit is not told to bind again", async (t) => {
  const d = buildProject(t);
  spendBinding(d, "R-4.2", commitAdapter(d));
  mockSuite(t, [
    row("R-4.1", "pass"),
    row("R-4.2", "unbound", "Error: unbound: opportunities.withdraw — no control on the page withdraws a published opportunity\n    at Object.withdraw"),
  ]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.ok(!/sdlc run bind-adapter/.test(r.text), `the bind sequence is not the remedy here:\n${r.text}`);
  assert.ok(!/sandbox up --target new --from/.test(r.text), r.text);
  // The adapter's own reason is the evidence for what is missing, and nothing else in the
  // pipeline writes it down.
  assert.match(r.text, /R-4\.2: opportunities\.withdraw — no control on the page withdraws a published opportunity/);
  assert.match(r.text, /plan\/tasks\.md/, "changing what the slice claims is one of the two moves open");
  assert.match(r.text, /build --slice 1 --revise/, "taking the surface on is the other");
});

// The slice's first build lacked the screen, the binding's sends were spent against it, and
// the builder has since built the screen. The adapter still throws the reason it recorded then,
// and only a binding run against this build can replace it, so the row is owed again
// (`docs/decisions/0083`).
test("an unbound row whose binding was spent against an earlier build is owed again against this one", async (t) => {
  const d = buildProject(t);
  spendBinding(d, "R-4.2", commitAdapter(d), "0123456789abcdef0123456789abcdef01234567");
  const appTree = execFileSync("git", ["rev-parse", "proposal/build-slice-1:app"], { cwd: d, encoding: "utf8" }).trim();
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "unbound", "Error: unbound: a.b — Page not found")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  const open = parseYaml(readFileSync(join(d, "tests", "adapters", "rebind.yaml"), "utf8")).rebind.filter((e) => !e.closed);
  assert.deepEqual(open.map((e) => [e.id, e.app_tree, e.slice]), [["R-4.2", appTree, 1]], "filed against the application this verify measured");
  assert.match(r.text, /sdlc run bind-adapter --target new/);
  assert.match(r.notPassed, /owed to bind-adapter --target new$/);
});

test("an unbound row whose binding was spent against this build is still not sent again", async (t) => {
  const d = buildProject(t);
  const appTree = execFileSync("git", ["rev-parse", "proposal/build-slice-1:app"], { cwd: d, encoding: "utf8" }).trim();
  spendBinding(d, "R-4.2", commitAdapter(d), appTree);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "unbound", "Error: unbound: a.b — gone")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.deepEqual(parseYaml(readFileSync(join(d, "tests", "adapters", "rebind.yaml"), "utf8")).rebind.filter((e) => !e.closed), []);
  assert.ok(!/sdlc run bind-adapter/.test(r.text), r.text);
  assert.match(r.text, /as often as policy\.loops\.rebind allows against this build of the application/);
});

// The third cause an unbound verdict can have, and the one the other two exits cannot
// express: the criterion is right, and the acceptance test derived from it reaches past
// what it asks for. The adapter then reports the application as lacking a surface nobody
// ever put in the contract — an accurate message naming the wrong culprit — and neither
// rebuilding nor re-scoping the slice is the remedy.
test("an unbound slice is offered the exit for a test that reaches past its criterion", async (t) => {
  const d = buildProject(t);
  spendBinding(d, "R-4.2", commitAdapter(d));
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "unbound", "Error: unbound: a.b — no control on the page does this")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.match(r.text, /test-overreaches <ID>: /, `the third exit is named:\n${r.text}`);
  assert.match(r.text, /derive-tests --domain .* --stale/);
  assert.match(r.text, /stays unverified/, "and it is said plainly that this verifies nothing");
});

// The second cause, which until the condition form existed was an instruction to go and
// hand-edit an artifact its own gate had already approved: the slice claims more than it
// builds, and the plan is what says so.
test("an unbound slice is offered the exit that reaches the plan", async (t) => {
  const d = buildProject(t);
  spendBinding(d, "R-4.2", commitAdapter(d));
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "unbound", "Error: unbound: a.b — no control on the page does this")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.match(r.text, /addressed-to <stage>: /, `the plan exit is named:\n${r.text}`);
  assert.match(r.text, /the stage is plan/, "with the stage to address it to");
  assert.match(r.text, /plan --revise/, "and the run that takes it up");
  assert.match(r.text, /request itself changes nothing/, "and it is said plainly that this changes nothing");
});

test("an unbound slice with no adapter at all still gets the whole binding sequence", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "unbound", "Error: unbound: tests/adapters/new/index.ts does not exist")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.match(r.text, /tests\/adapters\/new\/index\.ts does not exist/);
  assert.match(r.text, /sdlc sandbox up --target new --from proposal\/build-slice-1/);
  assert.match(r.text, /sdlc run bind-adapter --target new/);
});

test("an unbound row whose adapter gave no readable reason is still reported as unbound", () => {
  assert.deepEqual(
    unboundReasons([{ id: "R-1", tests: [{ error: "Error: unbound: a.b — gone" }] }, { id: "R-2", tests: [] }], ["R-1", "R-2"]),
    [{ id: "R-1", reason: "a.b — gone" }, { id: "R-2", reason: "the adapter gave no reason" }]);
});

// The result file carries each acceptance test's own error, which is a browser's or a
// runner's stack trace and names the file it was thrown from; the gate file carries a
// service's own log or that same error, quoted so the builder has the evidence. Both are
// committed to the proposal branch (rule E-2,
// docs/decisions/0020-a-published-page-is-scrubbed-where-it-is-written.md). The home path
// below is assembled from pieces so this file does not itself carry the shape the egress
// check looks for.
test("neither the result file nor the gate file verify writes names this machine", async (t) => {
  const d = buildProject(t);
  const elsewhere = `/${"home"}/someone/tools`;
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "fail", `Error: expected heading\n    at ${elsewhere}/node_modules/playwright/index.js:1:1\n    at ${d}/tests/acceptance/users/R-4.2.spec.ts:3:1`)]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  for (const path of ["tests/results/new/slice-1.json", ".sdlc/gates/build-slice-1.yaml"]) {
    const text = onBranch(d, path);
    assert.ok(!text.includes(elsewhere), `${path} still names a person's home directory`);
    assert.ok(!text.includes(d), `${path} still carries the project's absolute path`);
  }
  assert.match(onBranch(d, "tests/results/new/slice-1.json"), /~\/tools\/node_modules\/playwright/);
});

// ── what the builder is not answerable for ──────────────────────────────────────────────

const MAIL_UNSET = "Error: SDLC_MAIL_API is not set; a test that uses the `mail` fixture needs a mail catcher target";

function withMailApi(d, url = "http://localhost:8025") {
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  const p = join(d, ".sdlc", "config.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("identity: sandbox-idp }", `identity: sandbox-idp, mail_api: "${url}" }`));
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "mail"]);
}

// The suite is handed the target's mail catcher the way calibrate hands it the oracle's: every
// test that reads a message the application sent reads it there.
test("verify hands the suite the new target's mail catcher", async (t) => {
  const d = buildProject(t);
  withMailApi(d);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const ctx = ctxFor(d);
  let seen;
  ctx.runSuite = (opts) => { seen = opts; return runSuite(opts); };
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  assert.equal(seen.mailApi, "http://localhost:8025");
});

// A target that declares no mail catcher cannot run a test that reads one. The harness says
// so in its own words, and the builder can do nothing about a line in .sdlc/config.yaml.
test("a test stopped for want of a mail catcher is an environment gap, not a return", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "fail", MAIL_UNSET)]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.ok(!existsSync(join(d, ".sdlc", "gates", "build-slice-1.yaml")));
  assert.throws(() => onBranch(d, ".sdlc/gates/build-slice-1.yaml"), "nothing is recorded against the build");
  const result = JSON.parse(onBranch(d, "tests/results/new/slice-1.json"));
  assert.equal(result.verdict, "environment");
  assert.deepEqual(result.environment.map((e) => e.id), ["R-4.2"]);
  assert.match(result.environment[0].reason, /mail catcher/);
  assert.match(r.notPassed, /^not verified — 1 of 2 criteria could not be tested in this environment$/);
  assert.match(r.text, /targets\.new\.mail_api/);
  assert.doesNotMatch(r.text, /build --slice 1 --revise/);
  assert.equal(buildVerified(d, "build-slice-1").ok, false, "an environment gap is not a pass either");
});

test("a real failure beside an environment gap is returned alone", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "fail", "Error: expected heading \"Sign in\""), row("R-4.2", "fail", MAIL_UNSET)]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.equal(gate.verdict, "return");
  assert.deepEqual(gate.conditions, ["R-4.1: Error: expected heading \"Sign in\""]);
  assert.match(r.notPassed, /^returned — 1 of 2 criteria fail against the application$/);
  assert.match(r.text, /R-4\.2/, "the gap is still named, apart from the failure");
});

// A slice returned three times because its target had no mail catcher has not failed three
// builds; those returns say nothing about the application and do not bring it closer to a
// person.
test("an earlier return whose every condition was an environment gap does not count toward escalation", async (t) => {
  const d = buildProject(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  for (const k of [2, 3]) {
    run(["checkout", "-q", "-b", `proposal/build-slice-1-${k}`, "proposal/build-slice-1"]);
    run(["checkout", "-q", "main"]);
  }
  for (const name of ["build-slice-1", "build-slice-1-2"]) {
    run(["checkout", "-q", `proposal/${name}`]);
    mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
    writeFileSync(join(d, ".sdlc", "gates", `${name}.yaml`), `gate: G3\nverdict: return\nby: runner:verify\nheld_by: runner\nconditions:\n  - "R-4.2: ${MAIL_UNSET.replace(/`/g, "`")}"\n`);
    run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "returned"]);
    run(["checkout", "-q", "main"]);
  }
  mockSuite(t, [row("R-4.1", "fail", "Error: still wrong"), row("R-4.2", "pass")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  const gate = parseYaml(execFileSync("git", ["show", "proposal/build-slice-1-3:.sdlc/gates/build-slice-1-3.yaml"], { cwd: d, encoding: "utf8" }));
  assert.equal(gate.verdict, "return", "the first failure the builder is answerable for is the first strike");
});

// A test written for a configuration the target reads at start-up runs only against an
// instance started in it (0071), and verify has no way to start the sandbox in one.
test("a test written for a configuration is left out of the run and reported as an environment gap", async (t) => {
  const d = buildProject(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  mkdirSync(join(d, "spec", "contract"), { recursive: true });
  writeFileSync(join(d, "spec", "contract", "observables.yaml"), "configurations:\n  quiet:\n    select: QUIET=1\n    tag: \"@quiet\"\n");
  writeFileSync(join(d, "tests", "acceptance", "users", "R-4.2.spec.ts"), "test(\"x\", { tag: \"@quiet\" }, async () => {});\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "configuration"]);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "fail", "Error: a message was sent")]);
  const ctx = ctxFor(d);
  let seen;
  ctx.runSuite = (opts) => { seen = opts; return runSuite(opts); };
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.deepEqual(seen.grepInvert, ["@quiet"]);
  assert.throws(() => onBranch(d, ".sdlc/gates/build-slice-1.yaml"), "nothing is recorded against the build");
  const result = JSON.parse(onBranch(d, "tests/results/new/slice-1.json"));
  assert.equal(result.verdict, "environment");
  assert.deepEqual(result.environment.map((e) => e.id), ["R-4.2"]);
  assert.match(result.environment[0].reason, /configuration quiet/);
  assert.match(r.text, /cannot start the new target in a configuration/);
});

// ── an unbound row is the adapter's ──────────────────────────────────────────────────────

// An adapter bound before the application it drives existed names whatever it found then. A
// row it reports unbound is the binding's gap, and a binding run against the application on
// this branch is what can close it: the row is owed to bind-adapter --target new, filed on
// main where `next` and the binding run read owed work, and the slice is verified again once
// the binding is ruled.
test("an unbound row on the new target is owed to bind-adapter, filed on main, and the build is not returned", async (t) => {
  const d = buildProject(t);
  const adapter = commitAdapter(d);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "unbound", "Error: unbound: signIn.applicant — the sign-in screen offers no \"Applicant\" link")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d, encoding: "utf8" }).trim(), "main");
  assert.throws(() => onBranch(d, ".sdlc/gates/build-slice-1.yaml"), "nothing is recorded against the build");
  const owed = parseYaml(readFileSync(join(d, "tests", "adapters", "rebind.yaml"), "utf8")).rebind;
  assert.equal(owed.length, 1);
  assert.deepEqual([owed[0].id, owed[0].target, owed[0].found, owed[0].adapter, owed[0].slice, owed[0].by],
    ["R-4.2", "new", "unbound", adapter, 1, "runner:verify"]);
  assert.match(owed[0].why, /signIn\.applicant/);
  assert.match(r.notPassed, /^unbound — 1 of 2 criteria could not be exercised at all; owed to bind-adapter --target new$/);
  assert.match(r.text, /sdlc sandbox up --target new --from proposal\/build-slice-1/);
  assert.match(r.text, /sdlc run bind-adapter --target new/);
  assert.match(r.text, /sdlc run verify --slice 1/);
  assert.doesNotMatch(r.text, /build --slice 1 --revise/);
});

test("unbound rows beside a real failure are still owed to bind-adapter, and are not conditions of the return", async (t) => {
  const d = buildProject(t);
  commitAdapter(d);
  mockSuite(t, [row("R-4.1", "fail", "Error: expected heading"), row("R-4.2", "unbound", "Error: unbound: a.b — gone")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.deepEqual(gate.conditions, ["R-4.1: Error: expected heading"]);
  assert.deepEqual(parseYaml(readFileSync(join(d, "tests", "adapters", "rebind.yaml"), "utf8")).rebind.map((e) => e.id), ["R-4.2"]);
  assert.match(r.text, /owed to bind-adapter --target new.*R-4\.2: a\.b — gone/s);
});

test("the next verify of the slice closes what the binding answered", async (t) => {
  const d = buildProject(t);
  commitAdapter(d);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "unbound", "Error: unbound: a.b — gone")]);
  let ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  // The owed entry reaches main with the run, and a binding run is ruled onto main.
  writeFileSync(join(d, "tests", "adapters", "new", "index.ts"), "export const surface = { bound: true };\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "rebound"]);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.match(r.text, /verified/);
  const [e] = parseYaml(readFileSync(join(d, "tests", "adapters", "rebind.yaml"), "utf8")).rebind;
  assert.equal(e.closed.outcome, "met");
});

// A build ruler reads the verdict's meaning off the evidence section, and an environment gap
// has to read as what it is: nothing established, and nothing the build did.
test("the ruler is told what an environment verdict means and which criteria it covers", async () => {
  const { formatVerifyEvidence } = await import("../src/runner/verify-evidence.mjs");
  const text = formatVerifyEvidence({ slice: 1, result: {
    verdict: "environment", proposal: "build-slice-1", app_tree: "abcdef0",
    environment: [{ id: "R-4.2", reason: "its test reads a mail catcher, and targets.new.mail_api names none for this target to hand it" }],
    rows: [row("R-4.1", "pass"), row("R-4.2", "fail", MAIL_UNSET)],
  } });
  assert.match(text, /Verdict: \*\*environment\*\* — .*could not be tested in this environment/);
  assert.match(text, /R-4\.2 — not tested in this environment: its test reads a mail catcher/);
});

// ---- what earlier, approved slices established is checked again ----

// An approved slice left its verify result on main. The criteria that passed there are run again
// with every later slice, because a later build can break them and its own criteria would never
// say so. One that passed then and fails now returns this build; one that never passed is owed
// where it already is and is not this build's to answer.
function withEarlierSlice(d, rows) {
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["checkout", "-q", "main"]);
  mkdirSync(join(d, "tests", "results", "new"), { recursive: true });
  writeFileSync(join(d, "tests", "results", "new", "slice-5.json"), JSON.stringify({ slice: 5, proposal: "build-slice-5-2", verdict: "pass", rows }));
  for (const r of rows) writeFileSync(join(d, "tests", "acceptance", "users", `${r.id}.spec.ts`), "");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "slice 5 approved"]);
}

const suiteOf = (rows, calls) => (opts) => { calls.push(opts.files); return { rows }; };

test("a criterion an approved slice passed is run again, and its failure now returns this build", async (t) => {
  const d = buildProject(t);
  withEarlierSlice(d, [row("R-3.1", "pass"), row("R-3.2", "fail", "Error: never passed")]);
  const calls = [];
  const ctx = { ...ctxFor(d), runSuite: suiteOf([row("R-4.1", "pass"), row("R-4.2", "pass"), row("R-3.1", "fail", "Error: expected heading \"Opportunities\""), row("R-3.2", "fail", "Error: never passed")], calls) };
  assert.ok(verify.preChecks(d, ctx).every((c) => c.ok));
  const r = await verify.execute(d, ctx);

  assert.ok(!calls[0].includes("tests/acceptance/users/R-3.1.spec.ts"), "the slice's own tests run first, on their own");
  assert.ok(calls[1].includes("tests/acceptance/users/R-3.1.spec.ts"), "then, its own passing, the earlier slice's passing criterion");
  assert.ok(!calls[1].includes("tests/acceptance/users/R-3.2.spec.ts"), "one it never passed is not");
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.equal(gate.verdict, "return");
  assert.equal(gate.conditions.length, 1);
  assert.match(gate.conditions[0], /^R-3\.1 \(passed when slice 5 was approved\): Error: expected heading "Opportunities"/);
  assert.match(r.notPassed, /1 criterion an earlier slice passed now fails/);
  const result = JSON.parse(onBranch(d, "tests/results/new/slice-1.json"));
  assert.equal(result.verdict, "fail");
  assert.deepEqual(result.regressed.map((x) => [x.id, x.slice]), [["R-3.1", 5]]);
  assert.deepEqual(result.rows.map((x) => x.id).sort(), ["R-4.1", "R-4.2"], "the slice's own rows stay its own");
});

test("earlier criteria that still pass leave the slice's own verdict as it was, and the result says they were checked", async (t) => {
  const d = buildProject(t);
  withEarlierSlice(d, [row("R-3.1", "pass")]);
  const ctx = { ...ctxFor(d), runSuite: suiteOf([row("R-4.1", "pass"), row("R-4.2", "pass"), row("R-3.1", "pass")], []) };
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.match(r.text, /slice 1 verified/);
  assert.match(r.text, /1 criterion earlier slices passed still passes/);
  const result = JSON.parse(onBranch(d, "tests/results/new/slice-1.json"));
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.rechecked, ["R-3.1"]);
});

// What the build cannot change is not charged to it: an earlier criterion this environment could
// not exercise, or one the adapter can no longer drive, is reported and left where it lies.
test("an earlier criterion that cannot be exercised now is reported, not charged to the build", async (t) => {
  const d = buildProject(t);
  withEarlierSlice(d, [row("R-3.1", "pass"), row("R-3.3", "pass")]);
  const ctx = { ...ctxFor(d), runSuite: suiteOf([row("R-4.1", "pass"), row("R-4.2", "pass"), row("R-3.1", "unbound"), row("R-3.3", "fail", MAIL_UNSET)], []) };
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.match(r.text, /slice 1 verified/);
  assert.match(r.text, /R-3\.1/);
  assert.equal(JSON.parse(onBranch(d, "tests/results/new/slice-1.json")).verdict, "pass");
});

test("a criterion this slice claims is judged as its own, never as an earlier slice's", async (t) => {
  const d = buildProject(t);
  withEarlierSlice(d, [row("R-4.1", "pass")]);
  const calls = [];
  const ctx = { ...ctxFor(d), runSuite: suiteOf([row("R-4.1", "fail", "Error: x"), row("R-4.2", "pass")], calls) };
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.deepEqual(gate.conditions, ["R-4.1: Error: x"]);
  assert.equal(calls[0].filter((f) => f.endsWith("R-4.1.spec.ts")).length, 1, "its test runs once");
});

// A criterion's test file can hold several cases, each failing at the same assertion line. The
// builder never sees the test, so the condition names the case that failed: the behaviour it
// asserts, as its title says, which is what the builder has to find in the application.
test("a condition from a file of several cases names the case that failed", async (t) => {
  const d = buildProject(t);
  const statement = "An opportunity that is not a draft must state whether remote work is acceptable";
  mockSuite(t, [
    { id: "R-4.1", result: "fail", file: "tests/acceptance/users/R-4.1.spec.ts", tests: [
      { title: `${statement} (one that accepts remote work with no remote-work description is refused)`, status: "passed" },
      { title: `${statement} (one that does not say whether remote work is acceptable is refused)`, status: "failed", error: "Error: expect(received).not.toContain(expected)", line: 54 },
    ] },
    { id: "R-4.2", result: "fail", file: "tests/acceptance/users/R-4.2.spec.ts", tests: [{ title: "A single case", status: "failed", error: "Error: x", line: 3 }] },
  ]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.equal(gate.conditions[0], "R-4.1, in the case \"one that does not say whether remote work is acceptable is refused\": Error: expect(received).not.toContain(expected) — at tests/acceptance/users/R-4.1.spec.ts:54");
  assert.equal(gate.conditions[1], "R-4.2: Error: x — at tests/acceptance/users/R-4.2.spec.ts:3", "a file of one case needs no name for it");
});

// A criterion's cases can fail for different reasons, and each reason is a fix of its own. Every
// failing case is named; cases that stopped at the same assertion with the same message are one
// failure, and share a condition (`docs/decisions/0094`).
test("every failing case of a criterion is named, and cases that failed the same way share a condition", async (t) => {
  const d = buildProject(t);
  const statement = "Only a signed-in vendor who has accepted the terms may register an organization; a request from anyone else is refused";
  const refused = "Error: expect(received).toMatch(expected)\n\nExpected pattern: /permission/i\nReceived string:  \"errors\"";
  mockSuite(t, [
    { id: "R-4.1", result: "fail", file: "tests/acceptance/users/R-4.1.spec.ts", tests: [
      { title: `${statement} — a registration through the create screen is accepted`, status: "passed" },
      { title: `${statement} — a registration sent by a vendor who has accepted the terms is accepted`, status: "failed", error: "Error: the input key \"addressLineTwo\" names no field", line: 70 },
      { title: `${statement} — a registration sent by a member of staff is refused`, status: "failed", error: refused, line: 52 },
      { title: `${statement} — a registration sent by a visitor is refused`, status: "failed", error: refused, line: 52 },
    ] },
    row("R-4.2", "pass"),
  ]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.deepEqual(gate.conditions, [
    "R-4.1, in the case \"a registration sent by a vendor who has accepted the terms is accepted\": Error: the input key \"addressLineTwo\" names no field — at tests/acceptance/users/R-4.1.spec.ts:70",
    "R-4.1, in the cases \"a registration sent by a member of staff is refused\" and \"a registration sent by a visitor is refused\": Error: expect(received).toMatch(expected) — Expected pattern: /permission/i — Received string:  \"errors\" — at tests/acceptance/users/R-4.1.spec.ts:52",
  ]);
});

// A title carries the criterion's statement and then the case, and a statement can be long and
// hold a dash of its own. The case is what the title adds to the start every test of the criterion
// shares.
test("a case is named by what its title adds to the criterion's statement, however long the statement", async (t) => {
  const d = buildProject(t);
  const statement = `The Edit and Archive controls are offered only to a person permitted to use them — the owner or an administrator; ${"an organization administrator who is not the owner sees the profile read-only, ".repeat(3)}and the service refuses anyone else`;
  mockSuite(t, [
    { id: "R-4.1", result: "fail", file: "tests/acceptance/users/R-4.1.spec.ts", tests: [
      { title: `${statement} — the Edit and Archive controls are offered to a service administrator`, status: "passed" },
      { title: `${statement} — an archive request sent by an administrator who is not the owner is refused`, status: "failed", error: "Error: x", line: 9 },
    ] },
    row("R-4.2", "pass"),
  ]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.equal(gate.conditions[0], "R-4.1, in the case \"an archive request sent by an administrator who is not the owner is refused\": Error: x — at tests/acceptance/users/R-4.1.spec.ts:9");
});

test("a criterion's failures past the first few are named by their cases rather than described", async (t) => {
  const d = buildProject(t);
  const cases = ["c1", "c2", "c3", "c4", "c5"];
  mockSuite(t, [
    { id: "R-4.1", result: "fail", file: "tests/acceptance/users/R-4.1.spec.ts",
      tests: cases.map((c, i) => ({ title: `A statement (${c})`, status: "failed", error: `Error: e${i + 1}`, line: 10 + i })) },
    row("R-4.2", "pass"),
  ]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.deepEqual(gate.conditions, [
    "R-4.1, in the case \"c1\": Error: e1 — at tests/acceptance/users/R-4.1.spec.ts:10",
    "R-4.1, in the case \"c2\": Error: e2 — at tests/acceptance/users/R-4.1.spec.ts:11",
    "R-4.1, in the case \"c3\": Error: e3 — at tests/acceptance/users/R-4.1.spec.ts:12",
    "R-4.1: 2 more cases failed, not described here: \"c4\" and \"c5\"",
  ]);
});

test("an empty read in any failing case of a criterion leaves the build open to sort", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [
    { id: "R-4.1", result: "fail", file: "tests/acceptance/users/R-4.1.spec.ts", tests: [
      { title: "A statement (one that fails plainly)", status: "failed", error: "Error: plainly wrong", line: 5 },
      { title: "A statement (one that reads nothing)", status: "failed", error: "Error: expect(received).toMatch(expected)\nReceived string:  \"\"", line: 12,
        steps: stepsTo({ step: "accountView.status", at: "/accounts/7", read: "\"\"", empty: true }) },
    ] },
    row("R-4.2", "pass"),
  ]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  assert.throws(() => onBranch(d, ".sdlc/gates/build-slice-1.yaml"), "verify writes no ruling of its own");
  const result = JSON.parse(onBranch(d, "tests/results/new/slice-1.json"));
  assert.deepEqual(result.sort.empty_reads, ["R-4.1"]);
  assert.equal(result.sort.conditions.length, 2);
});

// The whole regression suite runs on the build that is a candidate for approval. A build that
// does not yet do what its own criteria say goes back for that alone, and says the earlier
// criteria wait (`docs/decisions/0089`).
test("earlier slices' criteria are checked again only once the slice's own pass", async (t) => {
  const d = buildProject(t);
  withEarlierSlice(d, [row("R-3.1", "pass")]);
  const calls = [];
  const ctx = { ...ctxFor(d), runSuite: suiteOf([row("R-4.1", "fail", "Error: x"), row("R-4.2", "pass"), row("R-3.1", "fail", "Error: y")], calls) };
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.equal(calls.length, 1, "only the slice's own tests ran");
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.deepEqual(gate.conditions, ["R-4.1: Error: x"]);
  assert.match(r.text, /The 1 criterion earlier slices passed is checked again once this slice's own criteria pass/);
});

// A target that declares several copies is verified across all of them: the suite is handed
// one address, mail catcher and reset per copy, and spreads its tests over them
// (`docs/decisions/0090`).
test("verify starts every copy of the new target and hands the suite one of each", async (t) => {
  const d = buildProject(t);
  const calls = [];
  const ctx = ctxFor(d);
  ctx.config.targets.new = { ...ctx.config.targets.new, instances: 2, ports: { SDLC_APP_PORT: 8080 } };
  let asked;
  ctx.sandbox = {
    up: async (_d, opts) => { asked = opts; return { ok: true, baseUrl: "http://localhost:8080", copies: [{ index: 0, baseUrl: "http://localhost:8080", mailApi: "" }, { index: 1, baseUrl: "http://localhost:8180", mailApi: "" }] }; },
    down: () => ({ ok: true }),
  };
  ctx.runSuite = (opts) => { calls.push(opts); return { rows: [row("R-4.1", "pass"), row("R-4.2", "pass")] }; };
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  assert.equal(asked?.copies, "all", "verify asks for every copy");
  assert.deepEqual(calls[0].instances.map((c) => c.baseUrl), ["http://localhost:8080", "http://localhost:8180"]);
  assert.match(calls[0].instances[1].resetCommand, /-p sdlc-p-new-1 /);
});

// A failing test leaves the steps it took through the contract's surface, and verify keeps a
// picture and an outline of the page it ended on (`docs/decisions/0091`).
const stepsTo = (last) => [
  { step: "signIn", given: "persona member", at: "/" },
  { step: "accountView.open", given: "{accountId}", at: "/accounts/7" },
  last,
];
const failedAfter = (id, last, extra = {}) => ({ id, result: "fail", file: `tests/acceptance/users/${id}.spec.ts`,
  tests: [{ title: "t", status: "failed", error: "Error: expect(received).toMatch(expected)\nReceived string:  \"\"", line: 12, steps: stepsTo(last), ...extra }] });

test("a failure says which steps its test took, which page it ended on and what it read there", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), failedAfter("R-4.2", { step: "accountView.status", at: "/accounts/7", read: "\"Closed\"" })]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.equal(gate.verdict, "return", "a read that came back with something is the application's, and goes straight back");
  assert.equal(gate.conditions[0], "R-4.2: Error: expect(received).toMatch(expected) — Received string:  \"\" — at tests/acceptance/users/R-4.2.spec.ts:12"
    + " — its last steps: signIn(persona member) at / → accountView.open({accountId}) at /accounts/7 → accountView.status() at /accounts/7 read \"Closed\"");
});

test("a failure that stopped on a read that came back with nothing is left open for the G3 ruler to sort", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [failedAfter("R-4.1", { step: "accountView.status", at: "/accounts/7", read: "\"\"", empty: true }), row("R-4.2", "fail", "Error: plainly wrong")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.throws(() => onBranch(d, ".sdlc/gates/build-slice-1.yaml"), "verify writes no ruling of its own");
  const result = JSON.parse(onBranch(d, "tests/results/new/slice-1.json"));
  assert.equal(result.verdict, "fail");
  assert.deepEqual(result.sort.empty_reads, ["R-4.1"]);
  assert.equal(result.sort.conditions.length, 2, "every failure is listed as the build would be told it, not only the empty read");
  assert.match(result.sort.conditions[0], /accountView\.status\(\) at \/accounts\/7 read ""$/);
  assert.match(r.text, /R-4\.1 stopped on a read that came back with nothing.*left open for agent:reviewer/);
  assert.equal(buildVerified(d, "build-slice-1", ctx.config).ok, false, "it is still not approvable");
});

// The adapter reports a member whose page the application does not serve as absent. The build may
// be the one to make the page, a later slice may, or the adapter may be wrong about it, and a
// builder can answer only the first, so the ruler sorts it first (`docs/decisions/0098`).
test("a failure where the adapter found the application does not serve the page is left open for the G3 ruler to sort", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [
    { id: "R-4.1", result: "fail", file: "tests/acceptance/users/R-4.1.spec.ts",
      tests: [{ title: "t", status: "failed", error: "Error: absent: proposal-create.open — /proposals/create answers the application's \"Page not found\" as every persona", line: 7 }] },
    row("R-4.2", "fail", "Error: plainly wrong"),
  ]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.throws(() => onBranch(d, ".sdlc/gates/build-slice-1.yaml"), "verify writes no ruling of its own");
  const result = JSON.parse(onBranch(d, "tests/results/new/slice-1.json"));
  assert.equal(result.verdict, "fail");
  assert.deepEqual(result.sort.absent, ["R-4.1"]);
  assert.deepEqual(result.sort.empty_reads, []);
  assert.equal(result.sort.conditions.length, 2);
  assert.match(result.sort.conditions[0], /^R-4\.1: Error: absent: proposal-create\.open — /);
  assert.match(r.text, /R-4\.1 stopped where the adapter found the application does not serve the page.*left open for agent:reviewer/);
  assert.equal(buildVerified(d, "build-slice-1", ctx.config).ok, false, "it is still not approvable");
});

// A test that caught the adapter's `absent:` and failed on what it was left with stopped at a page
// the application does not serve all the same (`docs/decisions/0100`).
test("a failure whose last step threw absent: is sorted as a page the application does not serve, and an unbound reason is read off the step", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [
    { id: "R-4.1", result: "fail", file: "tests/acceptance/users/R-4.1.spec.ts",
      tests: [{ title: "t", status: "failed", error: "Error: the proposal page opened\nExpected: true\nReceived: false", line: 7,
        steps: [{ step: "proposalView.open", threw: "absent: proposal-view.open — /proposals/1 answers the application's not-found page as every persona" }] }] },
    row("R-4.2", "pass"),
  ]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  const result = JSON.parse(onBranch(d, "tests/results/new/slice-1.json"));
  assert.deepEqual(result.sort.absent, ["R-4.1"]);
  const { unboundReasons } = await import("../src/stages/verify.mjs");
  const caught = [{ id: "R-4.3", result: "unbound", tests: [{ status: "failed", error: "Error: no score", steps: [{ step: "v.score", threw: "unbound: v.score — not bound" }] }] }];
  assert.deepEqual(unboundReasons(caught, ["R-4.3"]), [{ id: "R-4.3", reason: "v.score — not bound" }]);
});

test("a ruler's return of a build verify left open to sort counts toward verify's limit", async (t) => {
  const d = buildProject(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  for (const k of [2, 3]) {
    run(["checkout", "-q", "-b", `proposal/build-slice-1-${k}`, "proposal/build-slice-1"]);
    run(["checkout", "-q", "main"]);
  }
  for (const name of ["build-slice-1", "build-slice-1-2"]) {
    run(["checkout", "-q", `proposal/${name}`]);
    mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
    mkdirSync(join(d, "tests", "results", "new"), { recursive: true });
    writeFileSync(join(d, ".sdlc", "gates", `${name}.yaml`), "gate: G3\nverdict: return\nby: agent:reviewer\nheld_by: agent:reviewer\n");
    writeFileSync(join(d, "tests", "results", "new", "slice-1.json"), JSON.stringify({ slice: 1, proposal: name, verdict: "fail", sort: { empty_reads: ["R-4.1"], conditions: ["R-4.1: x"] }, rows: [] }));
    run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "sorted and returned"]);
    run(["checkout", "-q", "main"]);
  }
  mockSuite(t, [failedAfter("R-4.1", { step: "accountView.status", at: "/accounts/7", read: "\"\"", empty: true }), row("R-4.2", "pass")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  const gate = parseYaml(execFileSync("git", ["show", "proposal/build-slice-1-3:.sdlc/gates/build-slice-1-3.yaml"], { cwd: d, encoding: "utf8" }));
  assert.equal(gate.verdict, "escalated", "two sorted returns and this failure are the third strike, so verify escalates rather than leaving it to sort again");
});

test("verify keeps a picture and an outline of the page a test failed on, and names them in the condition", async (t) => {
  const d = buildProject(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  writeFileSync(join(d, ".gitignore"), ".sdlc/evidence/\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "ignores"]);
  const shots = mkdtempSync(join(tmpdir(), "sdlc-shots-"));
  t.after(() => rmSync(shots, { recursive: true, force: true }));
  writeFileSync(join(shots, "failure.png"), "png");
  const failing = failedAfter("R-4.2", { step: "accountView.status", at: "/accounts/7", read: "\"Closed\"" });
  Object.defineProperty(failing.tests[0], "evidence", { value: { screen: join(shots, "failure.png"), outline: "/accounts/7\n\n- heading \"Account\" [level=1]" }, enumerable: false });
  const ctx = { ...ctxFor(d), runSuite: suiteOf([row("R-4.1", "pass"), failing], []) };
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  assert.equal(readFileSync(join(d, ".sdlc", "evidence", "slice-1", "R-4.2.png"), "utf8"), "png");
  assert.match(readFileSync(join(d, ".sdlc", "evidence", "slice-1", "R-4.2.txt"), "utf8"), /heading "Account"/);
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.match(gate.conditions[0], / — the page as it failed: \.sdlc\/evidence\/slice-1\/R-4\.2\.png, \.sdlc\/evidence\/slice-1\/R-4\.2\.txt$/);
  const result = onBranch(d, "tests/results/new/slice-1.json");
  assert.ok(!result.includes(shots), "the machine's own path to the picture is never written");
  assert.doesNotMatch(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: d, encoding: "utf8" }), /evidence/, "what is kept leaves the tree clean");
});

test("verify keeps no picture where git would not ignore it, and the steps still travel", async (t) => {
  const d = buildProject(t);
  const shots = mkdtempSync(join(tmpdir(), "sdlc-shots-"));
  t.after(() => rmSync(shots, { recursive: true, force: true }));
  writeFileSync(join(shots, "failure.png"), "png");
  const failing = failedAfter("R-4.2", { step: "accountView.status", at: "/accounts/7", read: "\"Closed\"" });
  Object.defineProperty(failing.tests[0], "evidence", { value: { screen: join(shots, "failure.png") }, enumerable: false });
  const ctx = { ...ctxFor(d), runSuite: suiteOf([row("R-4.1", "pass"), failing], []) };
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  assert.equal(existsSync(join(d, ".sdlc", "evidence")), false);
  const gate = parseYaml(onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
  assert.match(gate.conditions[0], /its last steps: .* read "Closed"$/);
});

test("a ruler given a build to sort is told how, with every failure as the build would be told it", async () => {
  const { formatVerifyEvidence } = await import("../src/runner/verify-evidence.mjs");
  const text = formatVerifyEvidence({ slice: 1, result: {
    verdict: "fail", proposal: "build-slice-1", app_tree: "abcdef0",
    sort: { empty_reads: ["R-4.1"], conditions: ["R-4.1: Error: x — its last steps: accountView.status() at /accounts/7 read \"\"", "R-4.2: Error: y"] },
    rows: [row("R-4.1", "fail", "Error: x"), row("R-4.2", "fail", "Error: y")],
  } });
  assert.match(text, /### Failures to sort before the build goes back/);
  assert.match(text, /R-4\.1 stopped on a read that came back with nothing/);
  assert.match(text, /addressed-to bind-adapter: <the criterion id>:/);
  assert.match(text, /^- R-4\.1: Error: x — its last steps: accountView\.status\(\) at \/accounts\/7 read ""$/m);
  assert.match(text, /^- R-4\.2: Error: y$/m);
});

test("a ruler given a page the application does not serve is told who can make it", async () => {
  const { formatVerifyEvidence } = await import("../src/runner/verify-evidence.mjs");
  const text = formatVerifyEvidence({ slice: 1, result: {
    verdict: "fail", proposal: "build-slice-1", app_tree: "abcdef0",
    sort: { empty_reads: [], absent: ["R-4.1"], conditions: ["R-4.1: Error: absent: proposal-create.open — /proposals/create answers \"Page not found\"", "R-4.2: Error: y"] },
    rows: [row("R-4.1", "fail", "Error: absent: proposal-create.open — x"), row("R-4.2", "fail", "Error: y")],
  } });
  assert.match(text, /### Failures to sort before the build goes back/);
  assert.match(text, /R-4\.1 stopped where the adapter found the application does not serve the page/);
  assert.doesNotMatch(text, /came back with nothing/);
  assert.match(text, /addressed-to plan: <the criterion id>:/);
  assert.match(text, /addressed-to bind-adapter: <the criterion id>:/);
  assert.match(text, /^- R-4\.2: Error: y$/m);
});

// The ruler of a build verify escalated works from this section, so a criterion whose cases
// failed for different reasons shows each reason (`docs/decisions/0094`).
test("a ruler is shown every way a criterion's tests failed, each with its cases", async () => {
  const { formatVerifyEvidence } = await import("../src/runner/verify-evidence.mjs");
  const statement = "Only a signed-in vendor may register an organization";
  const refused = "Error: \u001b[2mexpect(\u001b[22mreceived\u001b[2m).\u001b[22mtoMatch\nExpected pattern: /permission/i\nReceived string:  \"errors\"";
  const text = formatVerifyEvidence({ slice: 1, result: {
    verdict: "fail", proposal: "build-slice-1", app_tree: "abcdef0",
    rows: [
      { id: "R-4.1", result: "fail", file: "tests/acceptance/users/R-4.1.spec.ts", tests: [
        { title: `${statement} — a registration by a vendor is accepted`, status: "failed", error: "Error: the input key \"addressLineTwo\" names no field", line: 70 },
        { title: `${statement} — a registration by staff is refused`, status: "failed", error: refused, line: 52 },
        { title: `${statement} — a registration by a visitor is refused`, status: "failed", error: refused, line: 52 },
        { title: `${statement} — a registration through the create screen is accepted`, status: "passed" },
      ] },
      { id: "R-4.2", result: "fail", file: "tests/acceptance/users/R-4.2.spec.ts", tests: [
        { title: "Another statement (one case)", status: "failed", error: refused, line: 8 },
        { title: "Another statement (a second case)", status: "failed", error: refused, line: 8 },
      ] },
    ],
  } });
  assert.match(text, /^- R-4\.1 — \*\*fail\*\*, 2 different failures:$/m);
  assert.match(text, /^ {2}- in the case "a registration by a vendor is accepted": Error: the input key "addressLineTwo" names no field$/m);
  assert.match(text, /^ {2}- in the cases "a registration by staff is refused" and "a registration by a visitor is refused": Error: expect\(received\)\.toMatch Expected pattern: \/permission\/i Received string: "errors"$/m);
  assert.match(text, /^- R-4\.2 — \*\*fail\*\*, in the cases "one case" and "a second case": Error: expect/m);
  assert.doesNotMatch(text, /\u001b/, "the runner's colour codes are not passed on");
});

// Playwright empties its own output folder when it starts, so the pictures one run of the suite
// left are gone once the next run begins. Verify runs the slice's own tests, then earlier slices'
// tests, and keeps each run's evidence before the next.
test("the evidence of the slice's own run is kept before the earlier slices' run starts", async (t) => {
  const d = buildProject(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  writeFileSync(join(d, ".gitignore"), ".sdlc/evidence/\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "ignores"]);
  withEarlierSlice(d, [row("R-3.1", "pass")]);
  const shots = mkdtempSync(join(tmpdir(), "sdlc-shots-"));
  t.after(() => rmSync(shots, { recursive: true, force: true }));
  const shot = (name) => { writeFileSync(join(shots, name), name); return join(shots, name); };
  const withShot = (r, path) => { Object.defineProperty(r.tests[0], "evidence", { value: { screen: path }, enumerable: false }); return r; };
  let call = 0;
  const ctx = { ...ctxFor(d), runSuite: () => {
    call += 1;
    if (call === 1) return { rows: [row("R-4.1", "pass"), withShot(row("R-4.2", "fail", MAIL_UNSET), shot("own.png"))] };
    rmSync(join(shots, "own.png"));
    return { rows: [withShot(row("R-3.1", "fail", "Error: y"), shot("earlier.png"))] };
  } };
  verify.preChecks(d, ctx);
  await verify.execute(d, ctx);
  assert.equal(call, 2, "the earlier slices' tests ran");
  assert.equal(readFileSync(join(d, ".sdlc", "evidence", "slice-1", "R-4.2.png"), "utf8"), "own.png");
  assert.equal(readFileSync(join(d, ".sdlc", "evidence", "slice-1", "R-3.1.png"), "utf8"), "earlier.png");
});

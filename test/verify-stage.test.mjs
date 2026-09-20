import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runSuite } from "../src/testrun/playwright.mjs";
import { verify, verifyVerdict, MAX_VERIFY_RETURNS } from "../src/stages/verify.mjs";
import { build } from "../src/stages/build.mjs";
import { buildProposalBase } from "../src/stages/slices.mjs";
import { nextProposalName } from "../src/stages/proposals.mjs";
import { registerStage } from "../src/stages/registry.mjs";
import { runStage } from "../src/commands/run.mjs";

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
  const calls = [];
  const exec = (cmd, args) => { calls.push(args); return { status: 0, stdout: '{"suites":[]}', stderr: "" }; };
  runSuite({ projectDir: d, target: "new", baseUrl: "http://x", files: ["tests/acceptance/users/R-4.1.spec.ts"], exec });
  const run = calls.find((a) => a.includes("playwright"));
  assert.ok(run.includes("acceptance/users/R-4.1.spec.ts"));
  assert.ok(!run.some((a) => a === "acceptance/users/"));
});

const row = (id, result, error) => ({ id, result, file: `tests/acceptance/users/${id}.spec.ts`, tests: error ? [{ status: "failed", error }] : [] });

test("a slice passes only when every criterion it claims passes or needs no test", () => {
  assert.equal(verifyVerdict([row("R-1", "pass"), row("R-2", "not-testable")], ["R-1", "R-2"]).verdict, "pass");
  assert.equal(verifyVerdict([row("R-1", "pass"), row("R-2", "stale")], ["R-1", "R-2"]).verdict, "fail", "a stale test cannot verify a slice (spec 7.2)");
  assert.equal(verifyVerdict([row("R-1", "pass")], ["R-1", "R-2"]).verdict, "fail", "a claimed criterion with no row is not verified");
  const u = verifyVerdict([row("R-1", "pass"), row("R-2", "unbound")], ["R-1", "R-2"]);
  assert.equal(u.verdict, "unbound");
  assert.deepEqual(u.unbound, ["R-2"]);
  assert.equal(verifyVerdict([row("R-1", "fail", "x"), row("R-2", "unbound")], ["R-1", "R-2"]).verdict, "fail");
});

// A real project, a build proposal on its branch, the suite and the sandbox both mocked.
function buildProject(t, { escalateTo = "tech-lead" } = {}) {
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
    `    G3: { holder: "agent:reviewer", escalate_to: ${escalateTo} }`, "    G-POL: { holder: \"agent:tech-lead\", escalate_to: tech-lead }",
    "  default_tier: STANDARD", "skills: { packs: [] }", "egress: { rules: [E-2] }", "",
  ].join("\n"));
  writeFileSync(join(d, ".gitattributes"), ".sdlc/runs/*.md merge=union\n");
  writeFileSync(join(d, "plan", "tasks.md"), "### Slice 1 · Sign in\n- criteria: R-4.1, R-4.2\n");
  for (const id of ["R-4.1", "R-4.2"]) writeFileSync(join(d, "tests", "acceptance", "users", `${id}.spec.ts`), "");
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

test("an unbound slice is neither returned nor passed, and names the binding it needs", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "unbound")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.match(r.text, /bind-adapter --target new/);
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

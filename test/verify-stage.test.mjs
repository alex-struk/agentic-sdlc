import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runSuite } from "../src/testrun/playwright.mjs";
import { verify, verifyVerdict, mergeFailureText, unboundReasons, MAX_VERIFY_RETURNS } from "../src/stages/verify.mjs";
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
// bind sequence is the right answer to only one of them. Printed over the other, it asks
// for half an hour of sandbox, adapter and ruling that drives the same application again
// and writes the same reasons back.
test("an unbound slice whose adapter is already in place is not told to bind again", async (t) => {
  const d = buildProject(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  mkdirSync(join(d, "tests", "adapters", "new"), { recursive: true });
  writeFileSync(join(d, "tests", "adapters", "new", "index.ts"), "export const surface = {};\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "adapter"]);
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

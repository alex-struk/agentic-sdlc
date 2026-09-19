import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runSuite } from "../src/testrun/playwright.mjs";
import { verify, verifyVerdict, MAX_VERIFY_RETURNS } from "../src/stages/verify.mjs";

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
function buildProject(t) {
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
    "    G3: { holder: \"agent:reviewer\", escalate_to: tech-lead }", "    G-POL: { holder: \"agent:tech-lead\", escalate_to: tech-lead }",
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

test("an unbound slice is neither returned nor passed, and names the binding it needs", async (t) => {
  const d = buildProject(t);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "unbound")]);
  const ctx = ctxFor(d);
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.match(r.text, /bind-adapter --target new/);
  assert.throws(() => onBranch(d, ".sdlc/gates/build-slice-1.yaml"));
});

test("verify refuses a slice with no open build proposal, and a sandbox that will not start", async (t) => {
  const d = buildProject(t);
  const none = { ...ctxFor(d), slice: 2 };
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: d });
  assert.match(verify.preChecks(d, none).find((c) => !c.ok).messages[0], /no open build proposal for slice 2/);
  mockSuite(t, [row("R-4.1", "pass"), row("R-4.2", "pass")]);
  const ctx = { ...ctxFor(d), sandbox: { up: async () => ({ ok: false, messages: ["the application did not answer at http://localhost:8080"] }), down: () => ({ ok: true }) } };
  verify.preChecks(d, ctx);
  const r = await verify.execute(d, ctx);
  assert.match(r.text, /did not answer/);
  assert.throws(() => onBranch(d, "tests/results/new/slice-1.json"));
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d, encoding: "utf8" }).trim(), "main");
});

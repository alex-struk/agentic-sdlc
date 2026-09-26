import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { propose } from "../src/commands/propose.mjs";
import { registerStage, stageFor } from "../src/stages/registry.mjs";
import { COMMANDS } from "../src/cli.mjs";
import { runStage } from "../src/commands/run.mjs";
import "../src/commands/run.mjs";
import "../src/commands/rule.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;

async function makeProject(t) {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-next-run-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  t.after(() => { if (prevEgress === undefined) delete process.env.SDLC_EGRESS_NAMES; else process.env.SDLC_EGRESS_NAMES = prevEgress; });
  const dir = join(tmp, "permit-intake");
  await newProject({ dir, from: FROM });
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "fill constitution"], dir);
  return dir;
}

function mockProbe(t) {
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-"));
  writeFileSync(join(mockDir, "probe.json"), JSON.stringify({ text: "wrote the probe file", files: { "app/PROBE.md": "the runner works\n" } }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  t.after(() => { delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR; rmSync(mockDir, { recursive: true, force: true }); });
}

// Runs a command from inside `dir`, the way the CLI does, and returns what it printed.
async function inDir(dir, fn) {
  const logs = [];
  const orig = console.log;
  const cwd = process.cwd();
  process.chdir(dir);
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const code = await fn();
    return { code, logs };
  } catch (error) {
    return { error, logs };
  } finally {
    console.log = orig;
    process.chdir(cwd);
  }
}

const runRecord = (dir) => {
  const day = new Date().toISOString().slice(0, 10);
  try { return readFileSync(join(dir, ".sdlc", "runs", `${day}.md`), "utf8"); } catch { return ""; }
};

test("running something other than what next names is refused without a reason, and nothing is written", async (t) => {
  const dir = await makeProject(t);
  mockProbe(t);
  const head = git(["rev-parse", "HEAD"], dir);
  const { error } = await inDir(dir, () => COMMANDS.run({ pos: ["probe"], flags: {} }));
  assert.ok(error, "the run was refused");
  assert.match(error.message, /next names `sdlc run intent`/);
  assert.match(error.message, /--reason/);
  assert.equal(git(["rev-parse", "HEAD"], dir), head);
  assert.equal(git(["status", "--porcelain"], dir), "");
});

test("with a reason the run goes ahead and the run record says what next named, what ran and why", async (t) => {
  const dir = await makeProject(t);
  mockProbe(t);
  const promptFile = join(dir, "..", "agent-prompt.txt");
  process.env.SDLC_MOCK_PROMPT_FILE = promptFile;
  t.after(() => { delete process.env.SDLC_MOCK_PROMPT_FILE; });
  const reason = `checking the runner on ${join(homedir(), "work")} before the intent is written`;
  const { code, error, logs } = await inDir(dir, () => COMMANDS.run({ pos: ["probe"], flags: { reason } }));
  assert.equal(error, undefined, error?.message);
  assert.equal(code, 0);
  const record = runRecord(dir);
  assert.match(record, /deviation: next named `sdlc run intent`; ran `sdlc run probe`; reason: checking the runner on ~\/work before the intent is written/);
  assert.ok(!record.includes(homedir()), "no local home path reaches the run record");
  assert.match(git(["log", "--format=%s", "-2"], dir), /run\(probe\): ran instead of what next named/);
  const prompt = readFileSync(promptFile, "utf8");
  assert.match(prompt, /Operator's reason for running this stage instead of what sdlc next named/);
  assert.match(prompt, /checking the runner on ~\/work before the intent is written/);
  assert.ok(!prompt.includes(homedir()), "no local home path reaches the agent prompt");
  assert.equal(git(["status", "--porcelain"], dir), "");
  assert.match(logs.join("\n"), /^next: /m, "the run ends by printing what is next");
});

test("a dry run never needs a reason and records nothing", async (t) => {
  const dir = await makeProject(t);
  mockProbe(t);
  const head = git(["rev-parse", "HEAD"], dir);
  const record = runRecord(dir);
  const { code, error } = await inDir(dir, () => COMMANDS.run({ pos: ["probe"], flags: { "dry-run": true } }));
  assert.equal(error, undefined, error?.message);
  assert.equal(code, 0);
  assert.equal(git(["rev-parse", "HEAD"], dir), head);
  assert.equal(runRecord(dir), record);
});

test("a dry run with an off-sequence reason previews the agent's contextual note without writing it", async (t) => {
  const dir = await makeProject(t);
  const head = git(["rev-parse", "HEAD"], dir);
  const reason = `investigate evidence under ${join(homedir(), "work")}`;
  const { code, error, logs } = await inDir(dir, () => COMMANDS.run({ pos: ["probe"], flags: { "dry-run": true, reason } }));
  assert.equal(error, undefined, error?.message);
  assert.equal(code, 0);
  const preview = logs.join("\n");
  assert.match(preview, /Operator's reason for running this stage instead of what sdlc next named/);
  assert.match(preview, /investigate evidence under ~\/work/);
  assert.ok(!preview.includes(homedir()), "no local home path reaches the preview");
  assert.equal(git(["rev-parse", "HEAD"], dir), head);
  assert.equal(git(["status", "--porcelain"], dir), "");
});

test("an interrupted off-sequence run keeps only the scrubbed context in run-state", async (t) => {
  const dir = await makeProject(t);
  mockProbe(t);
  writeFileSync(join(process.env.SDLC_MOCK_DIR, "probe.json"), JSON.stringify({ ok: false, text: "agent turn failed" }));
  const reason = `investigate evidence under ${join(homedir(), "work")}`;
  const { code, error } = await inDir(dir, () => COMMANDS.run({ pos: ["probe"], flags: { reason } }));
  assert.equal(error, undefined, error?.message);
  assert.equal(code, 1);
  const state = JSON.parse(readFileSync(join(dir, ".sdlc/run-state.json"), "utf8"));
  assert.equal(state.ctx.deviationReason, "investigate evidence under ~/work");
  assert.ok(!JSON.stringify(state).includes(homedir()), "no local home path reaches run-state");
});

test("the run next names needs no reason and records no deviation", async (t) => {
  const dir = await makeProject(t);
  const real = stageFor("intent");
  registerStage({ ...real, gate: null, agent: false, preChecks: () => [], postChecks: () => [], execute: () => ({ text: "nothing to do", changed: [] }) });
  t.after(() => registerStage(real));
  const { code, error, logs } = await inDir(dir, () => COMMANDS.run({ pos: ["intent"], flags: {} }));
  assert.equal(error, undefined, error?.message);
  assert.equal(code, 0);
  assert.doesNotMatch(runRecord(dir), /deviation:/);
  assert.match(logs.join("\n"), /^next: sdlc run intent$/m);
});

test("an in-sequence agent run ignores a supplied reason in its prompt, record and run-state", async (t) => {
  const dir = await makeProject(t);
  const real = stageFor("intent");
  registerStage({ ...real, gate: null, workspace: "project", preChecks: () => [], postChecks: () => [], prompt: () => "do the next stage" });
  t.after(() => registerStage(real));
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-next-reason-mock-"));
  const promptFile = join(mockDir, "prompt.txt");
  writeFileSync(join(mockDir, "intent.json"), JSON.stringify({ ok: false, text: "agent turn failed" }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  process.env.SDLC_MOCK_PROMPT_FILE = promptFile;
  t.after(() => {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR; delete process.env.SDLC_MOCK_PROMPT_FILE;
    rmSync(mockDir, { recursive: true, force: true });
  });
  const { code, error } = await inDir(dir, () => COMMANDS.run({ pos: ["intent"], flags: { reason: "review prior environment evidence" } }));
  assert.equal(error, undefined, error?.message);
  assert.equal(code, 1);
  assert.doesNotMatch(readFileSync(promptFile, "utf8"), /Operator's reason for running this stage/);
  assert.doesNotMatch(runRecord(dir), /deviation:/);
  const state = JSON.parse(readFileSync(join(dir, ".sdlc/run-state.json"), "utf8"));
  assert.ok(!Object.hasOwn(state.ctx, "deviationReason"));
});

test("a credential-shaped deviation reason is refused before a run record or prompt is written", async (t) => {
  const dir = await makeProject(t);
  mockProbe(t);
  const promptFile = join(dir, "..", "unsafe-prompt.txt");
  process.env.SDLC_MOCK_PROMPT_FILE = promptFile;
  t.after(() => { delete process.env.SDLC_MOCK_PROMPT_FILE; });
  const head = git(["rev-parse", "HEAD"], dir);
  const record = runRecord(dir);
  const synthetic = "example-only";
  const cases = [
    `password=${synthetic}`,
    `access_token: ${synthetic}`,
    `MY_SECRET=${synthetic}`,
    `api_key=${synthetic}`,
    `apiKey=${synthetic}`,
    `accessToken=${synthetic}`,
    `APIKEY=${synthetic}`,
    `apikey=${synthetic}`,
    `clientsecret=${synthetic}`,
    `accesskey=${synthetic}`,
    `Bearer ${synthetic}`,
    "-----BEGIN " + "PRIVATE KEY-----",
    ["000", "000", "000"].join("-"),
  ];
  for (const reason of cases) {
    const { error } = await inDir(dir, () => COMMANDS.run({ pos: ["probe"], flags: { reason } }));
    assert.ok(error, "the reason was refused");
    assert.match(error.message, /remove it and supply a redacted summary/);
    assert.ok(!error.message.includes(reason), "the refusal does not echo the input");
    assert.equal(git(["rev-parse", "HEAD"], dir), head);
    assert.equal(runRecord(dir), record);
    assert.equal(existsSync(promptFile), false, "the agent prompt was never built");
  }
});

test("an ordinary word ending in key is allowed as a deviation reason", async (t) => {
  const dir = await makeProject(t);
  const head = git(["rev-parse", "HEAD"], dir);
  const { code, error } = await inDir(dir, () => COMMANDS.run({ pos: ["probe"], flags: { "dry-run": true, reason: "monkey=example-only" } }));
  assert.equal(error, undefined, error?.message);
  assert.equal(code, 0);
  assert.equal(git(["rev-parse", "HEAD"], dir), head);
  assert.equal(git(["status", "--porcelain"], dir), "");
});

test("direct runStage refuses a credential-shaped deviation reason before stage work", async (t) => {
  const dir = await makeProject(t);
  const head = git(["rev-parse", "HEAD"], dir);
  const reason = "token=" + "example-only";
  await assert.rejects(() => runStage(dir, "probe", { dryRun: true, deviationReason: reason }), (error) => {
    assert.match(error.message, /remove it and supply a redacted summary/);
    assert.ok(!error.message.includes(reason), "the refusal does not echo the input");
    return true;
  });
  assert.equal(git(["rev-parse", "HEAD"], dir), head);
  assert.equal(git(["status", "--porcelain"], dir), "");
});

test("a ruling ends by printing what is next", async (t) => {
  const dir = await makeProject(t);
  propose(dir, "intent-thing", { gate: "G1", question: "q?", recommendation: "r" });
  git(["checkout", "-q", "main"], dir);
  const { code, error, logs } = await inDir(dir, () => COMMANDS.rule({ pos: ["intent-thing", "approve"], flags: { by: "tech-lead" } }));
  assert.equal(error, undefined, error?.message);
  assert.equal(code, 0);
  assert.ok(logs.some((l) => /^next: /.test(l)), logs.join("\n"));
});

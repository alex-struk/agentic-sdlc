import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { propose } from "../src/commands/propose.mjs";
import { registerStage, stageFor } from "../src/stages/registry.mjs";
import { COMMANDS } from "../src/cli.mjs";
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
  const reason = `checking the runner on ${join(homedir(), "work")} before the intent is written`;
  const { code, error, logs } = await inDir(dir, () => COMMANDS.run({ pos: ["probe"], flags: { reason } }));
  assert.equal(error, undefined, error?.message);
  assert.equal(code, 0);
  const record = runRecord(dir);
  assert.match(record, /deviation: next named `sdlc run intent`; ran `sdlc run probe`; reason: checking the runner on ~\/work before the intent is written/);
  assert.ok(!record.includes(homedir()), "no local home path reaches the run record");
  assert.match(git(["log", "--format=%s", "-2"], dir), /run\(probe\): ran instead of what next named/);
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

test("a ruling ends by printing what is next", async (t) => {
  const dir = await makeProject(t);
  propose(dir, "intent-thing", { gate: "G1", question: "q?", recommendation: "r" });
  git(["checkout", "-q", "main"], dir);
  const { code, error, logs } = await inDir(dir, () => COMMANDS.rule({ pos: ["intent-thing", "approve"], flags: { by: "tech-lead" } }));
  assert.equal(error, undefined, error?.message);
  assert.equal(code, 0);
  assert.ok(logs.some((l) => /^next: /.test(l)), logs.join("\n"));
});

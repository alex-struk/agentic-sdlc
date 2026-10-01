import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { progressMark } from "../src/runner/drive.mjs";
import { driveProject, formatHeartbeat, HEARTBEAT } from "../src/commands/drive.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;

async function makeProject(t) {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-drive-"));
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

function quiet() {
  const printed = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => printed.push(a.join(" "));
  console.warn = (...a) => printed.push(a.join(" "));
  console.error = (...a) => printed.push(a.join(" "));
  return { printed, restore: () => Object.assign(console, orig) };
}

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-drive-mark-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], dir);
  return dir;
}
function commit(dir, files, message = "c") {
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), text); }
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", message], dir);
}
const item = { command: "sdlc run calibrate --target old", why: "phase 2 Tests is not complete" };
const results = (rows, at) => JSON.stringify({ target: "old", run: at, rows });

test("the progress mark ignores what every run writes about itself and sees what a step could change", (t) => {
  const dir = repo(t);
  commit(dir, {
    ".sdlc/owed.yaml": "entries: []\n",
    ".sdlc/runs/2026-01-01.md": "# Run record\n",
    "tests/results/old/latest.json": results([{ id: "A-1", result: "fail" }, { id: "A-2", result: "pass" }], "r1"),
  });
  const start = progressMark(dir, item);

  // A run record line, a journal entry, a regenerated site and a calibration that measured
  // the same outcome again are the account of a run, not progress.
  commit(dir, {
    ".sdlc/runs/2026-01-01.md": "# Run record\n- 10:00 run calibrate: ok\n",
    ".sdlc/journal/001-calibrate.md": "ran\n",
    "site/index.md": "regenerated\n",
    "tests/results/old/2026-01-01-2.json": "{}",
    "tests/results/old/latest.json": results([{ id: "A-2", result: "pass" }, { id: "A-1", result: "fail" }], "r2"),
  });
  assert.deepEqual(progressMark(dir, item), start);

  // A row that changed result, or was ruled, is.
  commit(dir, { "tests/results/old/latest.json": results([{ id: "A-1", result: "fail", ruled: "test-wrong" }, { id: "A-2", result: "pass" }], "r3") });
  const ruled = progressMark(dir, item);
  assert.notDeepEqual(ruled, start);

  // So is any other record file, and a proposal branch.
  commit(dir, { ".sdlc/owed.yaml": "entries: [{ kind: redo }]\n" });
  const owed = progressMark(dir, item);
  assert.notDeepEqual(owed, ruled);
  git(["branch", "proposal/calibrate-old-triage-1"], dir);
  assert.notDeepEqual(progressMark(dir, item), owed);

  // And a different reason from next for the same command.
  assert.notDeepEqual(progressMark(dir, { ...item, why: "something else" }), progressMark(dir, item));
});

// A verify merges `main` into its build branch before it runs, so what the step before it wrote
// on `main` reaches the branch one step late. `main`'s digest has counted it already, and a step
// that changed nothing else is no progress (`docs/decisions/0085`).
test("the progress mark does not count a change on main a second time when a step merges it into a branch", (t) => {
  const dir = repo(t);
  const at = (args) => git(["-c", "user.name=t", "-c", "user.email=t@example.org", ...args], dir);
  commit(dir, { "tests/adapters/rebind.yaml": "rebind: []\n", "app/index.ts": "export {};\n" });
  git(["checkout", "-q", "-b", "proposal/build-slice-1"], dir);
  commit(dir, { "app/index.ts": "export const a = 1;\n", "tests/results/new/slice-1.json": "{\"verdict\":\"unbound\"}" }, "verify(slice 1)");
  git(["checkout", "-q", "main"], dir);
  commit(dir, { "tests/adapters/rebind.yaml": "rebind: [{ id: R-1.1, closed: lapsed }]\n", ".sdlc/runs/2026-01-01.md": "- verify\n" }, "stage(verify)");
  const before = progressMark(dir, item);

  // The next step: main merged into the branch, the same verdict measured again, its run line.
  git(["checkout", "-q", "proposal/build-slice-1"], dir);
  at(["merge", "-q", "--no-edit", "main"]);
  commit(dir, { "tests/results/new/slice-1.json": "{\"verdict\":\"unbound\",\"at\":2}" }, "verify(slice 1)");
  git(["checkout", "-q", "main"], dir);
  commit(dir, { ".sdlc/runs/2026-01-01.md": "- verify\n- verify\n" }, "stage(verify)");
  assert.deepEqual(progressMark(dir, item), before);

  // What the branch holds of its own is still seen.
  git(["checkout", "-q", "proposal/build-slice-1"], dir);
  commit(dir, { "app/index.ts": "export const a = 2;\n" }, "revise");
  git(["checkout", "-q", "main"], dir);
  assert.notDeepEqual(progressMark(dir, item), before);
});

test("a dry run on a real project prints what it would run and why, and writes nothing", async (t) => {
  const dir = await makeProject(t);
  const head = git(["rev-parse", "HEAD"], dir);
  const out = quiet();
  let code;
  try { code = await driveProject(dir, { dryRun: true }); } finally { out.restore(); }
  assert.equal(code, 0);
  const printed = out.printed.join("\n");
  assert.match(printed, /would run: sdlc run intent/);
  assert.match(printed, /why: phase 1 Spec is not complete/);
  assert.equal(git(["rev-parse", "HEAD"], dir), head);
  assert.equal(git(["status", "--porcelain", "--ignored"], dir), "");
});

test("a dirty tree is refused before anything runs, and the refusal waits in the ignored pending record", async (t) => {
  const dir = await makeProject(t);
  const head = git(["rev-parse", "HEAD"], dir);
  writeFileSync(join(dir, "notes.txt"), "work in progress\n");
  const out = quiet();
  let code;
  try { code = await driveProject(dir, {}); } finally { out.restore(); }
  assert.equal(code, 2);
  assert.equal(git(["rev-parse", "HEAD"], dir), head);
  assert.equal(git(["status", "--porcelain"], dir), "?? notes.txt");
  assert.match(readFileSync(join(dir, ".sdlc", "runs.local.txt"), "utf8"), /refused to start: uncommitted changes in the working tree/);
});

test("a step runs through the same path as sdlc run, its line lands in the step's own commit, and the stop is committed", async (t) => {
  const dir = await makeProject(t);
  mockProbe(t);
  let reads = 0;
  const readNext = () => (reads++ === 0
    ? { state: "run", next: { kind: "sequence", stage: "probe", args: {}, command: "sdlc run probe", why: "checking the runner" }, ready: [], waiting: [], held: [] }
    : { state: "idle", next: null, ready: [], waiting: [], held: [], complete: true });
  const out = quiet();
  let code;
  try { code = await driveProject(dir, { deps: { readNext } }); } finally { out.restore(); }
  assert.equal(code, 0, out.printed.join("\n"));
  assert.ok(existsSync(join(dir, "app", "PROBE.md")), "the stage ran");
  assert.equal(git(["status", "--porcelain"], dir), "", "the tree is clean");
  const subjects = git(["log", "--format=%s", "-3"], dir).split("\n");
  assert.match(subjects[0], /^run\(drive\): stopped after 1 step$/);
  // The step's line was written into the record by the stage's own commit, ahead of the
  // stage's own line.
  const stageCommit = git(["show", "HEAD~1", "--format=", "-U0", "--", ".sdlc/runs"], dir);
  assert.match(stageCommit, /drive: step 1: `sdlc run probe` — checking the runner[\s\S]*run probe/);
  const beat = readFileSync(join(dir, HEARTBEAT), "utf8");
  assert.match(beat, /state: stopped/);
  assert.match(beat, /nothing left to run/);
});

test("the heartbeat reads back as running, stopped, or gone", () => {
  const now = "2026-09-29T10:00:00.000Z";
  assert.match(formatHeartbeat({ state: "running", pid: process.pid, started: now, step: 2, command: "sdlc run contract", stepStarted: now, updated: now }),
    /^drive: running since 2026-09-29T10:00:00.000Z \(process \d+\); step 2: `sdlc run contract`, started 2026-09-29T10:00:00.000Z/);
  assert.match(formatHeartbeat({ state: "stopped", pid: 1, started: now, step: 3, stopped: now, reason: "waiting on a person: tech-lead: contract-v2" }),
    /^drive: stopped at 2026-09-29T10:00:00.000Z after 3 steps — waiting on a person/);
  assert.match(formatHeartbeat({ state: "running", pid: 2 ** 22 + 12345, started: now, step: 1, command: "sdlc run intent", updated: now }),
    /^drive: not running — process \d+ is gone; it was on step 1: `sdlc run intent`/);
  assert.equal(formatHeartbeat(null), "drive: has not run in this project");
});

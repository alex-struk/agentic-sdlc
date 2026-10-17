// A person can hand in a stage's work from a branch: the stage's own outputs are taken from
// that branch in place of an agent session, judged by the stage's own checks and proposed at
// its gate (`docs/decisions/0107`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitOk } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";

const FROM = fileURLToPath(new URL("../fixture-project/fixture.config.yaml", import.meta.url));

const commit = (dir, message) => {
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", message], dir);
};

function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

const PASSING_CHECK = { name: "app", version: "1.0.0", private: true, scripts: { check: "node -e \"\"" } };

// A project with slice 1 planned and an application already on `main`. The agent is the mock
// with no canned reply, so a session asked for anywhere in a run fails it.
async function withProject(t) {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-hand-in-"));
  const prev = { egress: process.env.SDLC_EGRESS_NAMES, executor: process.env.SDLC_EXECUTOR, mock: process.env.SDLC_MOCK_DIR };
  t.after(() => {
    for (const [key, value] of [["SDLC_EGRESS_NAMES", prev.egress], ["SDLC_EXECUTOR", prev.executor], ["SDLC_MOCK_DIR", prev.mock]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(join(tmp, "empty-egress-names.txt"), "");
  process.env.SDLC_EGRESS_NAMES = join(tmp, "empty-egress-names.txt");
  const dir = join(tmp, "permit-intake");
  await newProject({ dir, from: FROM });
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  write(dir, "plan/tasks.md", "# Tasks\n\n### Slice 1 · Submit an application\n- criteria: R-1.1\n\nBuild the submission form.\n");
  write(dir, "app/package.json", `${JSON.stringify(PASSING_CHECK, null, 2)}\n`);
  write(dir, "app/package-lock.json", `${JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "app", version: "1.0.0" } } }, null, 2)}\n`);
  write(dir, "app/old.js", "export const form = \"first\";\n");
  commit(dir, "slice 1 planned and built");
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mkdtempSync(join(tmp, "mock-none-"));
  return dir;
}

// A person's branch off `main`: `change` writes their work, then it is committed and `main`
// is checked out again, as it is when someone hands work in.
function personBranch(dir, name, change) {
  git(["checkout", "-q", "-b", name], dir);
  change();
  commit(dir, `${name}: the person's work`);
  git(["checkout", "-q", "main"], dir);
}

const journalOn = (dir, branch) => {
  const file = git(["ls-tree", "--name-only", branch, ".sdlc/journal/"], dir).split("\n").filter((f) => f.endsWith("-build.md")).at(-1);
  return git(["show", `${branch}:${file}`], dir);
};

test("a hand-in proposes the branch's own outputs at the stage's gate, with no agent session", async (t) => {
  const dir = await withProject(t);
  personBranch(dir, "person/slice-1", () => {
    write(dir, "app/index.js", "export const form = \"submission\";\n");
    write(dir, "docs/decisions/0001-form.md", "# 0001 · The form\n");
    write(dir, "notes-outside-the-stage.md", "Not the build stage's to deliver.\n");
  });
  const r = await runStage(dir, "build", { slice: 1, handIn: "person/slice-1" });
  assert.equal(r.ok, true, JSON.stringify(r.messages ?? r));
  assert.equal(git(["rev-parse", "proposal/build-slice-1:app"], dir), git(["rev-parse", "person/slice-1:app"], dir), "the branch's application, as it is");
  assert.ok(gitOk(["cat-file", "-e", "proposal/build-slice-1:docs/decisions/0001-form.md"], dir), "every output path is taken");
  assert.ok(!gitOk(["cat-file", "-e", "proposal/build-slice-1:notes-outside-the-stage.md"], dir), "nothing outside the stage's outputs");
  assert.match(journalOn(dir, "proposal/build-slice-1"), /Handed in by a person from `person\/slice-1`/);
  assert.match(git(["show", "proposal/build-slice-1:.sdlc/proposals/build-slice-1.md"], dir), /Handed in by a person from `person\/slice-1`/);
  assert.equal(git(["status", "--porcelain"], dir), "");
});

test("a hand-in carries the branch's deletions as well as its additions", async (t) => {
  const dir = await withProject(t);
  personBranch(dir, "person/slice-1", () => {
    rmSync(join(dir, "app/old.js"));
    write(dir, "app/new.js", "export const form = \"second\";\n");
  });
  const r = await runStage(dir, "build", { slice: 1, handIn: "person/slice-1" });
  assert.equal(r.ok, true, JSON.stringify(r.messages ?? r));
  assert.ok(!gitOk(["cat-file", "-e", "proposal/build-slice-1:app/old.js"], dir), "the file the person removed is gone");
  assert.ok(gitOk(["cat-file", "-e", "proposal/build-slice-1:app/new.js"], dir));
});

test("a branch that main has moved past at the stage's outputs is refused, so a hand-in undoes nothing", async (t) => {
  const dir = await withProject(t);
  personBranch(dir, "person/slice-1", () => write(dir, "app/index.js", "export const form = \"submission\";\n"));
  write(dir, "app/old.js", "export const form = \"changed on main\";\n");
  commit(dir, "main moves on");
  await assert.rejects(() => runStage(dir, "build", { slice: 1, handIn: "person/slice-1" }),
    /main has changed app since person\/slice-1 left it/);
  assert.ok(!gitOk(["rev-parse", "--verify", "-q", "proposal/build-slice-1"], dir), "no proposal is opened");
});

test("a branch that does not exist is refused", async (t) => {
  const dir = await withProject(t);
  await assert.rejects(() => runStage(dir, "build", { slice: 1, handIn: "person/nothing-here" }),
    /--hand-in: person\/nothing-here is not a branch or commit in this repository/);
});

test("only a stage with a gate takes a hand-in, and not one that works in the project tree", async (t) => {
  const dir = await withProject(t);
  personBranch(dir, "person/probe", () => write(dir, "PROBE.md", "# Probe\n"));
  await assert.rejects(() => runStage(dir, "probe", { handIn: "person/probe" }), /probe has no gate/);
  await assert.rejects(() => runStage(dir, "intent", { handIn: "person/probe" }), /intent works in the project tree/);
});

test("a hand-in is not also a revision", async (t) => {
  const dir = await withProject(t);
  personBranch(dir, "person/slice-1", () => write(dir, "app/index.js", "export const form = \"submission\";\n"));
  await assert.rejects(() => runStage(dir, "build", { slice: 1, revise: true, handIn: "person/slice-1" }),
    /--hand-in and --revise cannot be used together/);
});

test("handed-in work that fails a check goes back to the person, with no agent asked to repair it", async (t) => {
  const dir = await withProject(t);
  personBranch(dir, "person/slice-1", () => {
    write(dir, "app/package.json", `${JSON.stringify({ ...PASSING_CHECK, scripts: { check: "node -e \"process.exit(1)\"" } }, null, 2)}\n`);
  });
  const r = await runStage(dir, "build", { slice: 1, handIn: "person/slice-1" });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => /no agent repairs handed-in work: correct person\/slice-1 and hand it in again/.test(m)), r.messages.join("\n"));
  assert.ok(!gitOk(["rev-parse", "--verify", "-q", "proposal/build-slice-1"], dir), "no proposal is opened");
  assert.equal(git(["status", "--porcelain"], dir), "", "the branch's files are not left in main's working tree");
});

test("a dry run of a hand-in says what it would take and writes nothing", async (t) => {
  const dir = await withProject(t);
  personBranch(dir, "person/slice-1", () => write(dir, "app/index.js", "export const form = \"submission\";\n"));
  const head = git(["rev-parse", "HEAD"], dir);
  const r = await runStage(dir, "build", { slice: 1, handIn: "person/slice-1", dryRun: true });
  assert.equal(r.ok, true);
  assert.match(r.text, /Handed in by a person from `person\/slice-1`/);
  assert.equal(git(["rev-parse", "HEAD"], dir), head);
  assert.equal(git(["status", "--porcelain"], dir), "");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOk, assertCleanTree, stageAll, enterBranch, leaveBranch, mergeInto } from "../src/lib/git.mjs";
import { copyTree, copyTreeOverwrite, readText } from "../src/lib/fsx.mjs";
import { appendRun, deferRun } from "../src/lib/runrecord.mjs";

test("git wrapper runs and reports", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-git-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "test@example.com"], d);
  git(["config", "user.name", "Test"], d);
  writeFileSync(join(d, ".gitkeep"), "");
  git(["add", "."], d);
  git(["commit", "-q", "-m", "init"], d);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  assert.equal(gitOk(["rev-parse", "--verify", "nope"], d), false);
});

test("a failed git command reports the command and what git said", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-giterr-"));
  git(["init", "-q", "-b", "main"], d);
  assert.throws(() => git(["rev-parse", "--verify", "nope"], d),
    (e) => /git rev-parse --verify nope failed/.test(e.message) && /fatal|Needed a single revision/.test(e.message));
});

test("assertCleanTree names every dirty path", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-dirty-"));
  git(["init", "-q", "-b", "main"], d);
  assert.doesNotThrow(() => assertCleanTree(d, "propose"));
  writeFileSync(join(d, "left-over.txt"), "x");
  assert.throws(() => assertCleanTree(d, "propose"),
    (e) => /^propose: the working tree has uncommitted changes/.test(e.message) && e.message.includes("left-over.txt"));
});

test("stageAll refuses a tracked-then-ignored path by name instead of retrying with -f", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-stageall-ignored-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d);
  git(["config", "user.name", "t"], d);
  mkdirSync(join(d, "secrets"), { recursive: true });
  writeFileSync(join(d, "secrets", "creds.env"), "super-secret\n");
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "oops, committed a secret"], d);
  // The "committed by accident, now excluded" pattern: someone adds the file to
  // .gitignore and untracks it with `git rm --cached`, leaving the file itself in
  // place. Neither step is committed yet — this is the dirty state `stageAll` sees.
  writeFileSync(join(d, ".gitignore"), "secrets/creds.env\n");
  git(["add", ".gitignore"], d);
  git(["commit", "-q", "-m", "add secrets/creds.env to .gitignore"], d);
  git(["rm", "--cached", "-q", "--", "secrets/creds.env"], d);
  const before = git(["status", "--porcelain"], d);

  assert.throws(() => stageAll(d, ["secrets/creds.env"]),
    (e) => /^stageAll: refusing to add/.test(e.message) && e.message.includes("secrets/creds.env"));
  assert.equal(git(["status", "--porcelain"], d), before, "nothing further was staged");
  assert.equal(git(["ls-files", "--", "secrets/creds.env"], d), "", "the file was not force-tracked");
});

test("copyTree copies without overwriting", () => {
  const src = mkdtempSync(join(tmpdir(), "sdlc-src-"));
  const dst = mkdtempSync(join(tmpdir(), "sdlc-dst-"));
  mkdirSync(join(src, "a/b"), { recursive: true });
  writeFileSync(join(src, "a/b/f.txt"), "new");
  writeFileSync(join(dst, "keep.txt"), "old");
  mkdirSync(join(dst, "a/b"), { recursive: true });
  writeFileSync(join(dst, "a/b/f.txt"), "existing");
  copyTree(src, dst);
  assert.equal(readFileSync(join(dst, "a/b/f.txt"), "utf8"), "existing");
  assert.ok(existsSync(join(dst, "keep.txt")));
});

test("copyTreeOverwrite replaces a file that already exists", () => {
  const src = mkdtempSync(join(tmpdir(), "sdlc-src-"));
  const dst = mkdtempSync(join(tmpdir(), "sdlc-dst-"));
  mkdirSync(join(src, "a/b"), { recursive: true });
  writeFileSync(join(src, "a/b/f.txt"), "new");
  writeFileSync(join(dst, "keep.txt"), "old");
  mkdirSync(join(dst, "a/b"), { recursive: true });
  writeFileSync(join(dst, "a/b/f.txt"), "existing");
  copyTreeOverwrite(src, dst);
  assert.equal(readFileSync(join(dst, "a/b/f.txt"), "utf8"), "new");
  assert.ok(existsSync(join(dst, "keep.txt")), "a file the source doesn't carry is left alone");
});

test("run record appends dated lines", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-run-"));
  const p = appendRun(d, "init: installed 2 packs");
  assert.match(readText(p), /^- \d\d:\d\d:\d\d init: installed 2 packs$/m);
  assert.match(p, /\.sdlc\/runs\/\d{4}-\d\d-\d\d\.md$/);
});

// A line recorded inside a stage waits for the stage's own, which can land on a later day
// than the one it happened on; it then says which day it belongs to.
test("a waiting run-record line keeps its own time, and names its day when it is carried into a later one", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-run-deferred-"));
  const then = new Date(2020, 0, 1, 23, 59, 58);
  deferRun(d, `oracle up old: in ${d}/app`, then);
  deferRun(d, "oracle down old");
  const text = readText(appendRun(d, "run contract: ok"));
  const lines = text.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, 3, text);
  // The day is the record file's own (`toISOString`) and the time the line's own, as for any line.
  assert.equal(lines[0], `- ${then.toISOString().slice(0, 10)} ${then.toTimeString().slice(0, 8)} oracle up old: in ./app`);
  assert.match(lines[1], /^- \d\d:\d\d:\d\d oracle down old$/);
  assert.match(lines[2], /^- \d\d:\d\d:\d\d run contract: ok$/);
});

// The record is one line per run outcome, committed and published as `site/runs.*`. The
// line is usually the first line of a stage's own account of itself, so it carries
// whatever that account quoted — a container log, a failing command. The home path below
// is assembled from pieces so this file does not itself carry the shape the egress check
// looks for.
test("a run record line names neither this machine nor more than one line", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-run-redact-"));
  const elsewhere = `/${"home"}/someone/tools`;
  const p = appendRun(d, `verify slice 1: the sandbox did not start.\n  npm error - ${elsewhere}/bin/tsc\n  in ${d}/app`);
  const text = readText(p);
  assert.ok(!text.includes(elsewhere) && !text.includes(d), text);
  assert.match(text, /^- \d\d:\d\d:\d\d verify slice 1: the sandbox did not start\. npm error - ~\/tools\/bin\/tsc in \.\/app$/m);
});

// Borrowing a branch: the pair `sdlc sandbox --from` and `verify` both run on
// (docs/decisions/0016-binding-and-verifying-an-unmerged-proposal.md).
function twoBranchRepo() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-borrow-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "test@example.com"], d);
  git(["config", "user.name", "Test"], d);
  writeFileSync(join(d, "on-main.txt"), "main\n");
  git(["add", "-A"], d); git(["commit", "-q", "-m", "init"], d);
  git(["checkout", "-q", "-b", "side"], d);
  writeFileSync(join(d, "on-side.txt"), "side\n");
  git(["add", "-A"], d); git(["commit", "-q", "-m", "side"], d);
  git(["checkout", "-q", "main"], d);
  return d;
}

test("entering a branch checks it out and reports where HEAD was, and leaving puts it back", () => {
  const d = twoBranchRepo();
  const start = enterBranch(d, "side", "borrow");
  assert.equal(start, "main");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "side");
  assert.ok(existsSync(join(d, "on-side.txt")));
  assert.equal(leaveBranch(d, start), "");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  assert.equal(existsSync(join(d, "on-side.txt")), false);
});

test("a branch that does not exist is named, and nothing is checked out", () => {
  const d = twoBranchRepo();
  assert.throws(() => enterBranch(d, "sideways", "borrow"), /borrow: there is no branch sideways/);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
});

test("a dirty tree is refused before the checkout, since the checkout would carry it across", () => {
  const d = twoBranchRepo();
  writeFileSync(join(d, "on-main.txt"), "edited\n");
  assert.throws(() => enterBranch(d, "side", "borrow"), /borrow: the working tree has uncommitted changes/);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  assert.equal(readFileSync(join(d, "on-main.txt"), "utf8"), "edited\n");
});

test("a tree dirtied on the borrowed branch stays there, and the residue is handed back", () => {
  const d = twoBranchRepo();
  const start = enterBranch(d, "side", "borrow");
  writeFileSync(join(d, "leftover.txt"), "x\n");
  const dirty = leaveBranch(d, start);
  assert.match(dirty, /leftover\.txt/);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "side", "HEAD stays where the residue was made");
});

// `mergeInto` is what lets verify test a proposal against the project's current test rig.
// Its failure shape matters as much as its success: a merge that git declined for a reason
// that is not a conflict must not be reported as a stale proposal, because the remedy for
// the two is different.
test("mergeInto: merges, reports conflicts, and distinguishes a refusal that is not one", (t) => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-mergeinto-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const g = (...a) => git(a, d);
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.org"); g("config", "user.name", "t");
  writeFileSync(join(d, "shared.txt"), "base\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  g("checkout", "-q", "-b", "topic");

  // main moves; topic does not touch the same file, so the merge lands.
  g("checkout", "-q", "main");
  writeFileSync(join(d, "other.txt"), "from main\n");
  g("add", "-A"); g("commit", "-q", "-m", "main moves");
  g("checkout", "-q", "topic");
  const clean = mergeInto(d, "main", "merge: main into topic");
  assert.deepEqual(clean, { ok: true, conflicts: [] });
  assert.equal(readFileSync(join(d, "other.txt"), "utf8"), "from main\n");

  // Already up to date: no second commit.
  const before = git(["rev-parse", "HEAD"], d);
  assert.equal(mergeInto(d, "main", "merge again").ok, true);
  assert.equal(git(["rev-parse", "HEAD"], d), before, "an up-to-date merge writes no commit");

  // A real conflict: named, undone, branch untouched.
  g("checkout", "-q", "main");
  writeFileSync(join(d, "shared.txt"), "main's line\n");
  g("add", "-A"); g("commit", "-q", "-m", "main edits shared");
  g("checkout", "-q", "topic");
  writeFileSync(join(d, "shared.txt"), "topic's line\n");
  g("add", "-A"); g("commit", "-q", "-m", "topic edits shared");
  const tip = git(["rev-parse", "HEAD"], d);
  const conflicted = mergeInto(d, "main", "merge: main into topic");
  assert.equal(conflicted.ok, false);
  assert.deepEqual(conflicted.conflicts, ["shared.txt"]);
  assert.equal(git(["rev-parse", "HEAD"], d), tip, "the branch is exactly as it was");
  assert.equal(git(["status", "--porcelain"], d), "", "nothing is left half-merged");

  // A ref that does not resolve is a failure with NO conflicted path, and git's own
  // reason is carried so the caller can say what actually happened.
  const missing = mergeInto(d, "no-such-ref", "merge: nothing");
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.conflicts, []);
  assert.ok(missing.message, "git's reason is carried, not discarded");
});

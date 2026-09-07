import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOk, assertCleanTree, stageAll } from "../src/lib/git.mjs";
import { copyTree, readText } from "../src/lib/fsx.mjs";
import { appendRun } from "../src/lib/runrecord.mjs";

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

test("run record appends dated lines", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-run-"));
  const p = appendRun(d, "init: installed 2 packs");
  assert.match(readText(p), /^- \d\d:\d\d:\d\d init: installed 2 packs$/m);
  assert.match(p, /\.sdlc\/runs\/\d{4}-\d\d-\d\d\.md$/);
});

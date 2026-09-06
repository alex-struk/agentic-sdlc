import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOk } from "../src/lib/git.mjs";
import { copyTree, writeText, readText } from "../src/lib/fsx.mjs";
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

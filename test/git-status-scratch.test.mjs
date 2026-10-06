// Reading the working tree's status under `main`'s ignore rules writes those rules to a file
// outside the project for the one command, and removes it with the command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCleanTree, changedPaths, porcelainStatus } from "../src/lib/git.mjs";

test("reading the tree's status leaves nothing behind in the temporary directory", (t) => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-status-repo-"));
  const scratch = mkdtempSync(join(tmpdir(), "sdlc-status-scratch-"));
  const prev = process.env.TMPDIR;
  t.after(() => {
    if (prev === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev;
    rmSync(d, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]);
  writeFileSync(join(d, ".gitignore"), "build/\n");
  run(["add", "-A"]);
  run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "start"]);
  mkdirSync(join(d, "build"));
  writeFileSync(join(d, "build", "out.js"), "");

  process.env.TMPDIR = scratch;
  assertCleanTree(d, "check");
  assert.equal(porcelainStatus(d), "", "main's ignore rules were applied");
  assert.deepEqual(changedPaths(d), []);
  assert.deepEqual(readdirSync(scratch), [], "no file or directory is left behind");
});

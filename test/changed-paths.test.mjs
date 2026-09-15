import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths } from "../src/lib/git.mjs";

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-changed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.test"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(join(dir, "README.md"), "start\n");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "start"]);
  return dir;
}

// Git reports a directory it has never tracked as the directory alone unless asked for
// every file. A stage writing a new domain's first tests creates exactly such a directory,
// and every caller filters this list by file name or extension.
test("files in a directory git has never tracked are listed one by one, not as the directory", (t) => {
  const dir = repo(t);
  mkdirSync(join(dir, "tests", "acceptance", "billing"), { recursive: true });
  writeFileSync(join(dir, "tests", "acceptance", "billing", "R-1.1.spec.ts"), "// header\n");
  writeFileSync(join(dir, "tests", "acceptance", "billing", "R-1.2.spec.ts"), "// header\n");
  const paths = changedPaths(dir);
  assert.deepEqual(paths.sort(), ["tests/acceptance/billing/R-1.1.spec.ts", "tests/acceptance/billing/R-1.2.spec.ts"]);
  assert.ok(!paths.some((p) => p.endsWith("/")), "no path is a bare directory");
});

test("an ignored directory stays out of the list however many files it holds", (t) => {
  const dir = repo(t);
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(dir, "README.md"), "changed\n");
  assert.deepEqual(changedPaths(dir), ["README.md"]);
});

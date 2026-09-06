import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { git } from "../src/lib/git.mjs";
import { ensureSources } from "../src/runner/sources.mjs";

// A local git repo standing in for the old application: two commits, so a caller can
// pin `commit` to the first and prove `ensureSources` checks out that one rather than
// whatever HEAD of the clone happens to be.
function makeOldRepo() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-old-repo-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  writeFileSync(join(d, "README.md"), "# old app\n");
  mkdirSync(join(d, "tests"), { recursive: true });
  writeFileSync(join(d, "tests", "old.test.js"), "test();\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "first"], d);
  const first = git(["rev-parse", "HEAD"], d);
  writeFileSync(join(d, "README.md"), "# old app, updated\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "second"], d);
  return { d, first };
}

function makeProject() {
  return mkdtempSync(join(tmpdir(), "sdlc-proj-"));
}

test("ensureSources clones at the pinned commit and removes excluded paths", () => {
  const { d: repo, first } = makeOldRepo();
  const projectDir = makeProject();
  const config = { sources: { old: { repo, commit: first, exclude: ["tests/"] } } };

  const result = ensureSources(projectDir, config);
  const dir = join(projectDir, "sources", "old");
  assert.equal(result.dir, dir);
  assert.equal(result.commit, first);
  assert.equal(git(["rev-parse", "HEAD"], dir), first);
  assert.ok(!existsSync(join(dir, "tests")), "tests/ should have been removed from the working tree");
  assert.ok(existsSync(join(dir, "README.md")));

  const markerPath = join(dir, ".sdlc-sources.json");
  assert.ok(existsSync(markerPath));
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  assert.equal(marker.repo, repo);
  assert.equal(marker.commit, first);
  assert.deepEqual(marker.excluded, ["tests/"]);
  assert.ok(marker.at);
});

test("ensureSources is idempotent: a second call changes nothing", () => {
  const { d: repo, first } = makeOldRepo();
  const projectDir = makeProject();
  const config = { sources: { old: { repo, commit: first, exclude: ["tests/"] } } };

  ensureSources(projectDir, config);
  const dir = join(projectDir, "sources", "old");
  const markerPath = join(dir, ".sdlc-sources.json");
  const mtimeBefore = statSync(markerPath).mtimeMs;

  const result = ensureSources(projectDir, config);
  assert.equal(result.commit, first);
  assert.equal(statSync(markerPath).mtimeMs, mtimeBefore, "marker should not be rewritten on a repeat call");

  // The exclusion is a working-tree removal, not a git operation, so `sources/old`
  // itself is expected to show the deleted file as a local change — that is exactly
  // what makes the exclusion durable across repeat calls without re-cloning.
  // `git()` trims the whole of stdout, which eats the leading space of porcelain's
  // "XY " status prefix along with any outer whitespace — the untrimmed form here would
  // read " D tests/old.test.js".
  const status = git(["status", "--porcelain"], dir);
  assert.equal(status, "D tests/old.test.js");
});

test("ensureSources resolves a relative repo path against projectDir", () => {
  const { d: repo, first } = makeOldRepo();
  const projectDir = makeProject();
  // Put the "repo" beside the project and reference it by a relative path, the way a
  // config.yaml committed alongside a checked-out old-app sibling directory would.
  const relPath = relative(projectDir, repo);
  const config = { sources: { old: { repo: relPath, commit: first, exclude: [] } } };

  const result = ensureSources(projectDir, config);
  assert.equal(git(["rev-parse", "HEAD"], result.dir), first);
});

test("ensureSources throws when config.sources.old is absent", () => {
  const projectDir = makeProject();
  assert.throws(() => ensureSources(projectDir, {}), /no sources\.old in config/);
  assert.throws(() => ensureSources(projectDir, { sources: {} }), /no sources\.old in config/);
});

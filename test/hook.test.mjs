import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const HOOK = new URL("../templates/hooks/implement-guard.sh", import.meta.url).pathname;
function run(path, stage) {
  return spawnSync("bash", [HOOK], { input: JSON.stringify({ tool_input: { file_path: path } }),
    cwd: process.cwd(), env: { ...process.env, PWD: process.cwd(), SDLC_STAGE: stage ?? "" }, encoding: "utf8" });
}

test("build stage cannot edit spec, acceptance tests, constitution or config", () => {
  for (const p of ["spec/spec.md", "tests/acceptance/x.spec.ts", "constitution.md", ".sdlc/config.yaml", ".github/workflows/a.yml"])
    assert.equal(run(p, "build").status, 2, p);
  assert.equal(run("app/src/index.ts", "build").status, 0);
});

test("derive-tests stage cannot see app or adapters", () => {
  assert.equal(run("app/src/index.ts", "derive-tests").status, 2);
  assert.equal(run("tests/adapters/new/a.ts", "derive-tests").status, 2);
  assert.equal(run("tests/acceptance/x.spec.ts", "derive-tests").status, 0);
});

test("spec stages may edit spec but not app or tests", () => {
  assert.equal(run("spec/spec.md", "archaeology").status, 0);
  assert.equal(run("app/x.ts", "archaeology").status, 2);
  assert.equal(run("tests/acceptance/x.ts", "ratify").status, 2);
});

test("unset stage behaves like build", () => {
  assert.equal(run("spec/spec.md", "").status, 2);
});

test("paths are normalised before matching, and paths outside the project are allowed", () => {
  // The guard matches a project-relative path, so every spelling of the same file
  // must reduce to the same one: a leading "./", a "spec/../spec" round trip, and an
  // absolute path inside the project all name spec/spec.md.
  assert.equal(run("./spec/spec.md", "build").status, 2, "./spec/spec.md");
  assert.equal(run("spec/../spec/spec.md", "build").status, 2, "spec/../spec/spec.md");
  assert.equal(run(join(process.cwd(), "spec", "spec.md"), "build").status, 2, "absolute inside the project");
  // Resolving outside the project is allowed: agents legitimately write to temp directories.
  assert.equal(run("/tmp/x/spec/spec.md", "build").status, 0, "/tmp/x/spec/spec.md");
});

test("probe may write inside app/ and nowhere else", () => {
  assert.equal(run("app/PROBE.md", "probe").status, 0);
  for (const p of ["spec/spec.md", "tests/acceptance/x.spec.ts", "constitution.md", ".sdlc/journal/001-probe.md", "README.md"])
    assert.equal(run(p, "probe").status, 2, p);
});

test("rule blocks every path: a ruling turn reads and answers, it does not write", () => {
  for (const p of ["app/x.ts", "spec/spec.md", ".sdlc/gates/p1.yaml", "README.md"])
    assert.equal(run(p, "rule").status, 2, p);
});

test("an unknown stage blocks everything and names the guard table", () => {
  const r = run("app/x.ts", "not-a-stage");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown stage 'not-a-stage'; add it to the guard table/);
  assert.equal(run("README.md", "not-a-stage").status, 2);
});

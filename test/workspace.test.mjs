import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { materialise, collect } from "../src/runner/workspace.mjs";

function makeProject() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-proj-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, "spec"), { recursive: true });
  writeFileSync(join(d, "spec/spec.md"), "# spec\n");
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, "app/secret.ts"), "export const secret = 1;\n");
  mkdirSync(join(d, "tests/seed"), { recursive: true });
  writeFileSync(join(d, "tests/seed/s.sql"), "select 1;\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

test("materialise spec-only yields a workspace with spec and seed, no app", () => {
  const d = makeProject();
  const ws = materialise(d, "spec-only");
  assert.ok(existsSync(join(ws.dir, "spec/spec.md")));
  assert.ok(existsSync(join(ws.dir, "tests/seed/s.sql")));
  assert.ok(!existsSync(join(ws.dir, "app")));
  ws.cleanup();
});

test("materialise spec-only creates an empty tests/acceptance dir", () => {
  const d = makeProject();
  const ws = materialise(d, "spec-only");
  assert.ok(existsSync(join(ws.dir, "tests/acceptance")));
  ws.cleanup();
});

test("collect copies tests/acceptance back into the project", () => {
  const d = makeProject();
  const ws = materialise(d, "spec-only");
  mkdirSync(join(ws.dir, "tests/acceptance"), { recursive: true });
  writeFileSync(join(ws.dir, "tests/acceptance/a.spec.ts"), "test('x', () => {});\n");
  collect(d, ws.dir, ["tests/acceptance"]);
  assert.ok(existsSync(join(d, "tests/acceptance/a.spec.ts")));
  assert.equal(
    readFileSync(join(d, "tests/acceptance/a.spec.ts"), "utf8"),
    "test('x', () => {});\n",
  );
  ws.cleanup();
});

test("cleanup removes the temp workspace directory", () => {
  const d = makeProject();
  const ws = materialise(d, "spec-only");
  const wsDir = ws.dir;
  ws.cleanup();
  assert.ok(!existsSync(wsDir));
});

test("materialise project mode returns the project dir with a no-op cleanup", () => {
  const d = makeProject();
  const ws = materialise(d, "project");
  assert.equal(ws.dir, d);
  assert.doesNotThrow(() => ws.cleanup());
  assert.ok(existsSync(d), "cleanup did not remove the project dir");
});

test("materialise throws on an unknown mode", () => {
  const d = makeProject();
  assert.throws(() => materialise(d, "nope"), /unknown workspace mode/);
});

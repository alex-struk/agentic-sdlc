import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { materialise, collect, HARNESS } from "../src/runner/workspace.mjs";

function makeOldRepo() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-old-repo-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  writeFileSync(join(d, "README.md"), "# old app\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "first"], d);
  return { d, sha: git(["rev-parse", "HEAD"], d) };
}

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

test("collect overwrites a file that already exists in the project — the workspace's edit wins", () => {
  const d = makeProject();
  const ws = materialise(d, "spec-only");
  // The project's own scaffold already carries this file (the way `tests/acceptance/
  // not-testable.yaml` ships in every project); the workspace, archived from the same
  // commit, starts with an identical copy — then an agent turn rewrites it in the
  // workspace, and that rewrite has to survive being collected back.
  mkdirSync(join(d, "tests/acceptance"), { recursive: true });
  writeFileSync(join(d, "tests/acceptance/not-testable.yaml"), "criteria: []\n");
  mkdirSync(join(ws.dir, "tests/acceptance"), { recursive: true });
  writeFileSync(join(ws.dir, "tests/acceptance/not-testable.yaml"), "criteria:\n  - { id: R-1.1, reason: x }\n");
  collect(d, ws.dir, ["tests/acceptance"]);
  assert.equal(readFileSync(join(d, "tests/acceptance/not-testable.yaml"), "utf8"), "criteria:\n  - { id: R-1.1, reason: x }\n");
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

function makeAppOnlyProject() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-proj-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, "app/secret.ts"), "export const secret = 1;\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

test("materialise spec-only on a project with only app/ yields a workspace without app/", () => {
  const d = makeAppOnlyProject();
  const ws = materialise(d, "spec-only");
  assert.ok(!existsSync(join(ws.dir, "app")));
  ws.cleanup();
});

function makeBlindAdapterProject() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-proj-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, "spec/contract"), { recursive: true });
  writeFileSync(join(d, "spec/contract/c.md"), "# contract\n");
  writeFileSync(join(d, "spec/spec.md"), "# spec\n");
  mkdirSync(join(d, "tests/adapters"), { recursive: true });
  writeFileSync(join(d, "tests/adapters/a.mjs"), "export default {};\n");
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, "app/secret.ts"), "export const secret = 1;\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

test("materialise blind-adapter yields spec/contract and tests/adapters, not spec.md or app", () => {
  const d = makeBlindAdapterProject();
  const ws = materialise(d, "blind-adapter");
  assert.ok(existsSync(join(ws.dir, "spec/contract/c.md")));
  assert.ok(existsSync(join(ws.dir, "tests/adapters/a.mjs")));
  assert.ok(!existsSync(join(ws.dir, "spec/spec.md")));
  assert.ok(!existsSync(join(ws.dir, "app")));
  ws.cleanup();
});

test("HARNESS lists exactly the pipeline-owned harness paths, in order", () => {
  assert.deepEqual(HARNESS, [
    "tests/package.json",
    "tests/tsconfig.json",
    "tests/playwright.config.ts",
    "tests/README.md",
    "tests/fixtures",
    "tests/generated",
  ]);
});

function makeHarnessProject() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-harness-proj-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, "spec/contract"), { recursive: true });
  writeFileSync(join(d, "spec/contract/c.md"), "# contract\n");
  writeFileSync(join(d, "spec/spec.md"), "# spec\n");
  mkdirSync(join(d, "tests/fixtures"), { recursive: true });
  writeFileSync(join(d, "tests/fixtures/index.ts"), "export const test = 1;\n");
  mkdirSync(join(d, "tests/generated"), { recursive: true });
  writeFileSync(join(d, "tests/generated/seed.ts"), "export const seed = {};\n");
  mkdirSync(join(d, "tests/adapters/new"), { recursive: true });
  writeFileSync(join(d, "tests/adapters/new/index.ts"), "export default {};\n");
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, "app/secret.ts"), "export const secret = 1;\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

test("materialise spec-only carries the harness (tests/fixtures, tests/generated) but not tests/adapters", () => {
  const d = makeHarnessProject();
  const ws = materialise(d, "spec-only");
  assert.ok(existsSync(join(ws.dir, "tests/fixtures/index.ts")));
  assert.ok(existsSync(join(ws.dir, "tests/generated/seed.ts")));
  assert.ok(!existsSync(join(ws.dir, "tests/adapters")));
  ws.cleanup();
});

test("materialise blind-adapter carries the harness (tests/fixtures) and tests/adapters but not tests/acceptance", () => {
  const d = makeHarnessProject();
  const ws = materialise(d, "blind-adapter");
  assert.ok(existsSync(join(ws.dir, "tests/fixtures/index.ts")));
  assert.ok(existsSync(join(ws.dir, "tests/adapters/new/index.ts")));
  assert.ok(!existsSync(join(ws.dir, "tests/acceptance")));
  ws.cleanup();
});

test("materialise with-sources loads the config, ensures the old app is checked out, and returns the project dir", () => {
  const d = makeProject();
  const { d: oldRepo, sha } = makeOldRepo();
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "config.yaml"), `
pipeline: { repo: agentic-sdlc, ref: v0.1.0 }
profile: rebuild
stack: openshift-ts
project:
  name: example-service
  domains: [accounts]
sources:
  old: { repo: ${oldRepo}, commit: ${sha} }
policy:
  gates:
    G0: { holder: "agent:product-owner" }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: "agent:architect" }
    G3: { holder: "agent:reviewer" }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills:
  packs: []
egress:
  rules: [E-1, E-2, E-3, E-4]
`);

  const ws = materialise(d, "with-sources");
  assert.equal(ws.dir, d);
  assert.equal(ws.mode, "with-sources");
  assert.ok(existsSync(join(d, "sources", "old", "README.md")));
  assert.equal(git(["rev-parse", "HEAD"], join(d, "sources", "old")), sha);
  assert.doesNotThrow(() => ws.cleanup());
  assert.ok(existsSync(d), "cleanup did not remove the project dir");
});

test("materialise spec-only never carries .sdlc/config.yaml into the workspace", () => {
  const d = makeProject();
  // The project's config names the old application's repository and commit. Nothing on
  // the derive-tests path reads it from the workspace — `prepare` generates types from
  // `spec/contract` and `tests/seed/manifest.yaml`, and the prompt is built from `ctx`
  // in the project — so a blind session is never given it to read.
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), "sources:\n  old: { repo: https://example.org/old.git, commit: 0123abc }\n");
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "config"], d);

  const ws = materialise(d, "spec-only");
  assert.ok(!existsSync(join(ws.dir, ".sdlc/config.yaml")));
  assert.ok(!existsSync(join(ws.dir, ".sdlc")));
  // The paths the stage does need are still there.
  assert.ok(existsSync(join(ws.dir, "spec/spec.md")));
  assert.ok(existsSync(join(ws.dir, "tests/seed/s.sql")));
  ws.cleanup();
});

test("materialise blind-adapter never carries .sdlc/config.yaml either", () => {
  const d = makeProject();
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), "sources:\n  old: { repo: https://example.org/old.git, commit: 0123abc }\n");
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "config"], d);
  const ws = materialise(d, "blind-adapter");
  assert.ok(!existsSync(join(ws.dir, ".sdlc/config.yaml")));
  ws.cleanup();
});

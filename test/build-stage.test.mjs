import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readSlice, buildProposals, specFilesFor } from "../src/stages/slices.mjs";
import { MODES } from "../src/runner/workspace.mjs";

const TASKS = `# Tasks

### Slice 1 · Sign in and see your profile
- criteria: R-4.1, R-4.2
- depends on: nothing

Build the sign-in flow.

### Slice 2 · Browse opportunities
- criteria: R-1.1

Show the list.
`;

function project(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-slices-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  mkdirSync(join(d, "plan"), { recursive: true });
  writeFileSync(join(d, "plan", "tasks.md"), TASKS);
  return d;
}

test("a slice is read with its criteria and its own text, and an unknown one is null", (t) => {
  const d = project(t);
  const s = readSlice(d, 1);
  assert.equal(s.title, "Sign in and see your profile");
  assert.deepEqual(s.criteria, ["R-4.1", "R-4.2"]);
  assert.match(s.body, /Build the sign-in flow\./);
  assert.doesNotMatch(s.body, /Browse opportunities/);
  assert.equal(readSlice(d, 9), null);
});

test("a slice's proposals are listed newest first", (t) => {
  const d = project(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "--allow-empty", "-m", "x"]);
  for (const b of ["build-slice-1", "build-slice-1-2", "build-slice-1-3", "build-slice-12"]) run(["branch", `proposal/${b}`]);
  assert.deepEqual(buildProposals(d, 1), ["build-slice-1-3", "build-slice-1-2", "build-slice-1"]);
});

test("the spec files for a slice's criteria are found wherever their domain keeps them", (t) => {
  const d = project(t);
  mkdirSync(join(d, "tests", "acceptance", "users"), { recursive: true });
  writeFileSync(join(d, "tests", "acceptance", "users", "R-4.2.spec.ts"), "");
  assert.deepEqual(specFilesFor(d, ["R-4.1", "R-4.2"]), ["tests/acceptance/users/R-4.2.spec.ts"]);
});

// A builder that can read the acceptance suite writes code to pass the tests instead of code
// that does what the criteria say (spec §5.10).
test("the build workspace carries the spec, the design and the app, and never the suite or its bindings", () => {
  const paths = MODES.build;
  for (const p of ["app", "plan", "spec", "design", "docs/decisions", "tests/seed", "constitution.md", ".claude/skills"])
    assert.ok(paths.includes(p), p);
  for (const p of paths) assert.ok(!/^tests\/(acceptance|adapters|results)|^sources/.test(p), `${p} must not be in a build workspace`);
});

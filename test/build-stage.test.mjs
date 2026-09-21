import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readSlice, buildProposals, specFilesFor } from "../src/stages/slices.mjs";
import { MODES } from "../src/runner/workspace.mjs";
import { build, checkBuildScope, appCheck } from "../src/stages/build.mjs";

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
  const paths = [...MODES.build, ...build.collect];
  for (const p of ["app", "plan", "spec", "design", "docs/decisions", "tests/seed", "constitution.md", ".claude/skills"])
    assert.ok(paths.includes(p), p);
  for (const p of paths) assert.ok(!/^tests\/(acceptance|adapters|results)|^sources/.test(p), `${p} must not be in a build workspace`);
});

function gitProject(t) {
  const d = project(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]);
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, "app", "README.md"), "app\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "start"]);
  return d;
}

test("a build run is refused without a slice, or with one the plan does not have", (t) => {
  const d = gitProject(t);
  assert.equal(build.preChecks(d, {}).find((c) => !c.ok).messages[0], "build needs --slice <n>");
  assert.match(build.preChecks(d, { slice: 9 }).find((c) => !c.ok).messages[0], /plan\/tasks\.md has no slice 9/);
  assert.ok(build.preChecks(d, { slice: 1 }).every((c) => c.ok));
});

test("the prompt carries the slice's own text and criteria, and nothing of another slice", (t) => {
  const d = gitProject(t);
  const ctx = { slice: 1, config: { targets: { new: { base_url: "http://localhost:8080", identity: "sandbox-idp" } }, project: { name: "p" } } };
  build.preChecks(d, ctx);
  const p = build.prompt(ctx);
  assert.match(p, /Slice 1 · Sign in and see your profile/);
  assert.match(p, /R-4\.1, R-4\.2/);
  assert.doesNotMatch(p, /Browse opportunities/);
  // The build workspace has no `.sdlc/config.yaml`, so an instruction naming a value out
  // of it is one the builder has to guess at. The address is stated here instead.
  assert.match(p, /must answer at http:\/\/localhost:8080/);
  assert.match(p, /No other service in that file may take that port/);
  assert.doesNotMatch(p, /depends_on/, "a target that declares no dependency adds nothing to the prompt");

  // The addresses a target says it cannot be used without are substituted the same way and
  // for the same reason: `sandbox up` waits for every one of them, and the workspace has no
  // configuration file to read them out of.
  const withDeps = { slice: 1, config: { project: { name: "p" }, targets: { new: { base_url: "http://localhost:8080", identity: "sandbox-idp", depends_on: { identity: "http://localhost:8081/realms/sandbox" } } } } };
  build.preChecks(d, withDeps);
  const q = build.prompt(withDeps);
  assert.match(q, /identity at http:\/\/localhost:8081\/realms\/sandbox/);
  assert.match(q, /the run stops where one does not answer/);
  assert.doesNotMatch(q, /depends_on/, "the addresses are stated, not the key they came from");
});

test("a build may change the application and add decision records, and nothing else", (t) => {
  const d = gitProject(t);
  writeFileSync(join(d, "app", "index.ts"), "export {};\n");
  mkdirSync(join(d, "docs", "decisions"), { recursive: true });
  writeFileSync(join(d, "docs", "decisions", "0001-x.md"), "# x\n");
  assert.equal(checkBuildScope(d).ok, true);
  mkdirSync(join(d, "tests", "acceptance", "users"), { recursive: true });
  writeFileSync(join(d, "tests", "acceptance", "users", "R-4.1.spec.ts"), "");
  writeFileSync(join(d, "plan", "tasks.md"), "changed\n");
  const r = checkBuildScope(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("tests/acceptance/users/R-4.1.spec.ts")));
  assert.ok(r.messages.some((m) => m.includes("plan/tasks.md")));
});

test("the application's own check is run by the runner, and its failure carries the output", (t) => {
  const d = gitProject(t);
  const calls = [];
  const fail = (cmd, args) => { calls.push([cmd, ...args].join(" ")); return args.includes("check") ? { status: 1, stdout: "", stderr: "src/a.ts(1,1): error TS2304" } : { status: 0, stdout: "", stderr: "" }; };
  writeFileSync(join(d, "app", "package.json"), JSON.stringify({ scripts: { check: "tsc --noEmit" } }));
  const r = appCheck(d, { exec: fail });
  assert.equal(r.ok, false);
  assert.match(r.messages.join("\n"), /error TS2304/);
  assert.ok(calls.some((c) => c === "npm --prefix app install --no-audit --no-fund"));
  assert.ok(calls.some((c) => c === "npm --prefix app run check"));
});

test("an application with no check script fails, naming the script the stack requires", (t) => {
  const d = gitProject(t);
  writeFileSync(join(d, "app", "package.json"), JSON.stringify({ scripts: {} }));
  const r = appCheck(d, { exec: () => ({ status: 0, stdout: "", stderr: "" }) });
  assert.equal(r.ok, false);
  assert.match(r.messages[0], /app\/package\.json has no "check" script/);
});

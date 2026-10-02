import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readSlice, buildProposals, buildBranches, bindingBranch, specFilesFor } from "../src/stages/slices.mjs";
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

// A repository with `proposal/<name>` for each name, and a gate file on each of `ruled`. A
// name in `retired` is ruled and its branch renamed to `returned/<name>`, as a build
// revision's pre-check leaves it.
function withProposals(t, names, ruled = [], retired = []) {
  const d = project(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  const commit = (m) => run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "--allow-empty", "-m", m]);
  run(["init", "-q", "-b", "main"]); run(["add", "-A"]); commit("x");
  for (const b of names) {
    run(["branch", `proposal/${b}`]);
    if (!ruled.includes(b) && !retired.includes(b)) continue;
    run(["checkout", "-q", `proposal/${b}`]);
    mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
    writeFileSync(join(d, ".sdlc", "gates", `${b}.yaml`), "verdict: return\n");
    run(["add", "-A"]); commit("ruled");
    run(["checkout", "-q", "main"]);
    if (retired.includes(b)) run(["branch", "-m", `proposal/${b}`, `returned/${b}`]);
  }
  return d;
}

test("a binding of the new target runs against the newest open build proposal of the slice its entries name", (t) => {
  const d = withProposals(t, ["build-slice-1", "build-slice-1-2", "build-slice-2"], ["build-slice-1"]);
  assert.deepEqual(bindingBranch(d, [{ id: "R-4.1", slice: 1 }]), { branch: "proposal/build-slice-1-2" });
  // An entry that names no slice belongs to the slice that claims its criterion.
  assert.deepEqual(bindingBranch(d, [{ id: "R-1.1" }]), { branch: "proposal/build-slice-2" });
});

test("a binding of the new target with no one branch to start from says why", (t) => {
  const d = withProposals(t, ["build-slice-1", "build-slice-2"], ["build-slice-1"]);
  const none = withProposals(t, ["build-slice-2"]);
  assert.match(bindingBranch(none, [{ id: "R-4.1", slice: 1 }]).why, /^no build proposal for slice 1$/);
  assert.match(bindingBranch(d, [{ id: "R-9.9" }]).why, /no slice in plan\/tasks\.md claims/);
  const ruled = withProposals(t, ["build-slice-1", "build-slice-2"], ["build-slice-1", "build-slice-2"]);
  assert.match(bindingBranch(ruled, [{ id: "R-4.1", slice: 1 }, { id: "R-1.1", slice: 2 }]).why,
    /^no build proposal is open for slices 1, 2, and slices 1, 2 each have a ruled one \(proposal\/build-slice-1, proposal\/build-slice-2\); which of them to bind against is a person's call$/);
  const both = withProposals(t, ["build-slice-1", "build-slice-2"]);
  assert.match(bindingBranch(both, [{ id: "R-4.1", slice: 1 }, { id: "R-1.1", slice: 2 }]).why, /slices 1, 2 each have an open build proposal/);
  // With nothing owed, the one open build proposal in the plan is the application to bind.
  assert.deepEqual(bindingBranch(d, []), { branch: "proposal/build-slice-2" });
});

// A verify that returns a build leaves no build proposal open, and what it found unbound is
// still about the application that build carries (`docs/decisions/0080`).
test("a slice's build branches are read under proposal/ and returned/, newest first, with which is open", (t) => {
  const d = withProposals(t, ["build-slice-1", "build-slice-1-2", "build-slice-1-3", "build-slice-12"], ["build-slice-1-2"], ["build-slice-1"]);
  assert.deepEqual(buildBranches(d, 1), [
    { branch: "proposal/build-slice-1-3", name: "build-slice-1-3", open: true },
    { branch: "proposal/build-slice-1-2", name: "build-slice-1-2", open: false },
    { branch: "returned/build-slice-1", name: "build-slice-1", open: false },
  ]);
});

test("with no build proposal of its slice open, a binding runs against the newest whatever its state", (t) => {
  // Returned by verify, and not yet renamed by build --revise.
  const returned = withProposals(t, ["build-slice-1", "build-slice-1-2"], ["build-slice-1-2"], ["build-slice-1"]);
  assert.deepEqual(bindingBranch(returned, [{ id: "R-4.1", slice: 1 }]), { branch: "proposal/build-slice-1-2" });
  // Renamed to returned/<name> by build --revise's pre-check, newest by proposal number.
  const retired = withProposals(t, ["build-slice-1-9", "build-slice-1-10"], [], ["build-slice-1-9", "build-slice-1-10"]);
  assert.deepEqual(bindingBranch(retired, [{ id: "R-4.1", slice: 1 }]), { branch: "returned/build-slice-1-10" });
  // An open proposal is preferred over a newer-numbered returned one.
  const both = withProposals(t, ["build-slice-1-2", "build-slice-1-3"], [], ["build-slice-1-3"]);
  assert.deepEqual(bindingBranch(both, [{ id: "R-4.1", slice: 1 }]), { branch: "proposal/build-slice-1-2" });
  // With nothing owed — a revision whose entries are spent — the newest build of the slice
  // furthest on in the plan that has one.
  const plan = withProposals(t, ["build-slice-1", "build-slice-2-3", "build-slice-2-4"], [], ["build-slice-1", "build-slice-2-3", "build-slice-2-4"]);
  assert.deepEqual(bindingBranch(plan, []), { branch: "returned/build-slice-2-4" });
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

test("build --revise: no proposal at all for the slice reads as no returned ruling", (t) => {
  const d = gitProject(t);
  const fail = build.preChecks(d, { slice: 1, revise: true }).find((c) => !c.ok);
  assert.equal(fail.messages[0], "build --revise: no returned ruling for slice 1 to revise from");
});

// The obstacle here is not the same as "no returned ruling": a proposal for this slice
// exists and is sitting open at G3, waiting on a ruling nobody has given it yet. The
// operator's next step is to rule it, not to produce a return from nothing, so the
// pre-check has to say which situation this is rather than conflating the two.
test("build --revise: an open, unruled proposal for the slice is named as pending a ruling, not as a missing one", (t) => {
  const d = gitProject(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["branch", "proposal/build-slice-1"]);
  const fail = build.preChecks(d, { slice: 1, revise: true }).find((c) => !c.ok);
  assert.equal(fail.messages[0], "build --revise: proposal build-slice-1 is open and awaiting a ruling at G3; rule it (or delete the branch), then revise slice 1 again");
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

// A prompt that lists the criteria a slice is answerable for and then, lower down, carries a
// condition asking for one of them to be moved off the slice, asks the builder for two
// incompatible things. It did the second — in `plan/`, which no build collects — and the
// work was dropped while the proposal page reported it done.
test("the criteria a build is answerable for are named with the file that assigns them, and that file is not the build's", () => {
  const prompt = build.prompt({
    slice: 2,
    buildSlice: { number: 2, title: "Second", body: "### Slice 2\n", criteria: ["R-1.1", "R-2.4"] },
    config: { project: { name: "permit-intake" }, targets: { new: { base_url: "http://localhost:3000" } } },
  });
  assert.match(prompt, /as plan\/tasks\.md assigns them to slice 2: R-1\.1, R-2\.4/);
  assert.match(prompt, /which this workspace carries for reading and does not deliver/);
  assert.match(prompt, /say which and why in your journal entry/);
});

// The pre-check moves a returned proposal to returned/<name> and records the return on main
// before the builder runs. A run stopped after that leaves the return recorded and unanswered,
// and the next revision takes it up from returned/<name> rather than finding nothing.
test("build --revise takes up a return an interrupted revision recorded and never answered", (t) => {
  const d = gitProject(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  const gate = "gate: G3\nverdict: return\nby: runner:verify\nconditions:\n  - \"R-4.1: the heading reads Sign on\"\n";
  run(["checkout", "-q", "-b", "returned/build-slice-1-2"]);
  mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "gates", "build-slice-1-2.yaml"), gate);
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "returned"]);
  run(["checkout", "-q", "main"]);
  mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "gates", "build-slice-1-2.yaml"), gate);
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "record(G3): build-slice-1-2 returned"]);
  const head = execFileSync("git", ["rev-parse", "main"], { cwd: d, encoding: "utf8" });
  const ctx = { slice: 1, revise: true };
  assert.ok(build.preChecks(d, ctx).every((c) => c.ok), "the unanswered return is revised from");
  assert.equal(ctx.revision.name, "build-slice-1-2");
  assert.match(JSON.stringify(ctx.revision.conditions ?? ctx.revision), /Sign on/);
  assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: d, encoding: "utf8" }), head, "the return is not recorded a second time");
});

test("a return a revision has already answered is not taken up again", (t) => {
  const d = gitProject(t);
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  const gate = "gate: G3\nverdict: return\nby: runner:verify\n";
  run(["checkout", "-q", "-b", "returned/build-slice-1-2"]);
  mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "gates", "build-slice-1-2.yaml"), gate);
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "returned"]);
  run(["checkout", "-q", "main"]);
  mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "gates", "build-slice-1-2.yaml"), gate);
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "record"]);
  run(["branch", "proposal/build-slice-1-3"]);
  const fail = build.preChecks(d, { slice: 1, revise: true }).find((c) => !c.ok);
  assert.match(fail.messages[0], /build-slice-1-3 is open and awaiting a ruling/);
});

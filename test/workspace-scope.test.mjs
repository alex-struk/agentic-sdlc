import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { registerStage, STAGES_BY_NAME } from "../src/stages/registry.mjs";
import {
  IN_PLACE_MODES, MODES, coveredBy, materialise, sealedPathsFor, workspaceScopeNote, workspaceScopeViolations,
} from "../src/runner/workspace.mjs";

const PROBE_SKILL = new URL("../src/stages/skills/probe.md", import.meta.url).pathname;
const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;

async function makeProject(tmp) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  const dir = join(tmp, "permit-intake");
  await newProject({ dir, from: FROM });
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "fill constitution"], dir);
  return { dir, prevEgress };
}

function restoreEgress(prev) {
  if (prev === undefined) delete process.env.SDLC_EGRESS_NAMES;
  else process.env.SDLC_EGRESS_NAMES = prev;
}

function gitProject() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-scope-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d);
  git(["config", "user.name", "t"], d);
  mkdirSync(join(d, "spec"), { recursive: true });
  writeFileSync(join(d, "spec/spec.md"), "# spec\n");
  mkdirSync(join(d, "plan"), { recursive: true });
  writeFileSync(join(d, "plan/tasks.md"), "### Slice 1\n");
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, "app/main.ts"), "export const x = 1;\n");
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "init"], d);
  return d;
}

// ---------------------------------------------------------------------------
// The declaration: context is read, collect is written, and nothing is both.
// ---------------------------------------------------------------------------

test("a stage that is handed a path as context and also collects it is refused", () => {
  const messages = workspaceScopeViolations("some-stage", "build", ["app", "plan"]);
  assert.equal(messages.length, 1, messages.join("\n"));
  assert.match(messages[0], /plan is declared both as workspace build's read-only context and as this stage's own output/);
});

test("a context path sitting inside a collected tree is refused, since the whole tree is copied back", () => {
  const messages = workspaceScopeViolations("some-stage", "blind-adapter", ["spec"]);
  assert.ok(messages.some((m) => /offers spec\/contract as read-only context inside spec/.test(m)), messages.join("\n"));
});

test("a collect path is refused when it could reach outside the workspace", () => {
  assert.match(workspaceScopeViolations("s", "build", ["../elsewhere"])[0], /is not a path inside the workspace/);
  assert.match(workspaceScopeViolations("s", "build", ["/etc"])[0], /is not a path inside the workspace/);
});

test("a stage working in the project directory collects nothing, and saying otherwise is refused", () => {
  assert.match(workspaceScopeViolations("s", "project", ["app"])[0],
    /works in the project directory, so its collect list \(app\) names work nothing carries anywhere/);
  assert.deepEqual(workspaceScopeViolations("s", "project", []), []);
});

test("an unknown workspace mode is refused by name", () => {
  assert.match(workspaceScopeViolations("s", "nope", [])[0], /unknown workspace mode: nope/);
});

// This is the sweep the observed defect would have failed: `build` carried `plan` as a
// path its agent could write and its `collect` never took back. Every stage is swept, not
// just the ones a test remembers to name, so a stage added later is caught here too.
test("every stage in the registry declares a workspace it can deliver", () => {
  const found = [];
  for (const [name, stage] of Object.entries(STAGES_BY_NAME)) {
    if (typeof stage.workspace === "function") continue;
    const collect = typeof stage.collect === "function" ? stage.collect({}) : (stage.collect ?? []);
    found.push(...workspaceScopeViolations(name, stage.workspace, collect));
  }
  assert.deepEqual(found, []);
});

// The inverse of the defect: a path a stage delivers that its workspace never held. The
// stage would then write over the project with a tree it had not read — whatever it did
// not happen to rewrite stays behind, and the result is a mixture nobody authored.
test("every stage's collect set is materialised into its workspace", () => {
  const missing = [];
  for (const [name, stage] of Object.entries(STAGES_BY_NAME)) {
    if (typeof stage.workspace === "function" || MODES[stage.workspace] === null) continue;
    const collect = typeof stage.collect === "function" ? stage.collect({}) : (stage.collect ?? []);
    const declared = [...MODES[stage.workspace], ...collect];
    for (const p of collect) if (!coveredBy(declared, p)) missing.push(`${name}: ${p}`);
  }
  assert.deepEqual(missing, []);
});

test("the sealed set is the mode's context minus whatever the stage collects", () => {
  assert.deepEqual(sealedPathsFor("build", ["app", "docs/decisions"]), MODES.build);
  assert.deepEqual(sealedPathsFor("plan", ["spec", "design", "plan"]), ["constitution.md", ".claude/skills"]);
});

test("no stage in an ephemeral workspace is left with nothing sealed and nothing collected", () => {
  for (const [name, stage] of Object.entries(STAGES_BY_NAME)) {
    if (typeof stage.workspace === "function" || IN_PLACE_MODES.has(stage.workspace)) continue;
    const collect = typeof stage.collect === "function" ? stage.collect({}) : (stage.collect ?? []);
    assert.ok(collect.length > 0, `${name} runs an agent in a temporary workspace and delivers nothing out of it`);
  }
});

// ---------------------------------------------------------------------------
// The seal: a change where the stage cannot deliver is found, not discarded.
// ---------------------------------------------------------------------------

test("a workspace seals what it will not collect, and names every path an agent changed there", () => {
  const d = gitProject();
  const ws = materialise(d, "build", { collect: ["app"] });
  assert.deepEqual(ws.sealed, MODES.build);
  ws.seal();
  assert.deepEqual(ws.drift(), []);
  writeFileSync(join(ws.dir, "app/main.ts"), "export const x = 2;\n");
  assert.deepEqual(ws.drift(), [], "a change in a collected path is delivered, not drift");
  writeFileSync(join(ws.dir, "plan/tasks.md"), "### Slice 1 · moved\n");
  writeFileSync(join(ws.dir, "spec/added.md"), "new\n");
  assert.deepEqual(ws.drift(), ["plan/tasks.md", "spec/added.md"]);
  ws.cleanup();
});

test("a workspace that was never sealed reports no drift, rather than reporting everything", () => {
  const d = gitProject();
  const ws = materialise(d, "build", { collect: ["app"] });
  writeFileSync(join(ws.dir, "plan/tasks.md"), "### Slice 1 · moved\n");
  assert.deepEqual(ws.drift(), []);
  ws.cleanup();
});

// A run that narrows what it delivers still reads the whole tree, and the parts it cannot
// deliver are what the seal is for: `derive-tests --revise` takes one domain out of a suite
// whose siblings and shared bookkeeping files are in front of it the whole time.
test("a run that adds context keeps the tree readable and seals everything in it it will not deliver", () => {
  const d = gitProject();
  mkdirSync(join(d, "tests/acceptance/one"), { recursive: true });
  writeFileSync(join(d, "tests/acceptance/one/a.spec.ts"), "test('one');\n");
  mkdirSync(join(d, "tests/acceptance/two"), { recursive: true });
  writeFileSync(join(d, "tests/acceptance/two/b.spec.ts"), "test('two');\n");
  writeFileSync(join(d, "tests/acceptance/shared.yaml"), "criteria: []\n");
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "suite"], d);

  const ws = materialise(d, "spec-only", { collect: ["tests/acceptance/one"], context: ["tests/acceptance"] });
  assert.ok(ws.sealed.includes("tests/acceptance"));
  assert.ok(existsSync(join(ws.dir, "tests/acceptance/two/b.spec.ts")), "a sibling is still readable");
  ws.seal();
  writeFileSync(join(ws.dir, "tests/acceptance/one/a.spec.ts"), "test('one, revised');\n");
  assert.deepEqual(ws.drift(), [], "the domain under revision is collected, so its edits are delivered");
  writeFileSync(join(ws.dir, "tests/acceptance/two/b.spec.ts"), "test('two, meddled with');\n");
  writeFileSync(join(ws.dir, "tests/acceptance/shared.yaml"), "criteria: [{ id: X }]\n");
  assert.deepEqual(ws.drift(), ["tests/acceptance/shared.yaml", "tests/acceptance/two/b.spec.ts"]);
  ws.cleanup();
});

test("a collected path is archived into the workspace even when the mode never names it", () => {
  const d = gitProject();
  const ws = materialise(d, "plan", { collect: ["plan", "docs/decisions"] });
  assert.ok(existsSync(join(ws.dir, "plan/tasks.md")), "a planner revising a plan starts from the plan");
  ws.cleanup();
});

// ---------------------------------------------------------------------------
// The prompt says the same thing the runner enforces.
// ---------------------------------------------------------------------------

test("the scope note names what is delivered and what is only readable", () => {
  const note = workspaceScopeNote("build", ["app", "docs/decisions"]);
  assert.match(note, /What you write under app, docs\/decisions is what travels back/);
  assert.match(note, /plan, spec, design, tests\/seed, constitution\.md, \.claude\/skills — is here to be read/);
  assert.match(note, /ends the run with the paths named/);
  assert.equal(workspaceScopeNote("project", []), null);
});

// ---------------------------------------------------------------------------
// The run: work written where it cannot be delivered stops the run.
// ---------------------------------------------------------------------------

test("a run whose agent writes where the stage does not collect fails, naming the paths", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-scope-run-"));
  const { dir, prevEgress } = await makeProject(tmp);
  registerStage({
    name: "scope-drift-stage",
    title: "scope drift stage",
    skill: PROBE_SKILL,
    workspace: "build",
    gate: null,
    collect: ["app"],
    implemented: true,
    prompt: () => "unused",
    proposal: () => null,
    preChecks: () => [],
    postChecks: () => [],
  });
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-scope-mock-"));
  writeFileSync(join(mockDir, "scope-drift-stage.json"), JSON.stringify({
    text: "moved the criterion to a later slice and rebuilt the application",
    files: { "app/main.ts": "export const x = 2;\n", "plan/tasks.md": "### Slice 1 · moved\n" },
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "scope-drift-stage");
    assert.equal(r.ok, false);
    assert.deepEqual(r.dropped, ["plan/tasks.md"]);
    const message = r.messages.join("\n");
    assert.match(message, /wrote 1 path\(s\) its workspace does not collect/);
    assert.match(message, /plan\/tasks\.md/);
    assert.match(message, /This stage delivers app;/);
    assert.match(message, /Nothing was proposed\./);
    // The plan on the branch is untouched: the run said so rather than letting the
    // proposal page assert a change the branch does not carry.
    assert.equal(git(["show", "HEAD:plan/tasks.md"], dir), git(["show", "HEAD~2:plan/tasks.md"], dir));
    const journal = readFileSync(join(dir, ".sdlc/journal/001-scope-drift-stage.md"), "utf8");
    assert.match(journal, /moved the criterion to a later slice/);
    assert.match(journal, /work written where it is not collected/);
    // What the stage COULD deliver is still in the working tree for a person to look at,
    // the way a post-check failure leaves it.
    assert.match(readFileSync(join(dir, "app/main.ts"), "utf8"), /export const x = 2/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("a stage whose declaration cannot be honoured is refused before an agent turn is spent", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-scope-refuse-"));
  const { dir, prevEgress } = await makeProject(tmp);
  registerStage({
    name: "scope-mismatch-stage",
    title: "scope mismatch stage",
    skill: PROBE_SKILL,
    workspace: "build",
    gate: null,
    // `plan` is what this workspace hands the agent to read; a stage that also delivers it
    // is a stage whose declaration says two things about the same path.
    collect: ["app", "plan"],
    implemented: true,
    prompt: () => "unused",
    proposal: () => null,
    preChecks: () => { throw new Error("pre-checks must not run on a stage with an unusable declaration"); },
    postChecks: () => [],
  });
  try {
    await assert.rejects(() => runStage(dir, "scope-mismatch-stage"),
      /plan is declared both as workspace build's read-only context and as this stage's own output/);
  } finally {
    restoreEgress(prevEgress);
  }
});

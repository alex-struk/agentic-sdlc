import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage, turnsFor } from "../src/commands/run.mjs";
import { resume } from "../src/commands/resume.mjs";
import { registerStage } from "../src/stages/registry.mjs";
import { finishStage } from "../src/runner/finish-stage.mjs";

const PROBE_SKILL = new URL("../src/stages/skills/probe.md", import.meta.url).pathname;

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;

// Isolates the egress name list the same way test/fixture.test.mjs does: `init` (run
// as part of `newProject`) seeds the default list under the real home directory unless
// this is set first, and an existing-but-empty file wins the lookup outright.
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

test("sdlc run probe: commits the probe file and journal, leaves the tree clean", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-"));
  writeFileSync(join(mockDir, "probe.json"), JSON.stringify({
    text: "wrote the probe file",
    files: { "app/PROBE.md": "2026-09-06 the runner works\n" },
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "probe");
    assert.equal(r.ok, true);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.ok(existsSync(join(dir, "app/PROBE.md")));
    assert.match(git(["log", "-1", "--name-only"], dir), /app\/PROBE\.md/);
    const journal = readFileSync(join(dir, ".sdlc/journal/001-probe.md"), "utf8");
    assert.match(journal, /wrote the probe file/);
    const day = new Date().toISOString().slice(0, 10);
    const runs = readFileSync(join(dir, `.sdlc/runs/${day}.md`), "utf8");
    assert.match(runs, /run probe/);
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.ok(!existsSync(join(dir, ".sdlc/run-state.json")));

    // Second run with the same mock: app/PROBE.md ends up byte-identical, so it is not
    // part of what's dirty this time — only the new journal entry and run record are.
    const r2 = await runStage(dir, "probe");
    assert.equal(r2.ok, true);
    assert.ok(existsSync(join(dir, ".sdlc/journal/002-probe.md")));
    const files2 = git(["show", "--name-only", "--format=", "HEAD"], dir).split("\n").filter(Boolean);
    // The state site is a tracked artifact: it is rebuilt on every run and picked up by
    // `changedPaths()` the same as the journal and run record, since its own generation
    // timestamp always differs from what main already has committed.
    assert.ok(files2.every((f) => f.startsWith(".sdlc/journal/") || f.startsWith(".sdlc/runs/") || f.startsWith("site/")), files2.join(", "));
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run probe: a mock with no files fails post-checks but still commits the journal", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-fail-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-fail-"));
  writeFileSync(join(mockDir, "probe.json"), JSON.stringify({ text: "did nothing useful" }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "probe");
    assert.equal(r.ok, false);
    assert.ok(existsSync(join(dir, ".sdlc/journal/001-probe.md")));
    assert.ok(!existsSync(join(dir, "app/PROBE.md")));
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /post-checks failed/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc resume with no run-state prints nothing to resume", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-resume-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const code = await resume(dir, {});
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes("nothing to resume")));
  } finally {
    console.log = orig;
    restoreEgress(prevEgress);
  }
});

test("runStage rejects an unimplemented stage by name", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-stub-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    await assert.rejects(() => runStage(dir, "ratify"), /not implemented/);
  } finally {
    restoreEgress(prevEgress);
  }
});

test("sdlc run --dry-run prints the prompt and leaves no trace on disk or in git", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-dry-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const r = await runStage(dir, "probe", { dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.ok(logs.some((l) => l.includes("the runner works")));
    assert.ok(!existsSync(join(dir, ".sdlc/run-state.json")));
    assert.ok(!existsSync(join(dir, ".sdlc/journal")));
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    console.log = orig;
    restoreEgress(prevEgress);
  }
});

test("runStage passes --slice and --domain through to the stage's ctx", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-ctx-"));
  const { dir, prevEgress } = await makeProject(tmp);
  registerStage({
    name: "ctx-echo",
    title: "ctx echo",
    skill: PROBE_SKILL,
    workspace: "project",
    gate: null,
    collect: [],
    implemented: true,
    prompt: (ctx) => `slice=${ctx.slice} domain=${ctx.domain}`,
    proposal: () => null,
    preChecks: () => [],
    postChecks: () => [],
  });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const r = await runStage(dir, "ctx-echo", { dryRun: true, slice: 3, domain: "fees" });
    assert.equal(r.ok, true);
    assert.ok(logs.some((l) => l === "slice=3 domain=fees"));
  } finally {
    console.log = orig;
    restoreEgress(prevEgress);
  }
});

test("runStage: a failing pre-check commits the run record so a later run stays unblocked", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-prefail-"));
  const { dir, prevEgress } = await makeProject(tmp);
  registerStage({
    name: "precheck-fail",
    title: "precheck fail",
    workspace: "project",
    gate: null,
    collect: [],
    implemented: true,
    prompt: () => "unused",
    proposal: () => null,
    preChecks: () => [{ id: "always-fails", ok: false, messages: ["nope"] }],
    postChecks: () => [],
  });
  try {
    const r = await runStage(dir, "precheck-fail");
    assert.equal(r.ok, false);
    assert.deepEqual(r.messages, ["nope"]);
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /run\(precheck-fail\): pre-checks failed/);
    const day = new Date().toISOString().slice(0, 10);
    const runs = readFileSync(join(dir, `.sdlc/runs/${day}.md`), "utf8");
    assert.match(runs, /run precheck-fail: pre-checks failed/);
    // The record from the first failure is already committed, so a second run against
    // the same still-failing stage must not die at `assertCleanTree`.
    const r2 = await runStage(dir, "precheck-fail");
    assert.equal(r2.ok, false);
  } finally {
    restoreEgress(prevEgress);
  }
});

test("sdlc run probe: a file the agent deletes is staged and committed as gone", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-del-"));
  const { dir, prevEgress } = await makeProject(tmp);
  writeFileSync(join(dir, "app", "OLD.md"), "stale content\n");
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "seed app/OLD.md"], dir);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-del-"));
  writeFileSync(join(mockDir, "probe.json"), JSON.stringify({
    text: "wrote the probe file and removed the stale one",
    files: { "app/PROBE.md": "2026-09-06 the runner works\n" },
    delete: ["app/OLD.md"],
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "probe");
    assert.equal(r.ok, true);
    assert.ok(!existsSync(join(dir, "app", "OLD.md")));
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.equal(git(["ls-files", "app/OLD.md"], dir), "");
    assert.match(git(["log", "-1", "--name-status"], dir), /D\s+app\/OLD\.md/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("runStage: a renamed file ends up moved, staged and committed with a clean tree", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-ren-"));
  const { dir, prevEgress } = await makeProject(tmp);
  registerStage({
    name: "rename-ok",
    title: "rename ok",
    skill: PROBE_SKILL,
    workspace: "project",
    gate: null,
    collect: [],
    implemented: true,
    prompt: () => "rename app/PROBE.md",
    proposal: () => null,
    preChecks: () => [],
    postChecks: () => [],
  });
  const content = "2026-09-06 the runner works\n";
  writeFileSync(join(dir, "app", "PROBE.md"), content);
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "seed app/PROBE.md"], dir);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-ren-"));
  writeFileSync(join(mockDir, "rename-ok.json"), JSON.stringify({
    text: "moved the probe file",
    files: { "app/PROBE-renamed.md": content },
    delete: ["app/PROBE.md"],
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "rename-ok");
    assert.equal(r.ok, true);
    assert.ok(!existsSync(join(dir, "app", "PROBE.md")));
    assert.ok(existsSync(join(dir, "app", "PROBE-renamed.md")));
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.equal(git(["ls-files", "app/PROBE.md"], dir), "");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("runStage cleans up the temp workspace and skill dir when the agent turn throws", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-throw-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const emptyMockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-empty-"));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = emptyMockDir; // no probe.json in here, so the mock throws
  const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("sdlc-skill-probe-")));
  try {
    await assert.rejects(() => runStage(dir, "probe"), /no canned response/);
    const newSkillDirs = readdirSync(tmpdir()).filter((n) => n.startsWith("sdlc-skill-probe-") && !before.has(n));
    assert.deepEqual(newSkillDirs, []);
    // `run-state.json` is written before the agent turn and a throw does not clear it —
    // that is what lets `sdlc resume` pick the run back up — but nothing else changed.
    assert.ok(existsSync(join(dir, ".sdlc/run-state.json")));
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("turnsFor: a budget under 1000 reads as a turn count, clamped to 200", () => {
  assert.equal(turnsFor({ policy: { budgets: { design: 12 } } }, "design"), 12);
  assert.equal(turnsFor({ policy: { budgets: { design: 500 } } }, "design"), 200);
});

test("turnsFor: a budget at or above 1000 is a token count, unconverted, so it falls back to 40", () => {
  assert.equal(turnsFor({ policy: { budgets: { design: 4000000 } } }, "design"), 40);
  assert.equal(turnsFor({}, "design"), 40);
});

test("runStage never stages run-state, even in a project that does not ignore it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-state-"));
  const { dir, prevEgress } = await makeProject(tmp);
  // The ignore line is what normally keeps a run's own scratch out of a commit; without
  // it, `finishStage` has to keep it out by name.
  const ignore = join(dir, ".gitignore");
  writeFileSync(ignore, readFileSync(ignore, "utf8").split("\n").filter((l) => l !== ".sdlc/run-state.json").join("\n"));
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "unignore run-state"], dir);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-state-"));
  writeFileSync(join(mockDir, "probe.json"), JSON.stringify({
    text: "wrote the probe file",
    files: { "app/PROBE.md": "2026-09-06 the runner works\n" },
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "probe");
    assert.equal(r.ok, true);
    const committed = git(["show", "--name-only", "--format=", "HEAD"], dir).split("\n").filter(Boolean);
    assert.ok(!committed.includes(".sdlc/run-state.json"), committed.join(", "));
    assert.equal(git(["ls-files", "--", ".sdlc/run-state.json"], dir), "");
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("runStage: an agent turn that reports failure is recorded with the agent's own reason", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-agentfail-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-agentfail-"));
  writeFileSync(join(mockDir, "probe.json"), JSON.stringify({
    ok: false,
    text: "reached the turn limit before writing anything",
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "probe");
    assert.equal(r.ok, false);
    assert.deepEqual(r.messages, ["reached the turn limit before writing anything"]);
    const journal = readFileSync(join(dir, ".sdlc/journal/001-probe.md"), "utf8");
    assert.match(journal, /title: "probe: agent turn failed"/);
    assert.match(journal, /reached the turn limit before writing anything/);
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(probe\): agent turn failed/);
    const day = new Date().toISOString().slice(0, 10);
    assert.match(readFileSync(join(dir, `.sdlc/runs/${day}.md`), "utf8"), /run probe: agent turn failed/);
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("resume refuses a stage whose workspace was a temporary directory", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-resume-ws-"));
  const { dir, prevEgress } = await makeProject(tmp);
  registerStage({
    name: "spec-only-stage",
    title: "spec only stage",
    skill: PROBE_SKILL,
    workspace: "spec-only",
    gate: null,
    collect: [],
    implemented: true,
    prompt: () => "unused",
    proposal: () => null,
    preChecks: () => [],
    postChecks: () => [],
  });
  writeFileSync(join(dir, ".sdlc", "run-state.json"),
    JSON.stringify({ stage: "spec-only-stage", ctx: {}, phase: "post-checks" }) + "\n");
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const code = await resume(dir, { again: true });
    assert.equal(code, 1);
    assert.ok(logs.some((l) => l === "resume cannot continue a spec-only stage; run it again"), logs.join(" | "));
    // Nothing was judged and nothing was committed: no journal entry, run-state intact.
    assert.ok(!existsSync(join(dir, ".sdlc/journal")));
    assert.ok(existsSync(join(dir, ".sdlc/run-state.json")));
  } finally {
    console.log = orig;
    restoreEgress(prevEgress);
  }
});

test("turnsFor warns once, by name, when a token-sized budget is ignored", () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    const config = { policy: { budgets: { "budget-warn": 250000 } } };
    assert.equal(turnsFor(config, "budget-warn"), 40);
    assert.equal(turnsFor(config, "budget-warn"), 40);
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 1, warnings.join(" | "));
  assert.match(warnings[0], /policy\.budgets\.budget-warn is 250000/);
  assert.match(warnings[0], /default of 40 turns/);
});

test("finishStage fails and names the path when a tracked file has since been excluded, and commits nothing", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-finish-ignored-"));
  const { dir, prevEgress } = await makeProject(tmp);
  mkdirSync(join(dir, "secrets"), { recursive: true });
  writeFileSync(join(dir, "secrets", "creds.env"), "super-secret\n");
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "oops, committed a secret"], dir);
  try {
    // Standing in for what an agent turn just did in the working tree, before
    // `finishStage` is asked to commit it: added the secret to `.gitignore` and
    // untracked it with `git rm --cached`, neither committed yet — the "committed by
    // accident, now excluded" pattern src/lib/git.mjs's `stageAll` now refuses instead
    // of silently force-staging.
    writeFileSync(join(dir, ".gitignore"), `${readFileSync(join(dir, ".gitignore"), "utf8")}secrets/creds.env\n`);
    git(["rm", "--cached", "-q", "--", "secrets/creds.env"], dir);
    const lastCommit = git(["log", "-1", "--pretty=%s"], dir);

    const stage = { name: "ignore-repro", title: "ignore repro", gate: null, postChecks: () => [], proposal: () => null };
    const agentResult = { text: "removed the secret from tracking", cost: 0, turns: 1, sessionId: "mock" };
    await assert.rejects(
      () => finishStage(dir, stage, {}, agentResult),
      (e) => /stageAll: refusing to add/.test(e.message) && e.message.includes("secrets/creds.env"));

    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["log", "-1", "--pretty=%s"], dir), lastCommit, "nothing new was committed");
    assert.notEqual(git(["status", "--porcelain"], dir), "", "the tree is left dirty for inspection");
    assert.ok(existsSync(join(dir, "secrets", "creds.env")), "the file itself is left on disk");
    assert.equal(readFileSync(join(dir, "secrets", "creds.env"), "utf8"), "super-secret\n");
  } finally {
    restoreEgress(prevEgress);
  }
});

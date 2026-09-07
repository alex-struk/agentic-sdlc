import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage, turnsFor } from "../src/commands/run.mjs";
import { resume } from "../src/commands/resume.mjs";
import { propose } from "../src/commands/propose.mjs";
import { rule } from "../src/commands/rule.mjs";
import { registerStage } from "../src/stages/registry.mjs";
import { finishStage } from "../src/runner/finish-stage.mjs";
import { loadConfig } from "../src/config/load.mjs";

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
    // A failed run costs what a successful one costs, so its journal entry carries the
    // same three metrics — otherwise the site's totals undercount every failure.
    const journal = readFileSync(join(dir, ".sdlc/journal/001-probe.md"), "utf8");
    assert.match(journal, /^turns: 1$/m);
    assert.match(journal, /^session: "mock"$/m);
    assert.match(journal, /^cost: 0$/m);
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
    // `ratify` used to be one of these stubs; it is implemented as of this stage's own
    // task, so a still-unimplemented one (`design`) stands in for it here instead.
    await assert.rejects(() => runStage(dir, "design"), /not implemented/);
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

test("turnsFor: a budget under 1000 reads as a turn count, clamped to 400", () => {
  assert.equal(turnsFor({ policy: { budgets: { design: 12 } } }, "design"), 12);
  assert.equal(turnsFor({ policy: { budgets: { design: 500 } } }, "design"), 400);
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

test("a post-check failure on a session that hit the turn cap says so, from the CLI's own subtype", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-postfail-cap-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-postfail-cap-"));
  // The turn did not report failure — it came back fine, having run out of turns before
  // writing the file the post-check wants. `num_turns` says nothing useful about that;
  // the CLI's `subtype` does.
  writeFileSync(join(mockDir, "probe.json"), JSON.stringify({
    text: "I was still working on it.",
    subtype: "error_max_turns",
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "probe");
    assert.equal(r.ok, false);
    const journal = readFileSync(join(dir, ".sdlc/journal/001-probe.md"), "utf8");
    assert.match(journal, /title: "probe: post-checks failed"/);
    assert.match(journal, /The session hit the turn cap \(error_max_turns\)\./);
    assert.match(journal, /app\/PROBE\.md is missing/);
    assert.match(journal, /^session: "mock"$/m);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("an agent turn that fails with no output at all is journalled with how the session ended", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-agentfail-silent-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-agentfail-silent-"));
  writeFileSync(join(mockDir, "probe.json"), JSON.stringify({ ok: false, text: "", subtype: "error_max_turns" }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "probe");
    assert.equal(r.ok, false);
    assert.deepEqual(r.messages, ["the agent turn reported failure with no output; the session hit the turn cap (error_max_turns)"]);
    const journal = readFileSync(join(dir, ".sdlc/journal/001-probe.md"), "utf8");
    assert.match(journal, /hit the turn cap \(error_max_turns\)/);
    assert.match(journal, /^turns: 1$/m);
    assert.match(journal, /^session: "mock"$/m);
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

test("two proposals open at once rule and merge without a conflict", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-concurrent-"));
  const { dir, prevEgress } = await makeProject(tmp);
  // Two gated stages, each writing its own file. The generated state site is regenerated
  // whole from the whole project, so a proposal branch that carried its own copy would
  // differ from every other open proposal's on every page, and the second merge would
  // conflict on all of them for content neither proposal is about. Gated stages build no
  // site; the ruling regenerates it on main.
  for (const [name, file] of [["gated-one", "app/ONE.md"], ["gated-two", "app/TWO.md"]]) {
    registerStage({
      name, title: name, skill: PROBE_SKILL, workspace: "project", gate: "G1", collect: [],
      implemented: true,
      prompt: () => "unused",
      proposal: () => ({ name, question: `Is ${name} right?`, recommendation: "Yes." }),
      preChecks: () => [],
      postChecks: (projectDir) => [{ id: name, ok: existsSync(join(projectDir, file)), messages: [] }],
    });
  }
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-concurrent-"));
  writeFileSync(join(mockDir, "gated-one.json"), JSON.stringify({ text: "One is recorded.", files: { "app/ONE.md": "one\n" } }));
  writeFileSync(join(mockDir, "gated-two.json"), JSON.stringify({ text: "Two is recorded.", files: { "app/TWO.md": "two\n" } }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const one = await runStage(dir, "gated-one");
    assert.equal(one.ok, true, JSON.stringify(one.messages));
    // No site on the proposal branch at all: that is what makes the second merge clean.
    const onFirstBranch = git(["show", "--name-only", "--format=", "HEAD"], dir).split("\n").filter(Boolean);
    assert.ok(!onFirstBranch.some((f) => f.startsWith("site/")), onFirstBranch.join(", "));

    git(["checkout", "-q", "main"], dir);
    const two = await runStage(dir, "gated-two");
    assert.equal(two.ok, true, JSON.stringify(two.messages));

    // Both rule and merge. The second one is the case that used to conflict.
    git(["checkout", "-q", "main"], dir);
    assert.equal(rule(dir, "gated-one", "approve", { by: "tech-lead" }).verdict, "approve");
    assert.equal(rule(dir, "gated-two", "approve", { by: "tech-lead" }).verdict, "approve");

    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.ok(existsSync(join(dir, "app/ONE.md")));
    assert.ok(existsSync(join(dir, "app/TWO.md")));
    // main carries a site, regenerated by the rulings, listing both proposals.
    const index = readFileSync(join(dir, "site/index.md"), "utf8");
    assert.match(index, /gated-one/);
    assert.match(index, /gated-two/);
    assert.equal(git(["ls-files", "--", "site"], dir).split("\n").filter(Boolean).length > 0, true);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run: refuses to start anywhere but main, naming the branch", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-branch-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-"));
  writeFileSync(join(mockDir, "probe.json"), JSON.stringify({
    text: "wrote the probe file",
    files: { "app/PROBE.md": "2026-09-06 the runner works\n" },
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    // The state `sdlc run` itself leaves the tree in after opening a proposal. Branching
    // a new proposal off here would carry the previous one's changes, and the persona's
    // `main...proposal/<name>` diff would be against the wrong base.
    git(["checkout", "-q", "-b", "proposal/something-else"], dir);
    await assert.rejects(() => runStage(dir, "probe"),
      /run must start on main; you are on proposal\/something-else/);
    // Nothing ran: no journal entry, no commit, tree untouched.
    assert.ok(!existsSync(join(dir, ".sdlc/journal")));
    assert.equal(git(["status", "--porcelain"], dir), "");

    git(["checkout", "-q", "main"], dir);
    const r = await runStage(dir, "probe");
    assert.equal(r.ok, true);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("resume continues a with-sources stage: its agent worked in the project directory", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-resume-sources-"));
  const { dir, prevEgress } = await makeProject(tmp);
  // A gate-less stage in `with-sources` mode, so this exercises the workspace decision
  // alone: `materialise` returns the project directory for this mode exactly as it does
  // for `project`, so whatever the interrupted agent wrote is still there to judge.
  registerStage({
    name: "with-sources-stage",
    title: "with sources stage",
    skill: PROBE_SKILL,
    workspace: "with-sources",
    gate: null,
    collect: [],
    implemented: true,
    prompt: () => "unused",
    proposal: () => null,
    preChecks: () => [],
    postChecks: () => [],
  });
  writeFileSync(join(dir, "recovered.md"), "what the interrupted agent left behind\n");
  writeFileSync(join(dir, ".sdlc", "run-state.json"),
    JSON.stringify({ stage: "with-sources-stage", ctx: {}, phase: "post-checks" }) + "\n");
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const code = await resume(dir, { again: true });
    assert.equal(code, 0);
    assert.ok(!logs.some((l) => /resume cannot continue/.test(l)), logs.join(" | "));
    // The interrupted agent's file was judged and committed, and the run-state cleared.
    assert.match(git(["log", "-1", "--name-only"], dir), /recovered\.md/);
    assert.ok(existsSync(join(dir, ".sdlc/journal/001-with-sources-stage.md")));
    assert.ok(!existsSync(join(dir, ".sdlc/run-state.json")));
  } finally {
    console.log = orig;
    restoreEgress(prevEgress);
  }
});

test("sdlc resume: refuses to continue a stage whose proposal is still open, without ever calling finishStage's post-checks", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-resume-openproposal-"));
  const { dir, prevEgress } = await makeProject(tmp);
  // A gated stage whose proposal name never depends on `ctx` — unlike `intent`, which
  // needs its own derivation to be pre-flight-able at all — so this test isolates
  // `resume`'s own pre-flight call from that logic.
  registerStage({
    name: "resume-guard-stage",
    title: "resume guard stage",
    skill: PROBE_SKILL,
    workspace: "project",
    gate: "G1",
    collect: [],
    implemented: true,
    prompt: () => "unused",
    proposal: () => ({ name: "resume-guard-stage-x", question: "q?", recommendation: "r." }),
    preChecks: () => [],
    postChecks: () => { throw new Error("postChecks must not run: the pre-flight should have refused first"); },
  });
  try {
    // Opens `proposal/resume-guard-stage-x` directly, standing in for a previous run
    // that finished and opened this proposal, left unruled.
    propose(dir, "resume-guard-stage-x", { gate: "G1", question: "q?", recommendation: "r." });
    git(["checkout", "-q", "main"], dir);
    writeFileSync(join(dir, ".sdlc", "run-state.json"),
      JSON.stringify({ stage: "resume-guard-stage", ctx: {}, phase: "post-checks" }) + "\n");

    const code = await resume(dir, {});
    assert.equal(code, 1);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /run\(resume-guard-stage\): proposal still open/);
    const day = new Date().toISOString().slice(0, 10);
    assert.match(readFileSync(join(dir, `.sdlc/runs/${day}.md`), "utf8"),
      /run resume-guard-stage: proposal resume-guard-stage-x still open/);
    // No journal entry: the pre-flight refused before `finishStage` (and its
    // `postChecks`) ever ran.
    assert.ok(!existsSync(join(dir, ".sdlc/journal")));
    // run-state.json is untouched, at `phase: "post-checks"`, for a later `resume` to
    // find once the proposal is ruled or its branch is deleted.
    const state = JSON.parse(readFileSync(join(dir, ".sdlc/run-state.json"), "utf8"));
    assert.equal(state.phase, "post-checks");
  } finally {
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
  assert.match(warnings[0], /this budget is ignored/);
  assert.match(warnings[0], /default ceiling of 40 turns/);
  assert.match(warnings[0], /set policy\.budgets\.budget-warn to a number below 1000/);
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

test("runStage: --target and --stale reach ctx, and --stale defaults to false", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-target-"));
  const { dir, prevEgress } = await makeProject(tmp);
  registerStage({
    name: "target-echo",
    title: "target echo",
    skill: PROBE_SKILL,
    workspace: "project",
    gate: null,
    collect: [],
    implemented: true,
    prompt: (ctx) => `target=${ctx.target} stale=${ctx.stale}`,
    proposal: () => null,
    preChecks: () => [],
    postChecks: () => [],
  });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const noFlags = await runStage(dir, "target-echo", { dryRun: true });
    assert.equal(noFlags.ok, true);
    assert.ok(logs.some((l) => l === "target=undefined stale=false"), logs.join(" | "));

    logs.length = 0;
    const withFlags = await runStage(dir, "target-echo", { dryRun: true, target: "old", stale: true });
    assert.equal(withFlags.ok, true);
    assert.ok(logs.some((l) => l === "target=old stale=true"), logs.join(" | "));
  } finally {
    console.log = orig;
    restoreEgress(prevEgress);
  }
});

test("runStage resolves stage.workspace when it is a function of config, called with the loaded config", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-wsfn-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const { config: expectedConfig } = loadConfig(join(dir, ".sdlc", "config.yaml"));
  let received;
  registerStage({
    name: "ws-fn-stage",
    title: "ws fn stage",
    skill: PROBE_SKILL,
    // A function of config rather than a plain string: `runStage` must resolve it once,
    // before `materialise`, or `materialise` throws "unknown workspace mode: function".
    workspace: (config) => { received = config; return "project"; },
    gate: null,
    collect: [],
    implemented: true,
    prompt: () => "unused",
    proposal: () => null,
    preChecks: () => [],
    postChecks: () => [],
  });
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-wsfn-"));
  writeFileSync(join(mockDir, "ws-fn-stage.json"), JSON.stringify({ text: "ran in the resolved workspace" }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "ws-fn-stage");
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.deepEqual(received, expectedConfig);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("resume resolves a function stage.workspace the same way runStage does", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-resume-wsfn-"));
  const { dir, prevEgress } = await makeProject(tmp);
  registerStage({
    name: "resume-ws-fn-stage",
    title: "resume ws fn stage",
    skill: PROBE_SKILL,
    // Resolves to a temporary-workspace mode, which `resume` refuses to continue —
    // proving the message names the resolved mode, not the function itself.
    workspace: () => "spec-only",
    gate: null,
    collect: [],
    implemented: true,
    prompt: () => "unused",
    proposal: () => null,
    preChecks: () => [],
    postChecks: () => [],
  });
  writeFileSync(join(dir, ".sdlc", "run-state.json"),
    JSON.stringify({ stage: "resume-ws-fn-stage", ctx: {}, phase: "post-checks" }) + "\n");
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const code = await resume(dir, { again: true });
    assert.equal(code, 1);
    assert.ok(logs.some((l) => l === "resume cannot continue a spec-only stage; run it again"), logs.join(" | "));
  } finally {
    console.log = orig;
    restoreEgress(prevEgress);
  }
});

test("a stage's prepare hook writes into the workspace before the agent turn, and its file is collected back", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-prepare-"));
  const { dir, prevEgress } = await makeProject(tmp);
  let sawWsDir;
  registerStage({
    name: "prepare-stage",
    title: "prepare stage",
    skill: PROBE_SKILL,
    workspace: "spec-only",
    gate: null,
    // `collect` names a directory to copy back whole (`copyTree`), the same shape every
    // real stage's `collect` list uses (e.g. `HARNESS`'s `tests/fixtures`) — not an
    // individual file.
    collect: ["generated"],
    implemented: true,
    prepare(wsDir, ctx, config) {
      sawWsDir = wsDir;
      assert.notEqual(wsDir, dir, "prepare must run in the temporary workspace, not the project directory");
      assert.ok(config, "prepare receives the loaded config");
      mkdirSync(join(wsDir, "generated"), { recursive: true });
      writeFileSync(join(wsDir, "generated", "pre.txt"), "written by prepare\n");
    },
    prompt: () => "unused",
    proposal: () => null,
    preChecks: () => [],
    postChecks: () => [],
  });
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-prepare-"));
  writeFileSync(join(mockDir, "prepare-stage.json"), JSON.stringify({ text: "used what prepare wrote" }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "prepare-stage");
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.ok(sawWsDir, "prepare was called");
    assert.equal(readFileSync(join(dir, "generated", "pre.txt"), "utf8"), "written by prepare\n");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("prepare is skipped on --dry-run, printed after the prompt, and never called", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-prepare-dry-"));
  const { dir, prevEgress } = await makeProject(tmp);
  let called = false;
  registerStage({
    name: "prepare-dry-stage",
    title: "prepare dry stage",
    skill: PROBE_SKILL,
    workspace: "project",
    gate: null,
    collect: [],
    implemented: true,
    prepare() { called = true; },
    mcp: () => ({ browser: { command: "browser-mcp", args: [] } }),
    env: () => ({ SOME_SECRET: "value-not-printed" }),
    prompt: () => "the prompt text",
    proposal: () => null,
    preChecks: () => [],
    postChecks: () => [],
  });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const r = await runStage(dir, "prepare-dry-stage", { dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(called, false, "prepare must not run on a dry run");
    const promptIdx = logs.indexOf("the prompt text");
    assert.ok(promptIdx >= 0);
    assert.ok(logs.slice(promptIdx + 1).some((l) => l === "prepare: skipped on dry run"), logs.join(" | "));
    assert.ok(logs.slice(promptIdx + 1).some((l) => l === "mcp: browser"), logs.join(" | "));
    assert.ok(logs.slice(promptIdx + 1).some((l) => l === "env: SOME_SECRET"), logs.join(" | "));
    assert.ok(!logs.some((l) => l.includes("value-not-printed")), "a value must never be printed, only the name");
  } finally {
    console.log = orig;
    restoreEgress(prevEgress);
  }
});

test("a prepare hook that throws fails the run before any agent turn, the same way a failing pre-check does", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-prepare-throw-"));
  const { dir, prevEgress } = await makeProject(tmp);
  registerStage({
    name: "prepare-throw-stage",
    title: "prepare throw stage",
    skill: PROBE_SKILL,
    workspace: "project",
    gate: null,
    collect: [],
    implemented: true,
    prepare() { throw new Error("could not generate the file"); },
    prompt: () => "unused",
    proposal: () => null,
    preChecks: () => [],
    postChecks: () => { throw new Error("must never be reached: prepare failed before post-checks"); },
  });
  // No mock canned response at all, so if the agent turn ran at all the mock executor
  // would throw "no canned response" instead of `runStage` returning the ordinary
  // `{ ok: false, messages: [...] }` shape this test asserts below — proving the agent
  // turn is never invoked when prepare throws.
  const emptyMockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-prepare-throw-"));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = emptyMockDir;
  try {
    const r = await runStage(dir, "prepare-throw-stage");
    assert.equal(r.ok, false);
    assert.deepEqual(r.messages, ["could not generate the file"]);
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /run\(prepare-throw-stage\): prepare failed/);
    const day = new Date().toISOString().slice(0, 10);
    const runs = readFileSync(join(dir, `.sdlc/runs/${day}.md`), "utf8");
    assert.match(runs, /run prepare-throw-stage: prepare failed/);
    assert.ok(!existsSync(join(dir, ".sdlc/journal")), "no journal entry: there is no agent turn to account for");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("resume carries target and stale through unchanged", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-resume-target-"));
  const { dir, prevEgress } = await makeProject(tmp);
  let seenCtx;
  registerStage({
    name: "resume-target-stage",
    title: "resume target stage",
    skill: PROBE_SKILL,
    workspace: "project",
    gate: null,
    collect: [],
    implemented: true,
    prompt: () => "unused",
    proposal: () => null,
    preChecks: () => [],
    postChecks: (projectDir, ctx) => { seenCtx = ctx; return []; },
  });
  writeFileSync(join(dir, ".sdlc", "run-state.json"),
    JSON.stringify({ stage: "resume-target-stage", ctx: { target: "old", stale: true }, phase: "post-checks" }) + "\n");
  try {
    const code = await resume(dir, { again: true });
    assert.equal(code, 0);
    assert.equal(seenCtx.target, "old");
    assert.equal(seenCtx.stale, true);
  } finally {
    restoreEgress(prevEgress);
  }
});

test("runStage writes the MCP servers a stage declares to mcp.json in the skill scratch dir and passes it through to the agent turn", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-run-mcp-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const root = mkdtempSync(join(tmpdir(), "sdlc-mcp-fake-claude-"));
  const captureFile = join(root, "capture.json");
  const outFile = join(root, "out.json");
  writeFileSync(outFile, JSON.stringify({ is_error: false, result: "used the browser mcp", num_turns: 1, session_id: "s1" }));
  const bin = join(root, "fake-claude");
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    'import { readFileSync, writeFileSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    'const mi = args.indexOf("--mcp-config");',
    'const mcpConfig = mi === -1 ? null : readFileSync(args[mi + 1], "utf8");',
    'const ai = args.indexOf("--allowedTools");',
    'const allowedTools = ai === -1 ? [] : [args[ai + 1], args[ai + 2]];',
    'writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({ mcpConfig, allowedTools, extraEnv: process.env.EXTRA_ENV_FOR_STAGE ?? null }));',
    'process.stdout.write(readFileSync(process.env.FAKE_OUT, "utf8"));',
  ].join("\n"));
  chmodSync(bin, 0o755);
  registerStage({
    name: "mcp-stage",
    title: "mcp stage",
    skill: PROBE_SKILL,
    workspace: "project",
    gate: null,
    collect: [],
    implemented: true,
    allowedTools: ["Read", "Grep"],
    mcp: () => ({ browser: { command: "browser-mcp", args: [] } }),
    env: () => ({ EXTRA_ENV_FOR_STAGE: "carried-through" }),
    prompt: () => "use the browser",
    proposal: () => null,
    preChecks: () => [],
    postChecks: () => [],
  });
  process.env.SDLC_CLAUDE_BIN = bin;
  process.env.SDLC_CLAUDE_HOME = join(root, "claude-home");
  process.env.SDLC_CREDENTIALS = join(root, "no-such-credentials.json");
  process.env.FAKE_OUT = outFile;
  process.env.CAPTURE_FILE = captureFile;
  try {
    const r = await runStage(dir, "mcp-stage");
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    const captured = JSON.parse(readFileSync(captureFile, "utf8"));
    assert.deepEqual(JSON.parse(captured.mcpConfig), { mcpServers: { browser: { command: "browser-mcp", args: [] } } });
    assert.deepEqual(captured.allowedTools, ["Read", "Grep"]);
    assert.equal(captured.extraEnv, "carried-through");
  } finally {
    for (const k of ["SDLC_CLAUDE_BIN", "SDLC_CLAUDE_HOME", "SDLC_CREDENTIALS", "FAKE_OUT", "CAPTURE_FILE"]) delete process.env[k];
    restoreEgress(prevEgress);
  }
});

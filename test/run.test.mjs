import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { resume } from "../src/commands/resume.mjs";

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
    assert.ok(files2.every((f) => f.startsWith(".sdlc/journal/") || f.startsWith(".sdlc/runs/")), files2.join(", "));
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
    await assert.rejects(() => runStage(dir, "archaeology"), /not implemented/);
  } finally {
    restoreEgress(prevEgress);
  }
});

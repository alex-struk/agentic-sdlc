import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureConfigHome } from "../src/runner/config-home.mjs";
import { runAgent, buildArgs } from "../src/runner/executor.mjs";

test("config home is created with a credentials symlink when the source exists", () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-home-"));
  const cred = join(root, "creds.json"); writeFileSync(cred, "{}");
  process.env.SDLC_CLAUDE_HOME = join(root, "home"); process.env.SDLC_CREDENTIALS = cred;
  try {
    const p = ensureConfigHome();
    assert.equal(p, join(root, "home"));
    assert.ok(lstatSync(join(p, ".credentials.json")).isSymbolicLink());
    assert.equal(readFileSync(join(p, ".credentials.json"), "utf8"), "{}");
  } finally { delete process.env.SDLC_CLAUDE_HOME; delete process.env.SDLC_CREDENTIALS; }
});

test("buildArgs carries isolation flags and the stage", () => {
  const { args, env } = buildArgs({ prompt: "hi", stage: "build", maxTurns: 7, systemPromptFile: "/x/skill.md", addDirs: ["/tmp/a"] }, "/cfg");
  assert.deepEqual(args.slice(0, 2), ["-p", "hi"]);
  for (const f of ["--output-format", "json", "--permission-mode", "acceptEdits", "--strict-mcp-config", "--no-session-persistence", "--max-turns", "7", "--append-system-prompt-file", "/x/skill.md", "--add-dir", "/tmp/a"]) assert.ok(args.includes(f), f);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/cfg"); assert.equal(env.SDLC_STAGE, "build");
});

test("mock executor writes files and returns the canned text", async () => {
  const mock = mkdtempSync(join(tmpdir(), "sdlc-mock-")); const cwd = mkdtempSync(join(tmpdir(), "sdlc-cwd-"));
  writeFileSync(join(mock, "probe.json"), JSON.stringify({ text: "did the thing", files: { "app/out.txt": "hello" } }));
  process.env.SDLC_EXECUTOR = "mock"; process.env.SDLC_MOCK_DIR = mock;
  try {
    const r = await runAgent({ cwd, prompt: "x", stage: "probe" });
    assert.equal(r.ok, true); assert.equal(r.text, "did the thing"); assert.equal(r.sessionId, "mock");
    assert.equal(readFileSync(join(cwd, "app/out.txt"), "utf8"), "hello");
    await assert.rejects(() => runAgent({ cwd, prompt: "x", stage: "nope" }), /nope\.json/);
  } finally { delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR; }
});

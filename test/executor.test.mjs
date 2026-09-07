import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureConfigHome } from "../src/runner/config-home.mjs";
import { runAgent, buildArgs, endedBecause, DEFAULT_MAX_TURNS } from "../src/runner/executor.mjs";
import { turnsFor } from "../src/commands/run.mjs";

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
  // No caller-supplied tool list, so the flag is absent rather than present and empty.
  assert.ok(!args.includes("--allowedTools"));
});

test("buildArgs passes an allowed tool list as one flag followed by each tool", () => {
  const tools = ["Read", "Grep", "Bash(git diff*)"];
  const { args } = buildArgs({ prompt: "hi", stage: "rule", allowedTools: tools }, "/cfg");
  const at = args.indexOf("--allowedTools");
  assert.ok(at >= 0);
  assert.deepEqual(args.slice(at + 1, at + 1 + tools.length), tools);
});

test("buildArgs places --mcp-config right after --strict-mcp-config when the stage set one", () => {
  const { args } = buildArgs({ prompt: "hi", stage: "bind-adapter", mcpConfig: "/tmp/skill/mcp.json" }, "/cfg");
  const strict = args.indexOf("--strict-mcp-config");
  assert.equal(args[strict + 1], "--mcp-config");
  assert.equal(args[strict + 2], "/tmp/skill/mcp.json");
});

test("buildArgs omits --mcp-config entirely when the stage set none", () => {
  const { args } = buildArgs({ prompt: "hi", stage: "build" }, "/cfg");
  assert.ok(!args.includes("--mcp-config"));
});

test("the mock executor reports a failed agent turn when the canned response says ok: false", async () => {
  const mock = mkdtempSync(join(tmpdir(), "sdlc-mock-notok-")); const cwd = mkdtempSync(join(tmpdir(), "sdlc-cwd-notok-"));
  writeFileSync(join(mock, "probe.json"), JSON.stringify({ ok: false, text: "hit the turn limit" }));
  process.env.SDLC_EXECUTOR = "mock"; process.env.SDLC_MOCK_DIR = mock;
  try {
    const r = await runAgent({ cwd, prompt: "x", stage: "probe" });
    assert.equal(r.ok, false);
    assert.equal(r.text, "hit the turn limit");
  } finally { delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR; }
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

test("ensureConfigHome leaves the credentials file alone when the source already lives at the link path", () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-home-self-"));
  const home = join(root, "home"); mkdirSync(home, { recursive: true });
  const cred = join(home, ".credentials.json"); writeFileSync(cred, "{\"real\":true}");
  process.env.SDLC_CLAUDE_HOME = home; process.env.SDLC_CREDENTIALS = cred;
  try {
    const p = ensureConfigHome();
    assert.equal(p, home);
    // Not a symlink and not deleted: the source and the link path are the same file, so
    // the rm/symlink dance must be skipped entirely rather than deleting the operator's
    // own credentials and symlinking the (now missing) path to itself.
    assert.ok(!lstatSync(cred).isSymbolicLink());
    assert.equal(readFileSync(cred, "utf8"), "{\"real\":true}");
  } finally { delete process.env.SDLC_CLAUDE_HOME; delete process.env.SDLC_CREDENTIALS; }
});

test("ensureConfigHome replaces whatever is already at the credentials path", () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-home-replace-"));
  const cred = join(root, "creds.json"); writeFileSync(cred, "{\"real\":true}");
  const home = join(root, "home"); mkdirSync(home, { recursive: true });
  // A plain file, not a symlink: the previous version left it alone and the session
  // would have authenticated with it instead of the operator's own credentials.
  writeFileSync(join(home, ".credentials.json"), "{\"stale\":true}");
  process.env.SDLC_CLAUDE_HOME = home; process.env.SDLC_CREDENTIALS = cred;
  try {
    const p = ensureConfigHome();
    assert.ok(lstatSync(join(p, ".credentials.json")).isSymbolicLink());
    assert.equal(readFileSync(join(p, ".credentials.json"), "utf8"), "{\"real\":true}");
  } finally { delete process.env.SDLC_CLAUDE_HOME; delete process.env.SDLC_CREDENTIALS; }
});

// A stand-in for the `claude` binary: a real subprocess, so `runAgent`'s own use of
// `execFile` — its JSON parsing, its `??` fallbacks, the flags it actually passed — is
// exercised rather than bypassed by the in-process mock. It prints whatever the file
// named by `FAKE_OUT` holds, after substituting `__MAX_TURNS__` for the value it was
// actually given on the command line, and exits with `FAKE_EXIT` if that is set.
function fakeClaude(root) {
  const bin = join(root, "fake-claude");
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    'const i = args.indexOf("--max-turns");',
    'const maxTurns = i === -1 ? "" : args[i + 1];',
    'const out = readFileSync(process.env.FAKE_OUT, "utf8").replaceAll("__MAX_TURNS__", maxTurns);',
    "process.stdout.write(out);",
    "if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));",
  ].join("\n"));
  chmodSync(bin, 0o755);
  return bin;
}

function withFakeClaude(root, output, { exitCode = null } = {}) {
  const outPath = join(root, "out.txt");
  writeFileSync(outPath, output);
  process.env.SDLC_CLAUDE_BIN = fakeClaude(root);
  process.env.SDLC_CLAUDE_HOME = join(root, "claude-home");
  process.env.SDLC_CREDENTIALS = join(root, "no-such-credentials.json");
  process.env.FAKE_OUT = outPath;
  if (exitCode !== null) process.env.FAKE_EXIT = String(exitCode);
}

function clearFakeClaude() {
  for (const k of ["SDLC_CLAUDE_BIN", "SDLC_CLAUDE_HOME", "SDLC_CREDENTIALS", "FAKE_OUT", "FAKE_EXIT"]) delete process.env[k];
}

test("runAgent parses the CLI's JSON and reports a real result", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-exec-ok-"));
  withFakeClaude(root, JSON.stringify({
    is_error: false, result: "wrote the file", total_cost_usd: 0.42, num_turns: 6,
    session_id: "sess-1", subtype: "success",
  }));
  try {
    const r = await runAgent({ cwd: root, prompt: "x", stage: "probe", maxTurns: 17 });
    assert.equal(r.ok, true);
    assert.equal(r.text, "wrote the file");
    assert.equal(r.cost, 0.42);
    assert.equal(r.turns, 6);
    assert.equal(r.sessionId, "sess-1");
    assert.equal(r.raw.subtype, "success");
  } finally { clearFakeClaude(); }
});

test("runAgent reports ok: false when the CLI sets is_error", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-exec-err-"));
  withFakeClaude(root, JSON.stringify({
    is_error: true, result: "I ran out of turns", subtype: "error_max_turns", num_turns: 40,
  }));
  try {
    const r = await runAgent({ cwd: root, prompt: "x", stage: "probe" });
    assert.equal(r.ok, false);
    assert.equal(r.text, "I ran out of turns");
    assert.equal(endedBecause(r.raw), "hit the turn cap (error_max_turns)");
  } finally { clearFakeClaude(); }
});

test("runAgent falls back for every field the CLI left out", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-exec-sparse-"));
  // No `result`, no `total_cost_usd`, no `num_turns`, no `session_id`: the `??`
  // fallbacks are the only thing between this and a journal entry full of `undefined`.
  withFakeClaude(root, JSON.stringify({ is_error: false }));
  try {
    const r = await runAgent({ cwd: root, prompt: "x", stage: "probe" });
    assert.equal(r.ok, true);
    assert.equal(r.text, "");
    assert.equal(r.cost, 0);
    assert.equal(r.turns, 0);
    assert.equal(r.sessionId, "");
  } finally { clearFakeClaude(); }
});

test("runAgent throws, quoting the output, when the CLI prints something that is not JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-exec-nonjson-"));
  withFakeClaude(root, "Error: could not reach the API\nTraceback follows\n");
  try {
    await assert.rejects(() => runAgent({ cwd: root, prompt: "x", stage: "probe" }),
      /claude returned non-JSON output:\n[\s\S]*could not reach the API/);
  } finally { clearFakeClaude(); }
});

test("runAgent throws when the CLI exits non-zero with nothing on stdout", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-exec-exit-"));
  withFakeClaude(root, "", { exitCode: 3 });
  try {
    await assert.rejects(() => runAgent({ cwd: root, prompt: "x", stage: "probe" }), /claude failed/);
  } finally { clearFakeClaude(); }
});

test("--max-turns receives the budget turnsFor computed", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-exec-turns-"));
  // The fake echoes back the `--max-turns` value it was actually given, so this asserts
  // the flag the executor passed rather than the argument the test handed in.
  withFakeClaude(root, JSON.stringify({ is_error: false, result: "ok", maxTurns: "__MAX_TURNS__" }));
  try {
    const budgeted = await runAgent({ cwd: root, prompt: "x", stage: "build", maxTurns: turnsFor({ policy: { budgets: { build: 25 } } }, "build") });
    assert.equal(budgeted.raw.maxTurns, "25");

    const defaulted = await runAgent({ cwd: root, prompt: "x", stage: "build", maxTurns: turnsFor({}, "build") });
    assert.equal(defaulted.raw.maxTurns, String(DEFAULT_MAX_TURNS));
  } finally { clearFakeClaude(); }
});

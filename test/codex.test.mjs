import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, lstatSync, statSync, utimesSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { ensureCodexHome, codexHomePath } from "../src/runner/config-home.mjs";
import { buildCodexArgs, parseCodexOutput, CODEX_AUTH_ADVICE, codexWallClockMs } from "../src/runner/codex.mjs";
import { runAgent, preflightAuth, endedBecause, buildArgs } from "../src/runner/executor.mjs";

const CODEX = { backend: "codex" };

// A stand-in for the `codex` binary, the counterpart of the executor tests' fake `claude`:
// a real subprocess, so the flags `runAgent` passes, the environment it sets, the prompt it
// writes to stdin and its reading of the JSONL event stream are exercised rather than
// assumed. It answers `--version` and `login status` the way the real CLI does, records
// what it was given in the files the `FAKE_*_OUT` variables name, prints whatever
// `FAKE_OUT` holds, and can sleep, write to stderr and exit non-zero on request.
function fakeCodex(root) {
  const bin = join(root, "fake-codex");
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    'import { readFileSync, writeFileSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") { process.stdout.write("codex-cli 9.9.9\\n"); process.exit(0); }',
    'if (args[0] === "login" && args[1] === "status") {',
    '  if (process.env.FAKE_LOGIN_ENV_OUT) writeFileSync(process.env.FAKE_LOGIN_ENV_OUT, process.env.CODEX_HOME ?? "");',
    '  process.stdout.write(process.env.FAKE_LOGIN ?? "Not logged in\\n"); process.exit(process.env.FAKE_LOGIN ? 0 : 1);',
    "}",
    'if (process.env.FAKE_ARGV_OUT) writeFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify(args));',
    'if (process.env.FAKE_ENV_OUT) writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify({ CODEX_HOME: process.env.CODEX_HOME, SDLC_STAGE: process.env.SDLC_STAGE, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null, CODEX_API_KEY: process.env.CODEX_API_KEY ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, cwd: process.cwd() }));',
    'const prompt = readFileSync(0, "utf8");',
    'if (process.env.FAKE_STDIN_OUT) writeFileSync(process.env.FAKE_STDIN_OUT, prompt);',
    "const finish = () => {",
    '  process.stdout.write(readFileSync(process.env.FAKE_OUT, "utf8"));',
    "  if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);",
    "  if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));",
    "};",
    "if (process.env.FAKE_SLEEP_MS) setTimeout(finish, Number(process.env.FAKE_SLEEP_MS)); else finish();",
  ].join("\n"));
  chmodSync(bin, 0o755);
  return bin;
}

const FAKE_VARS = ["SDLC_CODEX_BIN", "SDLC_CODEX_HOME", "SDLC_CODEX_CREDENTIALS", "FAKE_OUT", "FAKE_STDIN_OUT", "FAKE_ARGV_OUT", "FAKE_ENV_OUT",
  "FAKE_EXIT", "FAKE_STDERR", "FAKE_SLEEP_MS", "FAKE_LOGIN", "FAKE_LOGIN_ENV_OUT", "OPENAI_API_KEY", "CODEX_API_KEY"];

function withFakeCodex(root, output, { exitCode = null, stderr = null, sleepMs = null, credentials = null } = {}) {
  const outPath = join(root, "out.jsonl");
  writeFileSync(outPath, output);
  process.env.SDLC_CODEX_BIN = fakeCodex(root);
  process.env.SDLC_CODEX_HOME = join(root, "codex-home");
  process.env.SDLC_CODEX_CREDENTIALS = credentials ?? join(root, "no-such-auth.json");
  process.env.FAKE_OUT = outPath;
  process.env.FAKE_STDIN_OUT = join(root, "stdin.txt");
  process.env.FAKE_ARGV_OUT = join(root, "argv.json");
  process.env.FAKE_ENV_OUT = join(root, "env.json");
  if (exitCode !== null) process.env.FAKE_EXIT = String(exitCode);
  if (stderr !== null) process.env.FAKE_STDERR = stderr;
  if (sleepMs !== null) process.env.FAKE_SLEEP_MS = String(sleepMs);
}

function clearFakeCodex() {
  for (const k of FAKE_VARS) delete process.env[k];
}

const argvOf = () => JSON.parse(readFileSync(process.env.FAKE_ARGV_OUT, "utf8"));
const envOf = () => JSON.parse(readFileSync(process.env.FAKE_ENV_OUT, "utf8"));
const jsonl = (...events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

const SUCCESS = jsonl(
  { type: "thread.started", thread_id: "thread-1" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
  { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "ls", exit_code: 0, status: "completed" } },
  { type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: "app/x.txt", kind: "add" }], status: "completed" } },
  { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "wrote the file" } },
  { type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90 } },
);

// ---- arguments ---------------------------------------------------------------------

test("a codex turn is a non-interactive exec reading its prompt from stdin, never argv", () => {
  const { args, input } = buildCodexArgs({ prompt: "do the thing", stage: "intent", cwd: "/w" }, "/codex-home");
  assert.equal(args[0], "exec");
  assert.equal(args.at(-1), "-");
  assert.ok(!args.includes("do the thing"));
  assert.equal(input, "do the thing");
  for (const f of ["--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--dangerously-bypass-hook-trust"]) assert.ok(args.includes(f), f);
});

test("a codex turn is isolated in the pipeline's own codex home, with no API key in reach", () => {
  process.env.OPENAI_API_KEY = "sk-not-a-real-key"; process.env.CODEX_API_KEY = "also-not-real";
  try {
    const { env } = buildCodexArgs({ prompt: "x", stage: "intent", env: { OPENAI_API_KEY: "from-a-stage" } }, "/codex-home");
    assert.equal(env.CODEX_HOME, "/codex-home");
    assert.equal(env.SDLC_STAGE, "intent");
    // Subscription sign-in only: a key in the operator's environment, or one a stage
    // declared for its own tools, must not become how the session authenticates.
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
  } finally { delete process.env.OPENAI_API_KEY; delete process.env.CODEX_API_KEY; }
});

test("the sandbox follows what the stage may do: a writing stage gets its workspace, a ruling gets nothing", () => {
  const sandbox = (allowedTools) => {
    const { args } = buildCodexArgs({ prompt: "x", stage: "s", allowedTools }, "/h");
    return args[args.indexOf("--sandbox") + 1];
  };
  assert.equal(sandbox([]), "workspace-write");
  assert.equal(sandbox(["Read", "Write", "Edit", "Glob", "Grep"]), "workspace-write");
  assert.equal(sandbox(["Read", "Grep", "Glob", "Bash(git diff*)", "Bash(git log*)"]), "read-only");
  assert.equal(sandbox(["Read"]), "read-only");
});

test("network is granted only to a writing stage its allowlist gives a shell", () => {
  const net = (allowedTools) => buildCodexArgs({ prompt: "x", stage: "s", allowedTools }, "/h").args
    .includes("sandbox_workspace_write.network_access=true");
  assert.equal(net(["Read", "Write", "Bash(npm *)"]), true);
  assert.equal(net(["Read", "Write", "Edit"]), false);
  assert.equal(net([]), false);
  assert.equal(net(["Read", "Bash(git diff*)"]), false);
});

test("never ask for approval: a command outside the sandbox fails rather than waits", () => {
  const { args } = buildCodexArgs({ prompt: "x", stage: "s" }, "/h");
  const i = args.indexOf('approval_policy="never"');
  assert.ok(i > 0 && args[i - 1] === "-c");
});

test("a model is passed only when one is configured", () => {
  assert.ok(!buildCodexArgs({ prompt: "x", stage: "s" }, "/h").args.includes("--model"));
  const { args } = buildCodexArgs({ prompt: "x", stage: "s", model: "gpt-test" }, "/h");
  assert.equal(args[args.indexOf("--model") + 1], "gpt-test");
});

test("the stage's skill reaches the session as developer instructions, with the workspace's skills listed", () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codex-skill-"));
  const skill = join(root, "SKILL.md"); writeFileSync(skill, "# The stage skill\nDo it \"carefully\".\n");
  const ws = join(root, "ws");
  mkdirSync(join(ws, ".claude", "skills", "house-style"), { recursive: true });
  writeFileSync(join(ws, ".claude", "skills", "house-style", "SKILL.md"), "---\nname: house-style\ndescription: How screens are laid out.\n---\n\nBody.\n");
  const { args } = buildCodexArgs({ prompt: "x", stage: "design", systemPromptFile: skill, cwd: ws }, "/h");
  const arg = args.find((a) => a.startsWith("developer_instructions="));
  assert.ok(arg, "developer_instructions set");
  assert.equal(args[args.indexOf(arg) - 1], "-c");
  // The value is a TOML basic string, which a JSON string literal is.
  const value = JSON.parse(arg.slice("developer_instructions=".length));
  assert.match(value, /# The stage skill\nDo it "carefully"\./);
  // Referenced where it already is, never copied: the path is the workspace's own.
  assert.match(value, /\.claude\/skills\/house-style\/SKILL\.md/);
  assert.match(value, /How screens are laid out\./);
  assert.ok(!value.includes(ws), "names the skill relative to the workspace, not by a local path");
});

test("no skill and no skills directory means no developer instructions at all", () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codex-noskill-"));
  const { args } = buildCodexArgs({ prompt: "x", stage: "s", cwd: root }, "/h");
  assert.ok(!args.some((a) => a.startsWith("developer_instructions=")));
});

test("a stage's MCP servers are named to codex as config overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codex-mcp-"));
  const mcp = join(root, "mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp", "--headless"] } } }));
  const { args } = buildCodexArgs({ prompt: "x", stage: "bind-adapter", mcpConfig: mcp }, "/h");
  assert.ok(args.includes('mcp_servers.playwright.command="npx"'));
  assert.ok(args.includes('mcp_servers.playwright.args=["-y","@playwright/mcp","--headless"]'));
});

test("an MCP server that needs environment values is refused rather than put on the command line", () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codex-mcpenv-"));
  const mcp = join(root, "mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { svc: { command: "svc", env: { TOKEN: "value-that-must-not-leak" } } } }));
  assert.throws(() => buildCodexArgs({ prompt: "x", stage: "s", mcpConfig: mcp }, "/h"), (e) => {
    assert.match(e.message, /svc/);
    assert.match(e.message, /TOKEN/);
    assert.ok(!e.message.includes("value-that-must-not-leak"));
    return true;
  });
});

test("the claude backend's arguments are unchanged when no model is configured", () => {
  const { args } = buildArgs({ prompt: "hi", stage: "build" }, "/cfg");
  assert.deepEqual(args, ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--strict-mcp-config",
    "--no-session-persistence", "--max-turns", "40"]);
  const withModel = buildArgs({ prompt: "hi", stage: "build", model: "opus" }, "/cfg").args;
  assert.equal(withModel[withModel.indexOf("--model") + 1], "opus");
});

// ---- the event stream ----------------------------------------------------------------

test("the event stream is read for the thread, the final message, the steps and the usage", () => {
  const r = parseCodexOutput(SUCCESS);
  assert.equal(r.ok, true);
  assert.equal(r.text, "wrote the file");
  assert.equal(r.sessionId, "thread-1");
  // Codex reports no turn count; the steps it reports are the nearest equivalent.
  assert.equal(r.turns, 3);
  assert.equal(r.cost, 0);
  assert.deepEqual(r.raw.usage, { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90 });
  assert.equal(endedBecause(r.raw), null);
});

test("a failed turn is reported as a failure carrying the CLI's own message", () => {
  const r = parseCodexOutput(jsonl(
    { type: "thread.started", thread_id: "t" },
    { type: "error", message: "Reconnecting... 1/5" },
    { type: "turn.failed", error: { message: "stream disconnected" } },
  ));
  assert.equal(r.ok, false);
  assert.match(r.text, /stream disconnected/);
  assert.equal(endedBecause(r.raw), "ended with turn_failed");
});

test("a stream that never finished its turn is not a success", () => {
  const r = parseCodexOutput(jsonl({ type: "thread.started", thread_id: "t" }, { type: "turn.started" }));
  assert.equal(r.ok, false);
});

test("output with no events at all is not something to parse", () => {
  assert.equal(parseCodexOutput("Error: something\nnot json\n"), null);
});

// ---- a real subprocess ---------------------------------------------------------------

test("runAgent on codex runs the CLI in the workspace, feeds stdin and records what ran the work", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codex-run-"));
  const ws = join(root, "ws"); mkdirSync(ws);
  withFakeCodex(root, SUCCESS);
  try {
    const r = await runAgent({ cwd: ws, prompt: "build it", stage: "probe", maxTurns: 5, agent: { backend: "codex", model: "gpt-test" } });
    assert.equal(r.ok, true);
    assert.equal(r.text, "wrote the file");
    assert.equal(r.sessionId, "thread-1");
    assert.deepEqual(r.engine, { backend: "codex", model: "gpt-test", version: "codex-cli 9.9.9" });
    assert.equal(readFileSync(process.env.FAKE_STDIN_OUT, "utf8"), "build it");
    const argv = argvOf();
    assert.equal(argv[0], "exec");
    assert.equal(argv[argv.indexOf("--model") + 1], "gpt-test");
    const env = envOf();
    assert.equal(env.CODEX_HOME, join(root, "codex-home"));
    assert.equal(env.SDLC_STAGE, "probe");
    assert.equal(env.cwd, ws);
    // The working root is the process's cwd, never a flag carrying a local path.
    assert.ok(!argv.includes("--cd") && !argv.includes("-C"));
  } finally { clearFakeCodex(); }
});

test("with no model configured, the record says the CLI chose it", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codex-nomodel-"));
  withFakeCodex(root, SUCCESS);
  try {
    const r = await runAgent({ cwd: root, prompt: "x", stage: "probe", agent: CODEX });
    assert.deepEqual(r.engine, { backend: "codex", model: "", version: "codex-cli 9.9.9" });
  } finally { clearFakeCodex(); }
});

test("a 200,000-character prompt reaches codex intact on stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codex-big-"));
  const big = "y".repeat(200_000);
  withFakeCodex(root, SUCCESS);
  try {
    const r = await runAgent({ cwd: root, prompt: big, stage: "rule", agent: CODEX });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(process.env.FAKE_STDIN_OUT, "utf8"), big);
  } finally { clearFakeCodex(); }
});

test("a codex turn that could not sign in is told how codex signs in, not how claude does", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codex-auth-"));
  withFakeCodex(root, jsonl(
    { type: "thread.started", thread_id: "t" },
    { type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header" } },
  ), { exitCode: 1 });
  try {
    const r = await runAgent({ cwd: root, prompt: "x", stage: "probe", agent: CODEX });
    assert.equal(r.ok, false);
    assert.match(r.text, /401 Unauthorized/);
    assert.match(r.text, /CODEX_HOME/);
    assert.match(r.text, /auth\.json/);
    assert.ok(!r.text.includes("CLAUDE_CONFIG_DIR"));
    assert.ok(!CODEX_AUTH_ADVICE.includes(homedir()));
  } finally { clearFakeCodex(); }
});

test("codex dying with nothing on stdout throws with its stderr", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codex-die-"));
  withFakeCodex(root, "", { exitCode: 2, stderr: "error: unexpected argument" });
  try {
    await assert.rejects(() => runAgent({ cwd: root, prompt: "x", stage: "probe", agent: CODEX }), /codex failed[\s\S]*unexpected argument/);
  } finally { clearFakeCodex(); }
});

test("codex printing something that is not an event stream throws, quoting it", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codex-garbage-"));
  withFakeCodex(root, "panic: something broke\n");
  try {
    await assert.rejects(() => runAgent({ cwd: root, prompt: "x", stage: "probe", agent: CODEX }), /codex returned no JSONL events[\s\S]*panic: something broke/);
  } finally { clearFakeCodex(); }
});

test("codex has no turn cap, so the runner stops a session at a wall-clock ceiling and says so", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codex-clock-"));
  withFakeCodex(root, SUCCESS, { sleepMs: 5000 });
  try {
    const r = await runAgent({ cwd: root, prompt: "x", stage: "probe", agent: CODEX, wallClockMs: 300 });
    assert.equal(r.ok, false);
    assert.equal(r.raw.terminal_reason, "wall_clock_limit");
    assert.match(r.text, /wall-clock/);
    assert.equal(endedBecause(r.raw), "ended with wall_clock_limit");
  } finally { clearFakeCodex(); }
});

test("the wall-clock ceiling scales with the turn ceiling and never drops below two minutes", () => {
  assert.equal(codexWallClockMs(1), 120_000);
  assert.equal(codexWallClockMs(400), 400 * 30_000);
});

test("the pre-flight on codex is one read-only exec and passes when it answers", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codex-pre-"));
  withFakeCodex(root, jsonl({ type: "thread.started", thread_id: "t" }, { type: "item.completed", item: { type: "agent_message", text: "ok" } }, { type: "turn.completed", usage: {} }));
  try {
    const r = await preflightAuth(CODEX);
    assert.equal(r.ok, true);
    const argv = argvOf();
    assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
    assert.equal(envOf().SDLC_STAGE, "preflight");
  } finally { clearFakeCodex(); }
});

test("the pre-flight on codex refuses with codex's sign-in advice when it cannot authenticate", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codex-prefail-"));
  withFakeCodex(root, jsonl({ type: "turn.failed", error: { message: "401 Unauthorized" } }), { exitCode: 1 });
  try {
    await assert.rejects(() => preflightAuth(CODEX), /was not started[\s\S]*401 Unauthorized[\s\S]*codex login/);
  } finally { clearFakeCodex(); }
});

// ---- the config home -----------------------------------------------------------------

function setMtime(path, secondsAgo) {
  const t = Date.now() / 1000 - secondsAgo;
  utimesSync(path, t, t);
}

test("the codex home links the operator's sign-in and is private to the account", () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codexhome-"));
  const cred = join(root, "auth.json"); writeFileSync(cred, "{\"sentinel\":\"do-not-print\"}");
  const home = join(root, "home"); mkdirSync(home, { recursive: true, mode: 0o755 });
  process.env.SDLC_CODEX_HOME = home; process.env.SDLC_CODEX_CREDENTIALS = cred;
  try {
    assert.equal(codexHomePath(), home);
    const p = ensureCodexHome();
    assert.equal(p, home);
    assert.ok(lstatSync(join(home, "auth.json")).isSymbolicLink());
    assert.equal(statSync(home).mode & 0o777, 0o700);
  } finally { delete process.env.SDLC_CODEX_HOME; delete process.env.SDLC_CODEX_CREDENTIALS; }
});

test("the codex home keeps a sign-in a session refreshed, and takes a newer one from the source", () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codexhome-refresh-"));
  const cred = join(root, "auth.json"); writeFileSync(cred, "{\"seed\":true}");
  const home = join(root, "home"); mkdirSync(home, { recursive: true });
  const link = join(home, "auth.json");
  writeFileSync(link, "{\"refreshed\":true}");
  setMtime(cred, 600); setMtime(link, 60);
  process.env.SDLC_CODEX_HOME = home; process.env.SDLC_CODEX_CREDENTIALS = cred;
  try {
    ensureCodexHome();
    assert.ok(!lstatSync(link).isSymbolicLink());
    assert.equal(readFileSync(link, "utf8"), "{\"refreshed\":true}");
    // Signing in again writes a newer source, and that is the way back.
    setMtime(link, 600); setMtime(cred, 60);
    ensureCodexHome();
    assert.ok(lstatSync(link).isSymbolicLink());
  } finally { delete process.env.SDLC_CODEX_HOME; delete process.env.SDLC_CODEX_CREDENTIALS; }
});

test("the codex home registers the project's implement guard as its one hook, and holds no copy of the credential", () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codexhome-hook-"));
  const cred = join(root, "auth.json"); writeFileSync(cred, "{\"sentinel\":\"do-not-print\"}");
  process.env.SDLC_CODEX_HOME = join(root, "home"); process.env.SDLC_CODEX_CREDENTIALS = cred;
  try {
    const home = ensureCodexHome();
    const hooks = readFileSync(join(home, "hooks.json"), "utf8");
    const parsed = JSON.parse(hooks);
    const pre = parsed.hooks.PreToolUse;
    assert.equal(pre.length, 1);
    assert.equal(pre[0].hooks[0].type, "command");
    assert.match(pre[0].hooks[0].command, /\.sdlc\/hooks\/implement-guard\.sh/);
    assert.ok(!hooks.includes("do-not-print"));
    assert.ok(!hooks.includes(homedir()), "the hook names the guard relative to the session's working root");
  } finally { delete process.env.SDLC_CODEX_HOME; delete process.env.SDLC_CODEX_CREDENTIALS; }
});

test("a failing codex turn never carries the credential it signed in with", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-codex-secret-"));
  const cred = join(root, "auth.json"); writeFileSync(cred, "{\"sentinel\":\"credential-contents\"}");
  withFakeCodex(root, jsonl({ type: "turn.failed", error: { message: "401 Unauthorized" } }), { exitCode: 1, credentials: cred });
  try {
    const r = await runAgent({ cwd: root, prompt: "x", stage: "probe", agent: CODEX });
    assert.ok(!r.text.includes("credential-contents"));
    assert.ok(!JSON.stringify(r.raw).includes("credential-contents"));
    assert.ok(existsSync(join(root, "codex-home", "auth.json")));
  } finally { clearFakeCodex(); }
});

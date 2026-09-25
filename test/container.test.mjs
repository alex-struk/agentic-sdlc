import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, lstatSync, statSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/runner/executor.mjs";
import {
  agentRunArgs, networkCreateArgs, proxyRunArgs, containerUser, agentImageTag, proxyImageTag, AGENT_CLIS,
  WORKSPACE_MOUNT, HOME_MOUNT, PROXY_ALIAS, PROXY_PORT,
} from "../src/runner/container.mjs";

// An isolated agent turn: a throwaway container on a network with no route out, beside an
// egress proxy that lets through only the hosts the turn's allowlist names. `docker` is a
// stand-in that records every call it is given, so what the pipeline asks Docker for is
// asserted here without a daemon; the live run is recorded in `docs/decisions/0061`.

const SENTINEL = "sentinel-credential-never-printed";
const NAMES = { agent: "sdlc-agent-t", proxy: "sdlc-egress-t", network: "sdlc-net-t", session: "t" };

// ---- arguments -----------------------------------------------------------------------------

function flagValues(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag) out.push(args[i + 1]);
  return out;
}

test("the session's network is internal, and the host has no address on it", () => {
  const args = networkCreateArgs(NAMES);
  assert.equal(args[0], "network");
  assert.equal(args[1], "create");
  assert.ok(args.includes("--internal"));
  assert.ok(args.includes("com.docker.network.bridge.inhibit_ipv4=true"));
  assert.equal(args.at(-1), NAMES.network);
});

test("the proxy runs unprivileged on the session's network under its alias, with the allowlist as its only input", () => {
  const args = proxyRunArgs(NAMES, "proxy-image", ["model.example", "registry.example"]);
  assert.deepEqual(args.slice(0, 2), ["run", "-d"]);
  assert.deepEqual(flagValues(args, "--network"), [NAMES.network]);
  assert.deepEqual(flagValues(args, "--network-alias"), [PROXY_ALIAS]);
  assert.ok(flagValues(args, "-e").includes("SDLC_EGRESS_ALLOW=model.example,registry.example"));
  assert.deepEqual(flagValues(args, "--cap-drop"), ["ALL"]);
  assert.ok(args.includes("--read-only"));
  assert.ok(!args.includes("--privileged"));
  assert.ok(!args.some((a) => a === "-v" || a.startsWith("--mount") || a.includes("docker.sock")));
  assert.equal(args.at(-1), "proxy-image");
});

test("the agent container mounts only the workspace and the copy of the CLI home, never the Docker socket", () => {
  const args = agentRunArgs({ names: NAMES, image: "agent-image", user: "1000:1000", readOnly: false, homeEnv: "CODEX_HOME",
    readOnlyHomeFiles: ["hooks.json"], passEnv: ["SDLC_TARGET_URL"], command: ["codex", "exec", "-"] });
  const mounts = flagValues(args, "-v");
  assert.deepEqual(mounts, [`./workspace:${WORKSPACE_MOUNT}`, `./home:${HOME_MOUNT}`, `./home/hooks.json:${HOME_MOUNT}/hooks.json:ro`]);
  assert.ok(!args.some((a) => a.includes("docker.sock") || a === "--mount" || a === "--volumes-from"));
  // Relative sources: no local path is ever on the command line.
  assert.ok(mounts.every((m) => m.startsWith("./")));
  assert.deepEqual(flagValues(args, "--network"), [NAMES.network]);
  assert.deepEqual(flagValues(args, "--user"), ["1000:1000"]);
  assert.deepEqual(flagValues(args, "--cap-drop"), ["ALL"]);
  assert.deepEqual(flagValues(args, "--security-opt"), ["no-new-privileges"]);
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--rm"));
  assert.ok(!args.includes("--privileged"));
  assert.ok(!args.some((a) => a.startsWith("--cap-add") || a.startsWith("--device") || a === "--pid" || a === "--ipc"));
  const env = flagValues(args, "-e");
  const proxy = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) assert.ok(env.includes(`${k}=${proxy}`), k);
  assert.ok(env.includes(`CODEX_HOME=${HOME_MOUNT}`));
  // A stage's own environment crosses by name; its value never reaches the command line.
  assert.ok(env.includes("SDLC_TARGET_URL"));
  assert.deepEqual(flagValues(args, "-w"), [WORKSPACE_MOUNT]);
  assert.deepEqual(args.slice(-4), ["agent-image", "codex", "exec", "-"]);
});

test("a turn that only reads gets its workspace read-only", () => {
  const args = agentRunArgs({ names: NAMES, image: "agent-image", user: "1000:1000", readOnly: true, homeEnv: "CLAUDE_CONFIG_DIR", command: ["claude", "-p"] });
  assert.ok(flagValues(args, "-v").includes(`./workspace:${WORKSPACE_MOUNT}:ro`));
});

test("an isolated session runs as the invoking user, and never as root", () => {
  assert.equal(containerUser(1000, 1000), "1000:1000");
  assert.throws(() => containerUser(0, 0), /root/);
});

test("the agent image is named for its backend and the CLI version the pipeline pins", () => {
  assert.match(agentImageTag("codex"), new RegExp(`^agentic-sdlc-agent:codex-${AGENT_CLIS.codex.version.replace(/\./g, "\\.")}-[0-9a-f]{12}$`));
  assert.match(agentImageTag("claude"), new RegExp(`^agentic-sdlc-agent:claude-${AGENT_CLIS.claude.version.replace(/\./g, "\\.")}-[0-9a-f]{12}$`));
  assert.match(proxyImageTag(), /^agentic-sdlc-egress-proxy:[0-9a-f]{12}$/);
  for (const cli of Object.values(AGENT_CLIS)) assert.match(cli.version, /^\d+\.\d+\.\d+$/);
});

// ---- a turn, through a stand-in docker -----------------------------------------------------

function fakeDocker(root) {
  const bin = join(root, "fake-docker");
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    'import { appendFileSync, readFileSync, writeFileSync, existsSync, realpathSync, readdirSync, statSync, utimesSync } from "node:fs";',
    'import { join } from "node:path";',
    "const args = process.argv.slice(2);",
    'appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");',
    'const has = (...w) => w.every((x) => args.includes(x));',
    'if (args[0] === "version") { process.stdout.write("29.0.0\\n"); process.exit(0); }',
    'if (args[0] === "image" && args[1] === "inspect") {',
    '  const tag = args.at(-1);',
    '  const built = existsSync(process.env.FAKE_DOCKER_BUILT) ? readFileSync(process.env.FAKE_DOCKER_BUILT, "utf8") : "";',
    '  if (process.env.FAKE_DOCKER_NO_IMAGES && !built.includes(tag)) process.exit(1);',
    '  process.stdout.write("sha256:" + (tag.includes("proxy") ? "b" : "a").repeat(64) + "\\n"); process.exit(0);',
    "}",
    'if (args[0] === "build") { appendFileSync(process.env.FAKE_DOCKER_BUILT, args[args.indexOf("-t") + 1] + "\\n"); process.exit(0); }',
    'if (args[0] === "network") { process.stdout.write("net-id\\n"); process.exit(0); }',
    'if (args[0] === "logs") { process.stdout.write("listening on 3128\\n"); process.exit(0); }',
    'if (args[0] === "rm") process.exit(0);',
    'if (args[0] === "run" && args[1] === "-d") { process.stdout.write("proxy-id\\n"); process.exit(0); }',
    'if (args[0] === "run" && args.includes("--version")) { process.stdout.write("codex-cli 0.157.0\\n"); process.exit(0); }',
    'if (args[0] === "run") {',
    '  const ws = realpathSync(join(process.cwd(), "workspace"));',
    '  const home = join(process.cwd(), "home");',
    '  const cred = readdirSync(home).find((f) => f === "auth.json" || f === ".credentials.json");',
    '  writeFileSync(process.env.FAKE_SEEN, JSON.stringify({ ws, workspaceFiles: readdirSync(ws), homeFiles: readdirSync(home),',
    '    credential: cred ? readFileSync(join(home, cred), "utf8") : null, password: process.env.SDLC_SANDBOX_PASSWORD ?? null,',
    '    session: existsSync(join(process.cwd(), "session")) ? readdirSync(join(process.cwd(), "session")) : null }));',
    '  writeFileSync(process.env.FAKE_STDIN_OUT, readFileSync(0, "utf8"));',
    '  if (process.env.FAKE_REFRESH && cred) { const p = join(home, cred); writeFileSync(p, process.env.FAKE_REFRESH); const t = new Date(Date.now() + 60_000); utimesSync(p, t, t); }',
    '  const finish = () => { process.stdout.write(readFileSync(process.env.FAKE_OUT, "utf8")); process.exit(0); };',
    '  if (process.env.FAKE_SLEEP_MS) setTimeout(finish, Number(process.env.FAKE_SLEEP_MS)); else finish();',
    "} else process.exit(0);",
  ].join("\n"));
  chmodSync(bin, 0o755);
  return bin;
}

const VARS = ["SDLC_DOCKER_BIN", "SDLC_CODEX_HOME", "SDLC_CODEX_CREDENTIALS", "SDLC_CLAUDE_HOME", "SDLC_CREDENTIALS", "FAKE_DOCKER_LOG",
  "FAKE_DOCKER_BUILT", "FAKE_DOCKER_NO_IMAGES", "FAKE_SEEN", "FAKE_STDIN_OUT", "FAKE_OUT", "FAKE_REFRESH", "FAKE_SLEEP_MS", "OPENAI_API_KEY"];

const jsonl = (...events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const CODEX_OK = jsonl({ type: "thread.started", thread_id: "thread-c" }, { type: "item.completed", item: { type: "agent_message", text: "done" } },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } });
const CLAUDE_OK = JSON.stringify({ type: "result", is_error: false, result: "done", num_turns: 1, session_id: "s-1", total_cost_usd: 0.01 });

function machine({ output = CODEX_OK, noImages = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sdlc-container-"));
  process.env.SDLC_DOCKER_BIN = fakeDocker(root);
  process.env.FAKE_DOCKER_LOG = join(root, "docker.log");
  process.env.FAKE_DOCKER_BUILT = join(root, "built.txt");
  if (noImages) process.env.FAKE_DOCKER_NO_IMAGES = "1";
  process.env.FAKE_SEEN = join(root, "seen.json");
  process.env.FAKE_STDIN_OUT = join(root, "stdin.txt");
  process.env.FAKE_OUT = join(root, "out.txt");
  writeFileSync(process.env.FAKE_OUT, output);
  const cred = join(root, "operator-auth.json");
  writeFileSync(cred, SENTINEL);
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(cred, old, old);
  process.env.SDLC_CODEX_HOME = join(root, "codex-home");
  process.env.SDLC_CODEX_CREDENTIALS = cred;
  process.env.SDLC_CLAUDE_HOME = join(root, "claude-home");
  process.env.SDLC_CREDENTIALS = cred;
  const ws = join(root, "workspace");
  mkdirSync(ws);
  writeFileSync(join(ws, "input.md"), "the stage's input\n");
  return { root, ws, cred };
}

function clear() { for (const k of VARS) delete process.env[k]; }
const calls = () => readFileSync(process.env.FAKE_DOCKER_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const seen = () => JSON.parse(readFileSync(process.env.FAKE_SEEN, "utf8"));
const agentCall = () => calls().find((c) => c.args[0] === "run" && c.args.includes("-i"));
const ISOLATED = { backend: "codex", model: "", isolation: "container", egress: "model", allow: ["chatgpt.com", "ab.chatgpt.com"] };

test("an isolated codex turn runs in the container, in its workspace, and records what isolated it", async () => {
  const { ws, root } = machine();
  try {
    const r = await runAgent({ cwd: ws, prompt: "do the work", stage: "design", allowedTools: ["Read", "Write", "Edit"], agent: ISOLATED });
    assert.equal(r.ok, true, r.text);
    assert.equal(r.text, "done");
    assert.deepEqual(r.engine, { backend: "codex", model: "", version: "codex-cli 0.157.0", isolation: "container", image: "a".repeat(12), egress: "model" });
    assert.equal(readFileSync(process.env.FAKE_STDIN_OUT, "utf8"), "do the work");
    const s = seen();
    assert.equal(s.ws, ws);
    assert.deepEqual(s.workspaceFiles, ["input.md"]);
    const all = calls();
    const order = all.map((c) => c.args.slice(0, 2).join(" "));
    assert.ok(order.indexOf("network create") < order.indexOf("run -d"));
    const agentAt = all.findIndex((c) => c.args[0] === "run" && c.args.includes("-i"));
    assert.ok(order.indexOf("network create") < order.indexOf("run -d"));
    assert.ok(order.indexOf("run -d") < agentAt);
    // The container is the sandbox: codex's own cannot create namespaces inside one.
    const inner = agentCall().args;
    assert.equal(inner[inner.indexOf("--sandbox") + 1], "danger-full-access");
    // Every container and the network are removed when the turn ends.
    const rm = all.filter((c) => c.args[0] === "rm").flatMap((c) => c.args);
    assert.ok(rm.includes(flagValues(all[agentAt].args, "--name")[0]));
    assert.ok(rm.includes(flagValues(all.find((c) => c.args[1] === "-d").args, "--name")[0]));
    assert.ok(all.some((c) => c.args[0] === "network" && c.args[1] === "rm"));
    // The proxy was given exactly the turn's allowlist.
    const proxy = all.find((c) => c.args[0] === "run" && c.args[1] === "-d").args;
    assert.ok(flagValues(proxy, "-e").includes("SDLC_EGRESS_ALLOW=chatgpt.com,ab.chatgpt.com"));
    // No local path is on any command line Docker was given.
    for (const c of all) for (const a of c.args) {
      assert.ok(!a.includes(root), `local path in ${c.args.join(" ")}`);
      assert.ok(!a.includes(homedir()), `home path in ${c.args.join(" ")}`);
    }
    // The staging directory is gone, and the workspace it linked to is not.
    assert.ok(!existsSync(agentCall().cwd));
    assert.ok(existsSync(join(ws, "input.md")));
  } finally { clear(); }
});

test("the credential reaches the container as a copy and appears in no argument, record or output", async () => {
  const { ws } = machine();
  process.env.OPENAI_API_KEY = "sk-sentinel-key";
  const logged = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => logged.push(a.join(" "));
  try {
    const r = await runAgent({ cwd: ws, prompt: "x", stage: "design", allowedTools: ["Read", "Write"], agent: ISOLATED });
    assert.equal(seen().credential, SENTINEL);
    assert.deepEqual(seen().homeFiles.sort(), ["auth.json", "hooks.json"]);
    const everything = [JSON.stringify(calls()), JSON.stringify(r), logged.join("\n")].join("\n");
    assert.ok(!everything.includes(SENTINEL));
    assert.ok(!everything.includes("sk-sentinel-key"));
    assert.ok(!flagValues(agentCall().args, "-e").some((e) => e.startsWith("OPENAI_API_KEY") || e.startsWith("CODEX_API_KEY")));
  } finally { Object.assign(console, orig); clear(); }
});

test("a credential the session refreshed is kept in the pipeline's home, and an untouched one is not copied back", async () => {
  const { ws } = machine();
  try {
    await runAgent({ cwd: ws, prompt: "x", stage: "design", allowedTools: ["Read", "Write"], agent: ISOLATED });
    const home = process.env.SDLC_CODEX_HOME;
    assert.ok(lstatSync(join(home, "auth.json")).isSymbolicLink(), "an untouched copy leaves the link alone");
    process.env.FAKE_REFRESH = "refreshed-credential";
    await runAgent({ cwd: ws, prompt: "x", stage: "design", allowedTools: ["Read", "Write"], agent: ISOLATED });
    const kept = lstatSync(join(home, "auth.json"));
    assert.ok(kept.isFile());
    assert.equal(kept.mode & 0o777, 0o600);
    assert.equal(readFileSync(join(home, "auth.json"), "utf8"), "refreshed-credential");
    assert.equal(statSync(home).mode & 0o777, 0o700);
  } finally { clear(); }
});

test("a stage's environment crosses into the container by name, and its value never reaches an argument", async () => {
  const { ws } = machine();
  try {
    await runAgent({ cwd: ws, prompt: "x", stage: "design", allowedTools: ["Read", "Write"], env: { SDLC_SANDBOX_PASSWORD: "pw-sentinel" }, agent: ISOLATED });
    assert.equal(seen().password, "pw-sentinel");
    assert.ok(flagValues(agentCall().args, "-e").includes("SDLC_SANDBOX_PASSWORD"));
    assert.ok(!JSON.stringify(calls()).includes("pw-sentinel"));
  } finally { clear(); }
});

test("a turn that only reads gets a read-only workspace", async () => {
  const { ws } = machine();
  try {
    await runAgent({ cwd: ws, prompt: "x", stage: "rule", allowedTools: ["Read", "Grep"], agent: ISOLATED });
    assert.ok(flagValues(agentCall().args, "-v").includes(`./workspace:${WORKSPACE_MOUNT}:ro`));
  } finally { clear(); }
});

test("a missing image is built once, with the CLI version the pipeline pins", async () => {
  const { ws } = machine({ noImages: true });
  try {
    await runAgent({ cwd: ws, prompt: "x", stage: "design", allowedTools: ["Read", "Write"], agent: ISOLATED });
    const builds = calls().filter((c) => c.args[0] === "build").map((c) => c.args);
    assert.equal(builds.length, 2);
    const agentBuild = builds.find((b) => flagValues(b, "-t")[0] === agentImageTag("codex"));
    assert.ok(flagValues(agentBuild, "--build-arg").includes(`CLI_VERSION=${AGENT_CLIS.codex.version}`));
    assert.ok(flagValues(agentBuild, "--build-arg").includes(`CLI_PACKAGE=${AGENT_CLIS.codex.package}`));
    assert.ok(builds.some((b) => flagValues(b, "-t")[0] === proxyImageTag()));
    const before = calls().length;
    await runAgent({ cwd: ws, prompt: "x", stage: "design", allowedTools: ["Read", "Write"], agent: ISOLATED });
    assert.equal(calls().slice(before).filter((c) => c.args[0] === "build").length, 0);
  } finally { clear(); }
});

test("a session past its wall-clock ceiling is stopped, and its container removed", async () => {
  const { ws } = machine();
  process.env.FAKE_SLEEP_MS = "5000";
  try {
    const r = await runAgent({ cwd: ws, prompt: "x", stage: "design", allowedTools: ["Read", "Write"], wallClockMs: 400, agent: ISOLATED });
    assert.equal(r.ok, false);
    assert.equal(r.raw.terminal_reason, "wall_clock_limit");
    const name = flagValues(agentCall().args, "--name")[0];
    assert.ok(calls().some((c) => c.args[0] === "rm" && c.args.includes(name)));
  } finally { clear(); }
});

test("an extra directory is never bind-mounted into an isolated session", async () => {
  const { ws } = machine();
  try {
    await assert.rejects(() => runAgent({ cwd: ws, prompt: "x", stage: "design", addDirs: [tmpdir()], agent: ISOLATED }), /materialise/);
  } finally { clear(); }
});

test("an isolated claude turn reads its skill and its sign-in from inside the container", async () => {
  const { ws, root } = machine({ output: CLAUDE_OK });
  const skillDir = join(root, "skill");
  mkdirSync(skillDir);
  writeFileSync(join(skillDir, "SKILL.md"), "the skill\n");
  try {
    const r = await runAgent({ cwd: ws, prompt: "x", stage: "design", systemPromptFile: join(skillDir, "SKILL.md"), allowedTools: ["Read", "Write"],
      agent: { backend: "claude", model: "", isolation: "container", egress: "model", allow: ["api.anthropic.com"] } });
    assert.equal(r.ok, true, r.text);
    assert.equal(r.engine.isolation, "container");
    const args = agentCall().args;
    assert.equal(args[args.indexOf("--append-system-prompt-file") + 1], "/sdlc/session/SKILL.md");
    assert.ok(flagValues(args, "-e").includes(`CLAUDE_CONFIG_DIR=${HOME_MOUNT}`));
    assert.ok(flagValues(args, "-v").includes("./session:/sdlc/session:ro"));
    assert.deepEqual(seen().session, ["SKILL.md"]);
    assert.deepEqual(seen().homeFiles, [".credentials.json"]);
  } finally { clear(); }
});

test("a mock turn reports the isolation the run resolved", async () => {
  const mock = mkdtempSync(join(tmpdir(), "sdlc-mock-iso-"));
  writeFileSync(join(mock, "design.json"), JSON.stringify({ text: "ok" }));
  process.env.SDLC_EXECUTOR = "mock"; process.env.SDLC_MOCK_DIR = mock;
  try {
    const r = await runAgent({ cwd: mkdtempSync(join(tmpdir(), "sdlc-cwd-iso-")), prompt: "x", stage: "design", agent: ISOLATED });
    assert.deepEqual(r.engine, { backend: "codex", model: "", version: "mock", isolation: "container", image: "mock", egress: "model" });
    const host = await runAgent({ cwd: mkdtempSync(join(tmpdir(), "sdlc-cwd-iso-")), prompt: "x", stage: "design", agent: { backend: "codex" } });
    assert.deepEqual(host.engine, { backend: "codex", model: "", version: "mock" });
  } finally { delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR; }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS } from "../src/cli.mjs";
import "../src/commands/doctor.mjs";

// What `sdlc doctor` says about the agent backends a project's turns will run on: which
// backend runs which stages and gates, whether each CLI is installed and signed in, and which
// stages Codex will refuse. Both CLIs are stand-ins, and both homes are temporary, so nothing
// here reads or touches a real sign-in.

const CONFIG = (agents = "") => `pipeline: { repo: agentic-sdlc, ref: main }
profile: feature
stack: some-stack
project: { name: sample, domains: [alpha] }
policy:
  default_tier: STANDARD
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: tech-lead }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead }
    G-POL: { holder: tech-lead }
${agents}skills: { packs: [] }
egress: { rules: [E-2] }
`;

function project(agents) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-doctor-agents-"));
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "config.yaml"), CONFIG(agents));
  return d;
}

function stub(root, name, body) {
  const bin = join(root, name);
  writeFileSync(bin, ["#!/usr/bin/env node", ...body].join("\n"));
  chmodSync(bin, 0o755);
  return bin;
}

const VARS = ["SDLC_CLAUDE_BIN", "SDLC_CODEX_BIN", "SDLC_CLAUDE_HOME", "SDLC_CREDENTIALS", "SDLC_CODEX_HOME", "SDLC_CODEX_CREDENTIALS", "FAKE_LOGIN", "SDLC_AGENT_BACKEND", "SDLC_AGENT_MODEL",
  "SDLC_DOCKER_BIN", "FAKE_DOCKER_DOWN", "FAKE_DOCKER_IMAGES", "FAKE_DOCKER_LEFTOVERS", "SDLC_AGENT_ISOLATION"];

// A stand-in for `docker`: up or down, with the images `FAKE_DOCKER_IMAGES` names built
// (`agent`, `proxy`), and the session containers `FAKE_DOCKER_LEFTOVERS` names left behind.
function fakeDocker(root) {
  return stub(root, "fake-docker", [
    "const a = process.argv.slice(2);",
    'if (process.env.FAKE_DOCKER_DOWN) { process.stderr.write("Cannot connect to the Docker daemon\\n"); process.exit(1); }',
    'if (a[0] === "version") { process.stdout.write("29.0.0\\n"); process.exit(0); }',
    'if (a[0] === "image" && a[1] === "inspect") {',
    '  const want = a.at(-1).includes("egress-proxy") ? "proxy" : "agent";',
    '  if (!(process.env.FAKE_DOCKER_IMAGES ?? "").split(",").includes(want)) process.exit(1);',
    '  process.stdout.write("sha256:" + (want === "proxy" ? "b" : "a").repeat(64) + "\\n"); process.exit(0);',
    "}",
    'if (a[0] === "ps" || (a[0] === "network" && a[1] === "ls")) { process.stdout.write((process.env.FAKE_DOCKER_LEFTOVERS ?? "").split(",").filter(Boolean).join("\\n")); process.exit(0); }',
    "process.exit(0);",
  ]);
}

function machine({ codexInstalled = true, codexLogin = "Logged in using ChatGPT\n", claudeSignedIn = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sdlc-doctor-machine-"));
  process.env.SDLC_DOCKER_BIN = fakeDocker(root);
  process.env.SDLC_CLAUDE_BIN = stub(root, "fake-claude", ['process.stdout.write("9.9.9 (Claude Code)\\n");']);
  process.env.SDLC_CODEX_BIN = codexInstalled
    ? stub(root, "fake-codex", [
      "const a = process.argv.slice(2);",
      'if (a[0] === "--version") { process.stdout.write("codex-cli 9.9.9\\n"); process.exit(0); }',
      'if (a[0] === "login") { process.stdout.write(process.env.FAKE_LOGIN ?? ""); process.exit(process.env.FAKE_LOGIN ? 0 : 1); }',
    ])
    : join(root, "no-such-codex");
  if (codexLogin) process.env.FAKE_LOGIN = codexLogin;
  const claudeCred = join(root, "claude-credentials.json");
  if (claudeSignedIn) writeFileSync(claudeCred, "{\"sentinel\":\"claude-secret\"}");
  const codexCred = join(root, "auth.json");
  writeFileSync(codexCred, "{\"sentinel\":\"codex-secret\"}");
  process.env.SDLC_CLAUDE_HOME = join(root, "claude-home");
  process.env.SDLC_CREDENTIALS = claudeCred;
  process.env.SDLC_CODEX_HOME = join(root, "codex-home");
  process.env.SDLC_CODEX_CREDENTIALS = codexCred;
}

function clear() {
  for (const k of VARS) delete process.env[k];
}

async function doctor(dir) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let code;
  try { code = await COMMANDS.doctor({ pos: [dir], flags: {} }); } finally { console.log = orig; }
  return { lines, text: lines.join("\n"), code };
}

test("doctor says claude runs everything when the project configures nothing, and whether it is signed in", async () => {
  machine();
  try {
    const { text } = await doctor(project());
    assert.match(text, /^ok {3}agents claude runs every stage with an agent turn and every agent ruling \(G0, G2, G3\); model: the CLI's default model$/m);
    assert.match(text, /^ok {3}claude 9\.9\.9 \(Claude Code\), a sign-in is present in the pipeline's config home$/m);
    assert.doesNotMatch(text, /^\S+\s+codex /m, "a backend nothing runs on is not reported");
    assert.ok(!text.includes("claude-secret"));
  } finally { clear(); }
});

test("doctor names which backend runs which stages and gates when the work is split", async () => {
  machine();
  try {
    const { text } = await doctor(project("  agents:\n    backend: codex\n    model: gpt-test\n    stages: { build: { backend: claude } }\n    rulings: { G3: { backend: claude } }\n"));
    assert.match(text, /^ok {3}agents codex runs intent, plan and rulings at G0, G2; model: gpt-test$/m);
    assert.match(text, /^ok {3}agents claude runs build and rulings at G3; model: the CLI's default model$/m);
    assert.match(text, /^ok {3}codex codex-cli 9\.9\.9, signed in with ChatGPT$/m);
    assert.match(text, /^ok {3}claude 9\.9\.9 \(Claude Code\)/m);
    assert.ok(!text.includes("codex-secret"));
  } finally { clear(); }
});

test("doctor says how to install codex when a backend in use is missing", async () => {
  machine({ codexInstalled: false });
  try {
    const { text, code } = await doctor(project("  agents: { backend: codex }\n"));
    assert.match(text, /^warn codex not found: install it with `npm install -g @openai\/codex`, then run `codex login` and choose ChatGPT$/m);
    // Reported, never a failure of the command: a machine may check a project it runs nothing on.
    assert.equal(code, 0);
  } finally { clear(); }
});

test("doctor says codex is not signed in, and refuses an API-key sign-in by name", async () => {
  machine({ codexLogin: null });
  try {
    const { text } = await doctor(project("  agents: { backend: codex }\n"));
    assert.match(text, /^warn codex codex-cli 9\.9\.9, not signed in: run `codex login` and choose ChatGPT/m);
  } finally { clear(); }
  machine({ codexLogin: "Logged in using an API key - sk-proj-***ABCDE\n" });
  try {
    const { text } = await doctor(project("  agents: { backend: codex }\n"));
    assert.match(text, /^warn codex codex-cli 9\.9\.9, signed in with an API key; the pipeline signs in with ChatGPT only/m);
    assert.ok(!text.includes("ABCDE"), "nothing the CLI says about the account is repeated");
  } finally { clear(); }
});

test("doctor runs the sign-in check against the pipeline's own codex home", async () => {
  machine();
  try {
    await doctor(project("  agents: { backend: codex }\n"));
    // The link doctor's check reads through is the one a stage will read through.
    assert.equal(readFileSync(join(process.env.SDLC_CODEX_HOME, "auth.json"), "utf8"), "{\"sentinel\":\"codex-secret\"}");
  } finally { clear(); }
});

test("doctor warns which stages codex will refuse on the host, and how a project accepts them", async () => {
  machine();
  try {
    const { text } = await doctor(project("  agents: { backend: codex, isolation: none }\n"));
    assert.match(text, /^warn codex refuses plan: codex cannot hold it to its tool allowlist; set policy\.agents\.stages\.plan\.accept_weaker: true to run it there, or run it on claude$/m);
    assert.match(text, /^warn codex refuses build: /m);
    assert.doesNotMatch(text, /codex refuses intent/);
  } finally { clear(); }
});

test("doctor says when the environment overrides the project's choice", async () => {
  machine();
  process.env.SDLC_AGENT_BACKEND = "codex";
  try {
    const { text } = await doctor(project());
    assert.match(text, /^warn agents SDLC_AGENT_BACKEND=codex overrides policy\.agents in this shell$/m);
    assert.match(text, /^ok {3}agents codex runs/m);
  } finally { clear(); }
});

test("doctor names no backend while the config is not valid", async () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-doctor-noconfig-"));
  const { text } = await doctor(d);
  assert.match(text, /^warn agents not resolved: the config is not valid$/m);
});

// ---- isolation -------------------------------------------------------------------------------

test("doctor says for each stage which backend runs it, whether in a container, and what it may reach", async () => {
  machine();
  process.env.FAKE_DOCKER_IMAGES = "agent,proxy";
  try {
    const { text } = await doctor(project("  agents: { backend: codex }\n"));
    assert.match(text, /^ok {3}isolation docker 29\.0\.0 answers, for the turns that run in a container$/m);
    assert.match(text, /^ok {3}isolation codex image agentic-sdlc-agent:codex-0\.157\.0-[0-9a-f]{12} built \(a{12}\)$/m);
    assert.match(text, /^ok {3}isolation egress proxy image agentic-sdlc-egress-proxy:[0-9a-f]{12} built \(b{12}\)$/m);
    assert.match(text, /^ok {3}stage intent: codex, on the host$/m);
    assert.match(text, /^ok {3}stage plan: codex, in a container \(default\), egress model: chatgpt\.com, ab\.chatgpt\.com, auth\.openai\.com$/m);
    assert.match(text, /^ok {3}stage build: codex, in a container \(default\), egress registry: chatgpt\.com, ab\.chatgpt\.com, auth\.openai\.com, registry\.npmjs\.org$/m);
    assert.doesNotMatch(text, /codex refuses/);
  } finally { clear(); }
});

test("doctor says an image is built on first use, or now, when it is missing", async () => {
  machine();
  try {
    const { text, code } = await doctor(project("  agents: { backend: codex }\n"));
    assert.match(text, /^warn isolation codex image agentic-sdlc-agent:codex-\S+ not built: it is built on first use, or now with `sdlc isolation build`$/m);
    assert.match(text, /^warn isolation egress proxy image \S+ not built: it is built on first use, or now with `sdlc isolation build`$/m);
    assert.equal(code, 0);
  } finally { clear(); }
});

test("doctor says which turns cannot run when Docker is not there", async () => {
  machine();
  process.env.FAKE_DOCKER_DOWN = "1";
  try {
    const { text } = await doctor(project("  agents: { backend: codex }\n"));
    assert.match(text, /^warn isolation Docker is not reachable: an isolated session needs a running Docker daemon this account can use; plan, build will be refused until it is$/m);
  } finally { clear(); }
});

test("doctor reports rulings that run in a container, and says nothing about images when nothing is isolated", async () => {
  machine();
  process.env.FAKE_DOCKER_IMAGES = "agent,proxy";
  try {
    const { text } = await doctor(project("  agents:\n    rulings: { G3: { isolation: container } }\n"));
    assert.match(text, /^ok {3}ruling G3: claude, in a container \(policy\.agents\.rulings\.G3\), egress model: api\.anthropic\.com/m);
    assert.match(text, /^ok {3}isolation claude image /m);
  } finally { clear(); }
  machine();
  try {
    const { text } = await doctor(project());
    assert.doesNotMatch(text, /^\S+\s+isolation /m);
    assert.match(text, /^ok {3}stage plan: claude, on the host$/m);
  } finally { clear(); }
});

test("doctor names session containers a stopped run left behind, and how to remove them", async () => {
  machine();
  process.env.FAKE_DOCKER_IMAGES = "agent,proxy";
  process.env.FAKE_DOCKER_LEFTOVERS = "c1,c2";
  try {
    const { text } = await doctor(project("  agents: { backend: codex }\n"));
    assert.match(text, /^warn isolation 2 session containers left behind by a run that did not finish: remove them with `sdlc isolation clean`$/m);
  } finally { clear(); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS } from "../src/cli.mjs";
import "../src/commands/isolation.mjs";
import { agentImageTag, proxyImageTag, AGENT_CLIS } from "../src/runner/container.mjs";

// `sdlc isolation build` builds the images a project's isolated turns need; `sdlc isolation
// clean` removes what a run that did not finish left behind. Docker is a stand-in that
// records what it is asked.

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

function setup(agents) {
  const root = mkdtempSync(join(tmpdir(), "sdlc-isolation-cmd-"));
  const dir = join(root, "project");
  mkdirSync(join(dir, ".sdlc"), { recursive: true });
  writeFileSync(join(dir, ".sdlc", "config.yaml"), CONFIG(agents));
  const bin = join(root, "fake-docker");
  writeFileSync(bin, ["#!/usr/bin/env node", 'import { appendFileSync } from "node:fs";',
    "const a = process.argv.slice(2);",
    'appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(a) + "\\n");',
    'if (a[0] === "image") { process.stdout.write("sha256:" + "c".repeat(64) + "\\n"); process.exit(0); }',
    'if (a[0] === "ps") { process.stdout.write("c1\\nc2\\n"); process.exit(0); }',
    'if (a[0] === "network" && a[1] === "ls") { process.stdout.write("n1\\n"); process.exit(0); }',
    "process.exit(0);"].join("\n"));
  chmodSync(bin, 0o755);
  process.env.SDLC_DOCKER_BIN = bin;
  process.env.FAKE_DOCKER_LOG = join(root, "docker.log");
  return dir;
}

function clear() { for (const k of ["SDLC_DOCKER_BIN", "FAKE_DOCKER_LOG"]) delete process.env[k]; }
const calls = () => (existsSync(process.env.FAKE_DOCKER_LOG) ? readFileSync(process.env.FAKE_DOCKER_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const tagOf = (args) => args[args.indexOf("-t") + 1];

async function quiet(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  try { return { code: await fn(), text: lines.join("\n") }; } finally { console.log = orig; }
}

test("isolation build builds the agent image for each backend the project isolates, and the proxy", async () => {
  const dir = setup("  agents: { backend: codex }\n");
  try {
    const { code, text } = await quiet(() => COMMANDS.isolation({ pos: ["build", dir], flags: {} }));
    assert.equal(code, 0);
    const builds = calls().filter((c) => c[0] === "build");
    assert.deepEqual(builds.map(tagOf).sort(), [agentImageTag("codex"), proxyImageTag()].sort());
    const agent = builds.find((b) => tagOf(b) === agentImageTag("codex"));
    assert.ok(agent.includes(`CLI_VERSION=${AGENT_CLIS.codex.version}`));
    assert.match(text, /built agentic-sdlc-agent:codex-/);
  } finally { clear(); }
});

test("isolation build takes the backend to build for, and builds for none it does not know", async () => {
  const dir = setup();
  try {
    await quiet(() => COMMANDS.isolation({ pos: ["build", dir], flags: { backend: "claude" } }));
    assert.ok(calls().some((c) => c[0] === "build" && tagOf(c) === agentImageTag("claude")));
    await assert.rejects(() => COMMANDS.isolation({ pos: ["build", dir], flags: { backend: "other" } }), /claude, codex/);
  } finally { clear(); }
});

test("isolation build with nothing isolated builds nothing, and says how to name a backend", async () => {
  const dir = setup();
  try {
    const { text } = await quiet(() => COMMANDS.isolation({ pos: ["build", dir], flags: {} }));
    assert.deepEqual(calls().filter((c) => c[0] === "build"), []);
    assert.match(text, /no turn in this project runs in a container.*--backend/);
  } finally { clear(); }
});

test("isolation clean removes the session containers and networks a stopped run left behind", async () => {
  const dir = setup();
  try {
    const { text } = await quiet(() => COMMANDS.isolation({ pos: ["clean", dir], flags: {} }));
    assert.ok(calls().some((c) => c[0] === "rm" && c.includes("c1") && c.includes("c2")));
    assert.ok(calls().some((c) => c[0] === "network" && c[1] === "rm" && c.includes("n1")));
    assert.match(text, /removed 2 containers and 1 network/);
  } finally { clear(); }
});

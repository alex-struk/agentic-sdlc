import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseConfig } from "../src/config/load.mjs";
import { stageAgent, rulingAgent, codexRefusal, isolationRefusal, allowlistsFor, BUILT_IN_ALLOWLISTS } from "../src/runner/agents.mjs";
import { BACKENDS } from "../src/runner/executor.mjs";
import { checkConfig } from "../src/checks/config.mjs";
import { STAGES_BY_NAME } from "../src/stages/registry.mjs";

// Whether an agent turn runs in a container, and what it may reach from there: resolved from
// `policy.agents` the way the backend is, with a default that isolates exactly the turns 0060
// refuses on codex, and an environment override that can only turn isolation on.

const GATES = { G0: { holder: "agent:product-owner", escalate_to: "tech-lead" }, G1: { holder: "agent:product-owner", escalate_to: "tech-lead" },
  "G-DESIGN": { holder: "agent:ux-reviewer" }, G2: { holder: "agent:architect" }, G3: { holder: "agent:reviewer", escalate_to: "tech-lead" },
  "G-POL": { holder: "agent:tech-lead" } };

function config(agents, extra = {}) {
  return {
    pipeline: { repo: "x/y", ref: "main" }, profile: "rebuild", stack: "some-stack",
    project: { name: "neutral", domains: ["orders"] },
    policy: { gates: GATES, default_tier: "STANDARD", ...(agents === undefined ? {} : { agents }) },
    skills: { packs: [] }, egress: { rules: ["E-2"] }, ...extra,
  };
}

const NO_ENV = {};
const BLIND = { name: "blind-stage", allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"] };
const SHELL = { name: "shell-stage", allowedTools: ["Read", "Write", "Bash(npm *)"], egress: "registry" };
const OPEN = { name: "open-stage" };
const HOST_BOUND = { name: "host-bound", allowedTools: ["Read", "Write"], isolationBlocker: (c) => (c?.oracle ? "it drives the oracle through the host's Docker." : null) };
const CODEX_HOSTS = BACKENDS.codex.endpoints;

// ---- schema --------------------------------------------------------------------------------

test("policy.agents takes isolation, an egress allowlist per stage and ruling, and named allowlists", () => {
  const { errors } = parseConfig(stringify(config({
    backend: "codex", isolation: "container",
    allowlists: { mirror: ["npm.example.org", "*.cdn.example.org:8443"] },
    stages: { build: { isolation: "container", egress: "mirror" }, design: { isolation: "none", accept_weaker: true } },
    rulings: { G3: { isolation: "container", egress: "model" } },
  })));
  assert.deepEqual(errors, []);
});

test("the schema refuses an isolation it does not know, a host that is not a host, and a malformed list name", () => {
  assert.ok(parseConfig(stringify(config({ isolation: "vm" }))).errors.length);
  assert.ok(parseConfig(stringify(config({ stages: { build: { isolation: "off" } } }))).errors.length);
  assert.ok(parseConfig(stringify(config({ allowlists: { mirror: ["https://npm.example.org"] } }))).errors.length);
  assert.ok(parseConfig(stringify(config({ allowlists: { mirror: ["*"] } }))).errors.length);
  assert.ok(parseConfig(stringify(config({ allowlists: { Mirror: ["npm.example.org"] } }))).errors.length);
  assert.ok(parseConfig(stringify(config({ stages: { build: { egress: "Not A Name" } } }))).errors.length);
});

// ---- defaults ------------------------------------------------------------------------------

test("on codex a stage that declares a tool allowlist runs in a container by default, reaching only the model", () => {
  const a = stageAgent(config({ backend: "codex" }), BLIND, NO_ENV);
  assert.equal(a.backend, "codex");
  assert.equal(a.isolation, "container");
  assert.equal(a.isolationFrom, "default");
  assert.equal(a.egress, "model");
  assert.deepEqual(a.allow, CODEX_HOSTS);
});

test("a stage that declares a package registry reaches it as well as the model", () => {
  const a = stageAgent(config({ backend: "codex" }), SHELL, NO_ENV);
  assert.equal(a.isolation, "container");
  assert.equal(a.egress, "registry");
  assert.deepEqual(a.allow, [...CODEX_HOSTS, ...BUILT_IN_ALLOWLISTS.registry]);
});

test("claude, and a codex stage with no allowlist, run on the host unless configured otherwise", () => {
  assert.equal(stageAgent(config(), BLIND, NO_ENV).isolation, "none");
  assert.equal(stageAgent(config({ backend: "codex" }), OPEN, NO_ENV).isolation, "none");
  const none = stageAgent(config(), BLIND, NO_ENV);
  assert.equal(none.egress, null);
  assert.deepEqual(none.allow, []);
});

test("a stage that needs something only the host has is not isolated by default", () => {
  const withOracle = config({ backend: "codex" }, { oracle: { compose: "compose.yaml" } });
  assert.equal(stageAgent(withOracle, HOST_BOUND, NO_ENV).isolation, "none");
  assert.equal(stageAgent(config({ backend: "codex" }), HOST_BOUND, NO_ENV).isolation, "container");
});

test("of the pipeline's own stages, codex isolates every one with an allowlist that needs nothing on the host", () => {
  const plain = config({ backend: "codex" });
  const withOracle = config({ backend: "codex" }, { oracle: { compose: "compose.yaml" } });
  const on = (c, name) => stageAgent(c, STAGES_BY_NAME[name], NO_ENV);
  for (const name of ["derive-tests", "design", "plan", "build", "contract"]) {
    assert.equal(on(plain, name).isolation, "container", name);
    assert.equal(codexRefusal(STAGES_BY_NAME[name], plain, on(plain, name)), null, name);
  }
  assert.equal(on(plain, "build").egress, "registry");
  assert.equal(on(plain, "design").egress, "model");
  // The contract stage drives the oracle through the host's Docker where there is one, and
  // bind-adapter drives a browser against the host's target: neither can be isolated.
  assert.equal(on(withOracle, "contract").isolation, "none");
  assert.ok(codexRefusal(STAGES_BY_NAME.contract, withOracle, on(withOracle, "contract")));
  assert.equal(on(plain, "bind-adapter").isolation, "none");
  assert.ok(codexRefusal(STAGES_BY_NAME["bind-adapter"], plain, on(plain, "bind-adapter")));
  // Stages with no allowlist run on codex on the host, as they did.
  for (const name of ["intent", "archaeology"]) assert.equal(on(plain, name).isolation, "none", name);
});

// ---- configuration -------------------------------------------------------------------------

test("the project turns isolation on or off for every turn, and a stage's own entry wins", () => {
  const c = config({ backend: "codex", isolation: "none", stages: { "shell-stage": { isolation: "container" } } });
  assert.equal(stageAgent(c, BLIND, NO_ENV).isolation, "none");
  assert.equal(stageAgent(c, BLIND, NO_ENV).isolationFrom, "policy.agents");
  assert.equal(stageAgent(c, SHELL, NO_ENV).isolation, "container");
  assert.equal(stageAgent(c, SHELL, NO_ENV).isolationFrom, "policy.agents.stages.shell-stage");
  // Claude may run isolated too.
  assert.equal(stageAgent(config({ isolation: "container" }), OPEN, NO_ENV).isolation, "container");
});

test("a stage's egress names a list: a built-in one, or one the project defines or redefines", () => {
  const c = config({ backend: "codex", allowlists: { registry: ["npm.example.org"], mirror: ["pkgs.example.org"] },
    stages: { "blind-stage": { egress: "mirror" } } });
  assert.deepEqual(stageAgent(c, SHELL, NO_ENV).allow, [...CODEX_HOSTS, "npm.example.org"]);
  const blind = stageAgent(c, BLIND, NO_ENV);
  assert.equal(blind.egress, "mirror");
  assert.deepEqual(blind.allow, [...CODEX_HOSTS, "pkgs.example.org"]);
  assert.deepEqual(Object.keys(allowlistsFor(c)).sort(), ["mirror", "model", "registry"]);
});

test("a ruling runs on the host unless its gate, its persona or the project isolates it", () => {
  assert.equal(rulingAgent(config({ backend: "codex" }), { gate: "G3", persona: "reviewer" }, NO_ENV).isolation, "none");
  const c = config({ backend: "codex", rulings: { reviewer: { isolation: "container" }, G3: { isolation: "none" } } });
  assert.equal(rulingAgent(c, { gate: "G2", persona: "reviewer" }, NO_ENV).isolation, "container");
  // The gate's entry is the more specific.
  assert.equal(rulingAgent(c, { gate: "G3", persona: "reviewer" }, NO_ENV).isolation, "none");
  const ruled = rulingAgent(config({ isolation: "container" }), { gate: "G2", persona: "architect" }, NO_ENV);
  assert.equal(ruled.isolation, "container");
  assert.equal(ruled.egress, "model");
});

test("the environment can isolate one run, and can never turn isolation off", () => {
  const on = stageAgent(config(), OPEN, { SDLC_AGENT_ISOLATION: "container" });
  assert.equal(on.isolation, "container");
  assert.equal(on.isolationFrom, "SDLC_AGENT_ISOLATION");
  assert.equal(rulingAgent(config(), { gate: "G3", persona: "reviewer" }, { SDLC_AGENT_ISOLATION: "container" }).isolation, "container");
  assert.throws(() => stageAgent(config({ backend: "codex" }), BLIND, { SDLC_AGENT_ISOLATION: "none" }), /SDLC_AGENT_ISOLATION.*only turn isolation on/);
  assert.throws(() => stageAgent(config(), OPEN, { SDLC_AGENT_ISOLATION: "off" }), /SDLC_AGENT_ISOLATION/);
});

// ---- what isolation lifts ------------------------------------------------------------------

test("isolation lifts codex's refusal, and turning it off brings the refusal back", () => {
  const isolated = config({ backend: "codex" });
  assert.equal(codexRefusal(BLIND, isolated, stageAgent(isolated, BLIND, NO_ENV)), null);
  assert.equal(codexRefusal(SHELL, isolated, stageAgent(isolated, SHELL, NO_ENV)), null);
  const off = config({ backend: "codex", stages: { "blind-stage": { isolation: "none" } } });
  const refusal = codexRefusal(BLIND, off, stageAgent(off, BLIND, NO_ENV));
  assert.match(refusal, /blind-stage/);
  assert.match(refusal, /isolation: container/);
  assert.match(refusal, /accept_weaker: true/);
  const accepted = config({ backend: "codex", stages: { "blind-stage": { isolation: "none", accept_weaker: true } } });
  assert.equal(codexRefusal(BLIND, accepted, stageAgent(accepted, BLIND, NO_ENV)), null);
});

test("a stage that cannot be isolated keeps codex's refusal, and says why isolation cannot lift it", () => {
  const c = config({ backend: "codex" }, { oracle: { compose: "compose.yaml" } });
  const agent = stageAgent(c, HOST_BOUND, NO_ENV);
  const refusal = codexRefusal(HOST_BOUND, c, agent);
  assert.match(refusal, /host-bound/);
  assert.match(refusal, /cannot run in a container/);
  assert.match(refusal, /drives the oracle through the host's Docker/);
});

test("isolating a stage that cannot be isolated is refused rather than run without it", () => {
  const withOracle = { oracle: { compose: "compose.yaml" } };
  const explicit = config({ stages: { "host-bound": { isolation: "container" } } }, withOracle);
  assert.match(isolationRefusal(HOST_BOUND, explicit, stageAgent(explicit, HOST_BOUND, NO_ENV)),
    /host-bound is set to run in a container \(policy\.agents\.stages\.host-bound\)[\s\S]*drives the oracle[\s\S]*isolation: none/);
  const fromEnv = config(undefined, withOracle);
  assert.match(isolationRefusal(HOST_BOUND, fromEnv, stageAgent(fromEnv, HOST_BOUND, { SDLC_AGENT_ISOLATION: "container" })), /SDLC_AGENT_ISOLATION/);
  assert.equal(isolationRefusal(HOST_BOUND, config(), stageAgent(config(), HOST_BOUND, NO_ENV)), null);
  assert.equal(isolationRefusal(BLIND, config({ isolation: "container" }), stageAgent(config({ isolation: "container" }), BLIND, NO_ENV)), null);
});

// ---- checks --------------------------------------------------------------------------------

function project(agents) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-isolation-check-"));
  mkdirSync(join(dir, ".sdlc"), { recursive: true });
  writeFileSync(join(dir, ".sdlc", "config.yaml"), stringify(config(agents)));
  return dir;
}

test("checks refuses an egress naming a list that neither the pipeline nor the project defines", () => {
  const r = checkConfig(project({ stages: { build: { egress: "nowhere" } }, rulings: { G3: { egress: "elsewhere" } } }));
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => /policy\.agents\.stages\.build\.egress.*nowhere/.test(m)), r.messages.join("\n"));
  assert.ok(r.messages.some((m) => /policy\.agents\.rulings\.G3\.egress.*elsewhere/.test(m)), r.messages.join("\n"));
  assert.deepEqual(checkConfig(project({ allowlists: { mirror: ["npm.example.org"] }, stages: { build: { egress: "mirror" } } })).messages, []);
});

test("an isolated turn on a machine with no Docker is refused before anything is spent, and a mock turn is never checked", async () => {
  const { isolationUnavailable } = await import("../src/runner/agents.mjs");
  const agent = stageAgent(config({ backend: "codex" }), BLIND, NO_ENV);
  const down = () => ({ ok: false, said: "Docker is not reachable" });
  const prev = process.env.SDLC_EXECUTOR;
  delete process.env.SDLC_EXECUTOR;
  try {
    assert.match(isolationUnavailable(agent, down), /runs in a container \(default\), and Docker is not reachable/);
    assert.equal(isolationUnavailable(agent, () => ({ ok: true })), null);
    assert.equal(isolationUnavailable(stageAgent(config(), BLIND, NO_ENV), down), null);
    process.env.SDLC_EXECUTOR = "mock";
    assert.equal(isolationUnavailable(agent, down), null);
  } finally { if (prev === undefined) delete process.env.SDLC_EXECUTOR; else process.env.SDLC_EXECUTOR = prev; }
});

test("each backend's endpoints are its model host, its feature-flag host where it reads one, and its sign-in refresh host", () => {
  assert.deepEqual(BACKENDS.codex.endpoints, ["chatgpt.com", "ab.chatgpt.com", "auth.openai.com"]);
  assert.deepEqual(BACKENDS.claude.endpoints, ["api.anthropic.com", "console.anthropic.com", "platform.claude.com"]);
});

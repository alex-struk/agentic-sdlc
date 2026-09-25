import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseConfig } from "../src/config/load.mjs";
import { agentFor, rulingAgentFor, codexRefusal, agentsInUse } from "../src/runner/agents.mjs";
import { checkConfig } from "../src/checks/config.mjs";

const GATES = { G0: { holder: "agent:product-owner", escalate_to: "tech-lead" }, G1: { holder: "agent:product-owner", escalate_to: "tech-lead" },
  "G-DESIGN": { holder: "agent:ux-reviewer" }, G2: { holder: "agent:architect" }, G3: { holder: "agent:reviewer", escalate_to: "tech-lead" },
  "G-POL": { holder: "agent:tech-lead" } };

function config(agents) {
  return {
    pipeline: { repo: "x/y", ref: "main" }, profile: "rebuild", stack: "some-stack",
    project: { name: "neutral", domains: ["orders"] },
    policy: { gates: GATES, default_tier: "STANDARD", ...(agents === undefined ? {} : { agents }) },
    skills: { packs: [] }, egress: { rules: ["E-2"] },
  };
}

const NO_ENV = {};

// ---- schema ----------------------------------------------------------------------------

test("policy.agents validates the shape a project writes to move work to codex", () => {
  const { errors } = parseConfig(stringify(config({
    backend: "codex", model: "gpt-test",
    stages: { build: { backend: "claude", model: "opus" }, design: { accept_weaker: true } },
    rulings: { G3: { backend: "claude" }, "product-owner": { model: "gpt-test-mini" } },
  })));
  assert.deepEqual(errors, []);
});

test("policy.agents refuses a backend nobody implements, and keys it does not know", () => {
  assert.ok(parseConfig(stringify(config({ backend: "other" }))).errors.length);
  assert.ok(parseConfig(stringify(config({ backend: "codex", sandbox: "off" }))).errors.length);
  assert.ok(parseConfig(stringify(config({ stages: { build: { backend: "codex", tools: [] } } }))).errors.length);
  // A ruling has nothing weaker to accept: its sandbox is read-only on either backend.
  assert.ok(parseConfig(stringify(config({ rulings: { G3: { accept_weaker: true } } }))).errors.length);
});

// ---- resolution --------------------------------------------------------------------------

test("with nothing configured every turn runs on claude with the CLI's own model", () => {
  assert.deepEqual(agentFor(config(), "build", NO_ENV), { backend: "claude", model: "", from: "default" });
  assert.deepEqual(rulingAgentFor(config(), { gate: "G3", persona: "reviewer" }, NO_ENV), { backend: "claude", model: "", from: "default" });
});

test("the project default applies to every stage and ruling it does not name", () => {
  const c = config({ backend: "codex", model: "gpt-test" });
  assert.deepEqual(agentFor(c, "build", NO_ENV), { backend: "codex", model: "gpt-test", from: "policy.agents" });
  assert.deepEqual(rulingAgentFor(c, { gate: "G2", persona: "architect" }, NO_ENV), { backend: "codex", model: "gpt-test", from: "policy.agents" });
});

test("a stage's own entry wins over the default, and a model belongs to the backend it is written beside", () => {
  const c = config({ backend: "codex", model: "gpt-test", stages: { build: { backend: "claude" }, plan: { model: "gpt-other" } } });
  // `build` moved to claude and named no model, so the codex model does not follow it.
  assert.deepEqual(agentFor(c, "build", NO_ENV), { backend: "claude", model: "", from: "policy.agents.stages.build" });
  // `plan` kept the default backend and named its own model.
  assert.deepEqual(agentFor(c, "plan", NO_ENV), { backend: "codex", model: "gpt-other", from: "policy.agents.stages.plan" });
});

test("a ruling is chosen by its gate first, then by the persona ruling it, then the default", () => {
  const c = config({ backend: "claude", rulings: { G3: { backend: "codex" }, reviewer: { backend: "claude", model: "opus" }, architect: { backend: "codex", model: "gpt-test" } } });
  assert.equal(rulingAgentFor(c, { gate: "G3", persona: "reviewer" }, NO_ENV).backend, "codex");
  assert.deepEqual(rulingAgentFor(c, { gate: "G2", persona: "architect" }, NO_ENV), { backend: "codex", model: "gpt-test", from: "policy.agents.rulings.architect" });
  assert.equal(rulingAgentFor(c, { gate: "G0", persona: "product-owner" }, NO_ENV).backend, "claude");
});

test("the environment overrides every configured choice for one run", () => {
  const c = config({ backend: "claude", model: "opus", stages: { build: { backend: "claude", model: "sonnet" } } });
  // The backend changed, so a model configured for claude is not carried to codex.
  assert.deepEqual(agentFor(c, "build", { SDLC_AGENT_BACKEND: "codex" }), { backend: "codex", model: "", from: "SDLC_AGENT_BACKEND" });
  assert.deepEqual(agentFor(c, "build", { SDLC_AGENT_BACKEND: "codex", SDLC_AGENT_MODEL: "gpt-test" }), { backend: "codex", model: "gpt-test", from: "SDLC_AGENT_BACKEND" });
  // A model alone keeps the configured backend.
  assert.deepEqual(agentFor(c, "build", { SDLC_AGENT_MODEL: "haiku" }), { backend: "claude", model: "haiku", from: "SDLC_AGENT_MODEL" });
  assert.equal(rulingAgentFor(c, { gate: "G3", persona: "reviewer" }, { SDLC_AGENT_BACKEND: "codex" }).backend, "codex");
});

test("an environment override naming a backend nobody implements is refused, not ignored", () => {
  assert.throws(() => agentFor(config(), "build", { SDLC_AGENT_BACKEND: "gemini" }), /SDLC_AGENT_BACKEND.*gemini.*claude, codex/);
});

// ---- what codex cannot promise --------------------------------------------------------------

const NO_SHELL = { name: "blind-stage", allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"] };
const SHELL = { name: "shell-stage", allowedTools: ["Read", "Write", "Bash(npm *)"] };
const OPEN = { name: "open-stage" };

test("a stage whose allowlist gives it no shell is refused on codex, saying why and how to opt in", () => {
  const c = config({ backend: "codex" });
  const refusal = codexRefusal(NO_SHELL, c, { backend: "codex" });
  assert.ok(refusal);
  assert.match(refusal, /blind-stage/);
  assert.match(refusal, /no shell/);
  assert.match(refusal, /policy\.agents\.stages\.blind-stage\.accept_weaker: true/);
});

test("a stage with a shell, or with no allowlist, runs on codex; any stage runs on claude", () => {
  const c = config({ backend: "codex" });
  assert.equal(codexRefusal(SHELL, c, { backend: "codex" }), null);
  assert.equal(codexRefusal(OPEN, c, { backend: "codex" }), null);
  assert.equal(codexRefusal(NO_SHELL, c, { backend: "claude" }), null);
});

test("the project opts a stage in explicitly, and only that stage", () => {
  const c = config({ backend: "codex", stages: { "blind-stage": { accept_weaker: true } } });
  assert.equal(codexRefusal(NO_SHELL, c, { backend: "codex" }), null);
  assert.ok(codexRefusal({ ...NO_SHELL, name: "other-blind" }, c, { backend: "codex" }));
});

test("the environment override cannot lift the refusal", () => {
  const c = config();
  const agent = agentFor(c, "blind-stage", { SDLC_AGENT_BACKEND: "codex" });
  assert.ok(codexRefusal(NO_SHELL, c, agent));
});

// ---- what is in use -------------------------------------------------------------------------

test("agentsInUse names each backend and what it runs", () => {
  const c = config({ backend: "codex", stages: { build: { backend: "claude" } }, rulings: { G3: { backend: "claude" } } });
  const used = agentsInUse(c, NO_ENV, ["intent", "build", "plan"]);
  assert.deepEqual(used.map((u) => u.backend).sort(), ["claude", "codex"]);
  const claude = used.find((u) => u.backend === "claude");
  assert.deepEqual(claude.stages, ["build"]);
  assert.deepEqual(claude.rulings, ["G3"]);
  const codex = used.find((u) => u.backend === "codex");
  assert.deepEqual(codex.stages, ["intent", "plan"]);
});

// ---- checks -----------------------------------------------------------------------------

function project(agents) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-agents-check-"));
  mkdirSync(join(dir, ".sdlc"), { recursive: true });
  writeFileSync(join(dir, ".sdlc", "config.yaml"), stringify(config(agents)));
  return dir;
}

test("checks refuses an agents entry for a stage that does not exist or has no agent", () => {
  const r = checkConfig(project({ stages: { "no-such-stage": { backend: "codex" }, ratify: { backend: "codex" } } }));
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => /policy\.agents\.stages\.no-such-stage/.test(m)));
  assert.ok(r.messages.some((m) => /policy\.agents\.stages\.ratify.*no agent turn/.test(m)));
});

test("checks refuses a ruling entry naming neither a gate nor a persona that holds one", () => {
  const r = checkConfig(project({ rulings: { G9: { backend: "codex" }, "nobody-here": { backend: "codex" }, G3: { backend: "codex" }, reviewer: { backend: "codex" } } }));
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => /policy\.agents\.rulings\.G9/.test(m)));
  assert.ok(r.messages.some((m) => /policy\.agents\.rulings\.nobody-here/.test(m)));
  assert.ok(!r.messages.some((m) => /rulings\.G3|rulings\.reviewer/.test(m)));
});

test("checks accepts a valid agents block", () => {
  const r = checkConfig(project({ backend: "codex", stages: { build: { backend: "claude" } }, rulings: { G3: { backend: "claude" } } }));
  assert.deepEqual(r.messages, []);
});

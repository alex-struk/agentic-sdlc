import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { propose } from "../src/commands/propose.mjs";
import { runStage } from "../src/commands/run.mjs";
import { rule, ruleByAgent } from "../src/commands/rule.mjs";
import { buildSite } from "../src/commands/status.mjs";
import { readJournal } from "../src/runner/journal.mjs";
import { registerStage } from "../src/stages/registry.mjs";
import { engineLabel } from "../src/lib/engine.mjs";

// What ran the work, followed from the configuration that chose it to every record that
// says so: the run record, the journal, the proposal page, an agent ruling's gate file and
// the ruling it appends to the proposal, and the state site. The mock executor reports the
// backend and model the run resolved, with `mock` as the CLI version.

const FROM = fileURLToPath(new URL("../fixture-project/fixture.config.yaml", import.meta.url));
const PROBE_SKILL = fileURLToPath(new URL("../src/stages/skills/probe.md", import.meta.url));
const T = ["-c", "user.name=t", "-c", "user.email=t@example.org"];

async function makeProject(tmp) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  const dir = join(tmp, "neutral-project");
  await newProject({ dir, from: FROM });
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  git(["add", "-A"], dir);
  git([...T, "commit", "-q", "-m", "fill constitution"], dir);
  return { dir, prevEgress };
}

// Lines under `policy:`, the way a project's config carries `policy.agents`.
function setPolicy(dir, ...lines) {
  const p = join(dir, ".sdlc/config.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^  default_tier: (\S+)$/m, (m) => `${m}\n${lines.map((l) => `  ${l}`).join("\n")}`));
  git(["add", "-A"], dir);
  git([...T, "commit", "-q", "-m", "policy"], dir);
}

function mock(files) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-mock-prov-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, `${name}.json`), JSON.stringify(body));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = d;
}

function cleanup(prevEgress) {
  for (const k of ["SDLC_EXECUTOR", "SDLC_MOCK_DIR", "SDLC_AGENT_BACKEND", "SDLC_AGENT_MODEL"]) delete process.env[k];
  if (prevEgress === undefined) delete process.env.SDLC_EGRESS_NAMES;
  else process.env.SDLC_EGRESS_NAMES = prevEgress;
}

function runRecord(dir) {
  const runs = join(dir, ".sdlc", "runs");
  return readdirSync(runs).map((f) => readFileSync(join(runs, f), "utf8")).join("\n");
}

const PROBE = { text: "wrote the probe file", files: { "app/PROBE.md": "the runner works\n" } };

test("engineLabel names the backend, the model and the CLI, and says when the CLI chose the model", () => {
  assert.equal(engineLabel({ backend: "codex", model: "gpt-test", version: "codex-cli 1.2.3" }), "codex gpt-test (codex-cli 1.2.3)");
  assert.equal(engineLabel({ backend: "claude", model: "", version: "" }), "claude, the CLI's default model");
  assert.equal(engineLabel(null), "");
});

test("a stage run on codex says so in the journal, the run record and the state site", async () => {
  const { dir, prevEgress } = await makeProject(mkdtempSync(join(tmpdir(), "sdlc-prov-stage-")));
  setPolicy(dir, "agents:", "  backend: codex", "  model: gpt-test");
  mock({ probe: PROBE });
  try {
    const r = await runStage(dir, "probe");
    assert.equal(r.ok, true);
    const [entry] = readJournal(dir).filter((e) => e.stage === "probe");
    assert.equal(entry.backend, "codex");
    assert.equal(entry.model, "gpt-test");
    assert.equal(entry.cli, "mock");
    assert.match(runRecord(dir), /run probe: ok, cost 0, turns 1, on codex gpt-test \(mock\)/);
    buildSite(dir);
    assert.match(readFileSync(join(dir, "site", "journal.md"), "utf8"), /cost \$0 · turns 1 · codex gpt-test \(mock\)/);
  } finally { cleanup(prevEgress); }
});

test("an operator's environment override is what the record says ran the work", async () => {
  const { dir, prevEgress } = await makeProject(mkdtempSync(join(tmpdir(), "sdlc-prov-env-")));
  mock({ probe: PROBE });
  process.env.SDLC_AGENT_BACKEND = "codex";
  process.env.SDLC_AGENT_MODEL = "gpt-env";
  try {
    assert.equal((await runStage(dir, "probe")).ok, true);
    const [entry] = readJournal(dir).filter((e) => e.stage === "probe");
    assert.equal(entry.backend, "codex");
    assert.equal(entry.model, "gpt-env");
  } finally { cleanup(prevEgress); }
});

test("a project that configures nothing records claude as what ran the work", async () => {
  const { dir, prevEgress } = await makeProject(mkdtempSync(join(tmpdir(), "sdlc-prov-default-")));
  mock({ probe: PROBE });
  try {
    assert.equal((await runStage(dir, "probe")).ok, true);
    const [entry] = readJournal(dir).filter((e) => e.stage === "probe");
    assert.equal(entry.backend, "claude");
    assert.equal(entry.model, "");
    assert.match(runRecord(dir), /run probe: ok, cost 0, turns 1, on claude, the CLI's default model \(mock\)/);
  } finally { cleanup(prevEgress); }
});

// A stage whose Claude allowlist gives it no shell: what the refusal is about.
function registerBlind(name, gate = null) {
  registerStage({
    name, title: name, skill: PROBE_SKILL, workspace: "project", gate, collect: [], implemented: true,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
    prompt: () => "write the probe file",
    proposal: () => ({ name: `${name}-1`, question: "Is the probe right?", recommendation: "Approve it." }),
    preChecks: () => [], postChecks: () => [],
  });
}

test("a stage with no shell is refused on codex on the host before anything is spent, and the refusal is recorded", async () => {
  const { dir, prevEgress } = await makeProject(mkdtempSync(join(tmpdir(), "sdlc-prov-refuse-")));
  registerBlind("blind-probe");
  setPolicy(dir, "agents:", "  backend: codex", "  isolation: none");
  // No canned reply: a turn that ran would fail the mock outright.
  mock({});
  try {
    const r = await runStage(dir, "blind-probe");
    assert.equal(r.ok, false);
    assert.match(r.messages.join("\n"), /blind-probe is set to run on codex[\s\S]*accept_weaker: true/);
    assert.match(runRecord(dir), /run blind-probe: pre-checks failed/);
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally { cleanup(prevEgress); }
});

test("the environment override cannot move a stage with no shell onto codex on the host", async () => {
  const { dir, prevEgress } = await makeProject(mkdtempSync(join(tmpdir(), "sdlc-prov-refuse-env-")));
  registerBlind("blind-probe-env");
  setPolicy(dir, "agents:", "  isolation: none");
  mock({});
  process.env.SDLC_AGENT_BACKEND = "codex";
  try {
    const r = await runStage(dir, "blind-probe-env");
    assert.equal(r.ok, false);
    assert.match(r.messages.join("\n"), /SDLC_AGENT_BACKEND chose codex/);
  } finally { cleanup(prevEgress); }
});

test("a gated stage the project opted in runs on codex, and its proposal page names the engine", async () => {
  const { dir, prevEgress } = await makeProject(mkdtempSync(join(tmpdir(), "sdlc-prov-optin-")));
  registerBlind("blind-gated", "G0");
  setPolicy(dir, "agents:", "  backend: codex", "  model: gpt-test", "  stages:", "    blind-gated: { accept_weaker: true }");
  mock({ "blind-gated": PROBE });
  try {
    const r = await runStage(dir, "blind-gated");
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    const page = git(["show", "proposal/blind-gated-1:.sdlc/proposals/blind-gated-1.md"], dir);
    assert.match(page, /^backend: codex$/m);
    assert.match(page, /^model: "gpt-test"$/m);
    assert.match(page, /^cli: "mock"$/m);
    assert.match(page, /\*\*Worked by:\*\* codex gpt-test \(mock\)/);
  } finally { cleanup(prevEgress); }
});

test("an agent ruling records its engine in the gate file, the ruling section, the run record and the gate log", async () => {
  const { dir, prevEgress } = await makeProject(mkdtempSync(join(tmpdir(), "sdlc-prov-rule-")));
  setPolicy(dir, "agents:", "  rulings:", "    G0: { backend: codex, model: gpt-rule }");
  propose(dir, "p1", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  mock({ rule: { text: 'Fine.\n\n```json\n{"verdict":"approve","rationale":"scope matches","conditions":[]}\n```' } });
  try {
    const r = await ruleByAgent(dir, "p1", { persona: "product-owner" });
    assert.equal(r.verdict, "approve");
    const gateText = readFileSync(join(dir, ".sdlc/gates/p1.yaml"), "utf8");
    assert.match(gateText, /^backend: codex$/m);
    assert.match(gateText, /^model: "gpt-rule"$/m);
    assert.match(gateText, /^cli: "mock"$/m);
    const page = readFileSync(join(dir, ".sdlc/proposals/p1.md"), "utf8");
    assert.match(page, /\*\*Ruled on:\*\* codex gpt-rule \(mock\)/);
    assert.match(runRecord(dir), /rule p1 approve at G0 by agent:product-owner \(agent\) on codex gpt-rule \(mock\)/);
    const gates = readFileSync(join(dir, "site", "gates.md"), "utf8");
    assert.match(gates, /\| persona agent · codex gpt-rule \|/);
    const html = readFileSync(join(dir, "site", "gates.html"), "utf8");
    assert.match(html, /persona agent · codex gpt-rule/);
  } finally { cleanup(prevEgress); }
});

test("a person's ruling records no engine and is shown as a person's alone", async () => {
  const { dir, prevEgress } = await makeProject(mkdtempSync(join(tmpdir(), "sdlc-prov-human-")));
  setPolicy(dir, "agents:", "  backend: codex");
  propose(dir, "h1", { gate: "G1", question: "Ratify?", recommendation: "Yes." });
  try {
    rule(dir, "h1", "approve", { by: "tech-lead", note: "read it" });
    const gateText = readFileSync(join(dir, ".sdlc/gates/h1.yaml"), "utf8");
    assert.doesNotMatch(gateText, /^(backend|model|cli):/m);
    const gates = readFileSync(join(dir, "site", "gates.md"), "utf8");
    const row = gates.split("\n").find((l) => l.includes("| h1 |"));
    assert.match(row, /\| a person \|/);
    assert.doesNotMatch(row, /codex|claude/);
  } finally { cleanup(prevEgress); }
});

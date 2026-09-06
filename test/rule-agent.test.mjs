import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { propose } from "../src/commands/propose.mjs";
import { ruleByAgent } from "../src/commands/rule.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;

// Isolates the egress name list the same way test/run.test.mjs does: `init` (run as
// part of `newProject`) seeds the default list under the real home directory unless
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

// Writes a canned `rule.json` for the mock executor: the persona's whole reply, ending
// in the fenced JSON block `parseVerdict` looks for.
function mockRule(text) {
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-rule-"));
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify({ text }));
  return mockDir;
}

test("ruleByAgent: approve records a rationale, held_by agent, and merges to main", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-agent-approve-"));
  const { dir, prevEgress } = await makeProject(tmp);
  propose(dir, "p1", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  const mockDir = mockRule('The scope matches the intent and every check is green.\n\n```json\n{"verdict":"approve","rationale":"checks green; scope matches","conditions":[]}\n```');
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await ruleByAgent(dir, "p1", { persona: "product-owner" });
    assert.equal(r.verdict, "approve");
    assert.equal(r.escalated, false);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    const gateText = readFileSync(join(dir, ".sdlc/gates/p1.yaml"), "utf8");
    assert.match(gateText, /held_by: agent/);
    assert.match(gateText, /by: agent:product-owner/);
    assert.match(gateText, /rationale:/);
    assert.match(gateText, /checks green; scope matches/);
    const page = readFileSync(join(dir, ".sdlc/proposals/p1.md"), "utf8");
    assert.match(page, /## Ruling/);
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ruleByAgent: escalate leaves the branch open with an escalated gate record", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-agent-escalate-"));
  const { dir, prevEgress } = await makeProject(tmp);
  propose(dir, "p2", { gate: "G0", question: "Right problem?", recommendation: "Maybe." });
  const mockDir = mockRule('Two readings of the intent are both plausible.\n\n```json\n{"verdict":"escalate","rationale":"two readings of the intent are both plausible","conditions":[]}\n```');
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await ruleByAgent(dir, "p2", { persona: "product-owner" });
    assert.equal(r.verdict, "escalate");
    assert.equal(r.escalated, true);
    const gateText = readFileSync(join(dir, ".sdlc/gates/p2.yaml"), "utf8");
    assert.match(gateText, /verdict: escalated/);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/p2");
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ruleByAgent: a reply with no fenced verdict block throws", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-agent-noverdict-"));
  const { dir, prevEgress } = await makeProject(tmp);
  propose(dir, "p3", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  const mockDir = mockRule("I looked at the diff and the checks but I am not giving you a verdict block.");
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    await assert.rejects(() => ruleByAgent(dir, "p3", { persona: "product-owner" }), /no verdict block/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ruleByAgent: a HIGH tier proposal escalates without ever asking the persona", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-agent-tier-"));
  const { dir, prevEgress } = await makeProject(tmp);
  propose(dir, "p4", { gate: "G0", question: "Right problem?", recommendation: "Yes.", tier: "HIGH" });
  // No rule.json in here: if ruleByAgent called the agent anyway, the mock executor
  // would throw "no canned response", which the test below would then surface.
  const emptyMockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-empty-"));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = emptyMockDir;
  try {
    const r = await ruleByAgent(dir, "p4", { persona: "product-owner" });
    assert.equal(r.verdict, "escalate");
    assert.equal(r.escalated, true);
    assert.match(r.rationale, /mandatory escalation/);
    assert.match(r.rationale, /tier HIGH/);
    const gateText = readFileSync(join(dir, ".sdlc/gates/p4.yaml"), "utf8");
    assert.match(gateText, /verdict: escalated/);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/p4");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ruleByAgent: a persona that does not hold the gate is rejected", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-agent-holder-"));
  const { dir, prevEgress } = await makeProject(tmp);
  propose(dir, "p5", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  try {
    await assert.rejects(() => ruleByAgent(dir, "p5", { persona: "reviewer" }), /not a holder/);
  } finally {
    restoreEgress(prevEgress);
  }
});

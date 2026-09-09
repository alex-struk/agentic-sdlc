import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { git, gitOk } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { init } from "../src/commands/init.mjs";
import { propose } from "../src/commands/propose.mjs";
import { ruleByAgent, rulePending, rulingTurns } from "../src/commands/rule.mjs";
import { buildSite } from "../src/commands/status.mjs";

const FROM = fileURLToPath(new URL("../fixture-project/fixture.config.yaml", import.meta.url));

// A minimal hand-built project, the same shape test/gates.test.mjs uses: fast to set up
// and free of the pack/egress machinery `newProject` brings along, for tests that only
// need policy gates and a git history. `policy.gates` requires exactly these six keys.
function microProject(config) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-rule-micro-"));
  git(["init", "-q", "-b", "main"], d); git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, ".sdlc"), { recursive: true }); writeFileSync(join(d, ".sdlc/config.yaml"), config);
  // Two proposals opened the same day both append to `.sdlc/runs/<day>.md`, which is an
  // add/add conflict on merge without this — the same attribute a real project gets
  // from `init`.
  writeFileSync(join(d, ".gitattributes"), ".sdlc/runs/*.md merge=union\n");
  writeFileSync(join(d, "README.md"), "x"); git(["add", "-A"], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

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
    assert.notEqual(git(["ls-files", "site/gates.md"], dir), "", "the state site is tracked");
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

test("ruleByAgent: a rationale whose first line starts with whitespace round-trips through YAML", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-agent-yaml-"));
  const { dir, prevEgress } = await makeProject(tmp);
  propose(dir, "p6", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  const rationale = " leading space on the first line\nplain second line\n\nthird line after a blank one";
  const mockDir = mockRule(`Some reasoning.\n\n\`\`\`json\n${JSON.stringify({ verdict: "approve", rationale, conditions: [] })}\n\`\`\``);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await ruleByAgent(dir, "p6", { persona: "product-owner" });
    assert.equal(r.verdict, "approve");
    const gateText = readFileSync(join(dir, ".sdlc/gates/p6.yaml"), "utf8");
    const parsed = parseYaml(gateText);
    assert.equal(parsed.rationale, rationale);
    assert.doesNotThrow(() => buildSite(dir));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ruleByAgent: an agent turn that edits the working tree is rejected and the edit stays visible", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-agent-tamper-"));
  const { dir, prevEgress } = await makeProject(tmp);
  propose(dir, "p7", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-rule-tamper-"));
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify({
    text: 'Looks fine.\n\n```json\n{"verdict":"approve","rationale":"looks fine","conditions":[]}\n```',
    files: { "constitution.md": "tampered" },
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    await assert.rejects(() => ruleByAgent(dir, "p7", { persona: "product-owner" }),
      /rule: the ruling agent modified the working tree/);
    // Not discarded: the branch stays on the proposal, and the tampered content is
    // still there for a person to look at.
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/p7");
    assert.match(git(["status", "--porcelain"], dir), /constitution\.md/);
    assert.equal(readFileSync(join(dir, "constitution.md"), "utf8"), "tampered");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ruleByAgent: a verdict block that isn't valid JSON throws bad verdict block", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-agent-badjson-"));
  const { dir, prevEgress } = await makeProject(tmp);
  propose(dir, "p8", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  const mockDir = mockRule('```json\n{"verdict": "approve", "rationale":}\n```');
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    await assert.rejects(() => ruleByAgent(dir, "p8", { persona: "product-owner" }), /bad verdict block/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ruleByAgent: a verdict with no non-empty rationale throws verdict has no rationale", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-agent-norationale-"));
  const { dir, prevEgress } = await makeProject(tmp);
  propose(dir, "p9", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  const mockDir = mockRule('```json\n{"verdict":"approve","rationale":"   ","conditions":[]}\n```');
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    await assert.rejects(() => ruleByAgent(dir, "p9", { persona: "product-owner" }), /verdict has no rationale/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ruleByAgent: an agent-held gate with no escalate_to is rejected before any agent work", async () => {
  const CONFIG = `
pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: p, domains: [a] }
policy:
  gates:
    G0: { holder: "agent:product-owner" }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: tech-lead }
    G3: { holder: tech-lead }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;
  const dir = microProject(CONFIG);
  propose(dir, "p10", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  // No persona brief and no mock canned response exist for this project: if the check
  // ran any later than "before any agent work", one of those missing pieces would throw
  // a different error first.
  await assert.rejects(() => ruleByAgent(dir, "p10", { persona: "product-owner" }),
    /gate G0 has an agent holder but no escalate_to/);
});

test("rulePending: one proposal's failure is recorded and does not stop the batch", async () => {
  const CONFIG = `
pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: p, domains: [a] }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: "agent:architect" }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: tech-lead }
    G3: { holder: tech-lead }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;
  const dir = microProject(CONFIG);
  mkdirSync(join(dir, ".sdlc/personas"), { recursive: true });
  writeFileSync(join(dir, ".sdlc/personas/product-owner.md"), "# Product owner\n\nRules on intent.\n");
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "add persona"], dir);
  propose(dir, "good-one", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  propose(dir, "bad-one", { gate: "G1", question: "Sound design?", recommendation: "Yes." });
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-pending-"));
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify({
    text: '```json\n{"verdict":"approve","rationale":"looks fine","conditions":[]}\n```',
  }));
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(mkdtempSync(join(tmpdir(), "sdlc-egress-pending-")), "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const results = await rulePending(dir);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    assert.equal(byName["good-one"].verdict, "approve");
    assert.equal(byName["bad-one"].failed, true);
    assert.match(byName["bad-one"].error, /has an agent holder but no escalate_to/);
    // The batch finishes on `main`, not stuck on the failed proposal's branch.
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    const day = new Date().toISOString().slice(0, 10);
    const runs = readFileSync(join(dir, `.sdlc/runs/${day}.md`), "utf8");
    assert.match(runs, /bad-one: failed/);
    // The failure's run-record line is on the site's runs page in the same commit, so
    // a rebuild afterwards changes nothing and the tree stays clean for the next ruling.
    buildSite(dir);
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.match(readFileSync(join(dir, "site/runs.md"), "utf8"), /bad-one: failed/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("rulePending: a batch whose last ruling returns still ends on main", async () => {
  const CONFIG = `
pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: p, domains: [a] }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: tech-lead }
    G3: { holder: tech-lead }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;
  const dir = microProject(CONFIG);
  mkdirSync(join(dir, ".sdlc/personas"), { recursive: true });
  writeFileSync(join(dir, ".sdlc/personas/product-owner.md"), "# Product owner\n\nRules on intent.\n");
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "add persona"], dir);
  propose(dir, "p1", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-pending-return-"));
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify({
    text: '```json\n{"verdict":"return","rationale":"the evidence for this criterion is wrong","conditions":[]}\n```',
  }));
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(mkdtempSync(join(tmpdir(), "sdlc-egress-pending-return-")), "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const results = await rulePending(dir);
    assert.equal(results[0].verdict, "return");
    // `ruleByAgent` itself leaves a `return` checked out on the proposal branch, but the
    // batch as a whole must hand control back on `main` — the next `sdlc run` requires it.
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    // The ruling is not lost by switching away from its branch: the gate file still
    // lives there, reachable, exactly where the ruling commit put it.
    assert.equal(gitOk(["cat-file", "-e", "proposal/p1:.sdlc/gates/p1.yaml"], dir), true);
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("rulePending: a dirty tree after a ruling agent's turn stops the batch instead of contaminating main", async () => {
  const CONFIG = `
pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: p, domains: [a] }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: "agent:architect", escalate_to: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: tech-lead }
    G3: { holder: tech-lead }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;
  const dir = microProject(CONFIG);
  mkdirSync(join(dir, ".sdlc/personas"), { recursive: true });
  writeFileSync(join(dir, ".sdlc/personas/product-owner.md"), "# Product owner\n\nRules on intent.\n");
  writeFileSync(join(dir, ".sdlc/personas/architect.md"), "# Architect\n\nRules on design.\n");
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "add personas"], dir);
  // Two proposals, both agent-held. The first (created first, so ruled first by
  // `--sort=creatordate`) gets a mock reply that tampers a tracked file; the second has
  // no canned response in the mock dir at all, so it must never be attempted.
  propose(dir, "first-one", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  propose(dir, "second-one", { gate: "G1", question: "Sound design?", recommendation: "Yes." });
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-pending-dirty-"));
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify({
    text: '```json\n{"verdict":"approve","rationale":"looks fine","conditions":[]}\n```',
    files: { "README.md": "tampered" },
  }));
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(mkdtempSync(join(tmpdir(), "sdlc-egress-pending-dirty-")), "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const results = await rulePending(dir);
    assert.match(results.stopped, /^first-one: working tree dirty after the ruling agent's turn; inspect and clean before continuing$/);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    assert.equal(byName["first-one"].failed, true);
    assert.match(byName["first-one"].error, /rule: the ruling agent modified the working tree/);
    assert.equal(byName["second-one"], undefined, "the second proposal must not have been attempted");
    // The checkout is left on the offending branch, tampering visible, not swept onto main.
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/first-one");
    assert.match(git(["status", "--porcelain"], dir), /README\.md/);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "tampered");
    // The second proposal's branch was never touched: no gate file was written to it.
    assert.equal(gitOk(["cat-file", "-e", "proposal/second-one:.sdlc/gates/second-one.yaml"], dir), false);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("init backfills all five persona briefs on an existing project missing them", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-init-personas-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const names = ["product-owner", "architect", "reviewer", "ux-reviewer", "tech-lead"];
  for (const n of names) rmSync(join(dir, ".sdlc", "personas", `${n}.md`), { force: true });
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "remove personas"], dir);
  try {
    await init(dir);
    for (const n of names) assert.ok(existsSync(join(dir, ".sdlc", "personas", `${n}.md`)), `${n}.md was not backfilled`);
  } finally {
    restoreEgress(prevEgress);
  }
});

test("ruleByAgent records what the ruling turn cost in the gate file and the site totals", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-agent-cost-"));
  const { dir, prevEgress } = await makeProject(tmp);
  propose(dir, "p11", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  const mockDir = mockRule('Fine.\n\n```json\n{"verdict":"approve","rationale":"checks green","conditions":[]}\n```');
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await ruleByAgent(dir, "p11", { persona: "product-owner" });
    // The mock's turn is free, so the assertion is that the three keys are there and
    // that the totals add them up — not that any particular amount was spent.
    assert.equal(r.cost, 0);
    const gate = parseYaml(readFileSync(join(dir, ".sdlc/gates/p11.yaml"), "utf8"));
    assert.equal(gate.cost, 0);
    assert.equal(gate.turns, 1);
    assert.equal(gate.session, "mock");
    const gates = readFileSync(join(dir, "site/gates.md"), "utf8");
    assert.match(gates, /\| Held \| Cost \| Sample \|/);
    assert.match(gates.split("\n").find((l) => l.includes("p11")), /\|\s*\$0\s*\|/);
    const index = readFileSync(join(dir, "site/index.md"), "utf8");
    assert.match(index, /Rulings cost: \$0\n/);
    assert.match(index, /Total cost: \$0\n/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ruleByAgent: an agent turn that reports failure throws with the turn's own text", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-agent-turnfail-"));
  const { dir, prevEgress } = await makeProject(tmp);
  propose(dir, "p12", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-rule-turnfail-"));
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify({
    ok: false,
    text: "the session ended before a verdict",
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    await assert.rejects(() => ruleByAgent(dir, "p12", { persona: "product-owner" }),
      /ruling agent turn failed after one retry: the session ended before a verdict/);
    // One retry was attempted, and said so.
    assert.equal(warnings.filter((w) => /retrying once/.test(w)).length, 1, warnings.join(" | "));
    // Nothing was ruled and nothing was written: no gate file, tree clean, still on the
    // proposal branch.
    assert.ok(!existsSync(join(dir, ".sdlc/gates/p12.yaml")));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/p12");
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    console.warn = origWarn;
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ruleByAgent: 'Always escalate' in a brief is matched however it is capitalised", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-agent-case-"));
  const { dir, prevEgress } = await makeProject(tmp);
  // The wording installed personas actually use: the phrase opens a bullet, so it is
  // capitalised, and a case-sensitive match would let the proposal through to the agent.
  writeFileSync(join(dir, ".sdlc/personas/product-owner.md"),
    "# Product owner\n\n- Always escalate a change to what the product promises.\n");
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "brief that always defers"], dir);
  propose(dir, "p13", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  // No canned response: reaching the agent at all would throw "no canned response".
  const emptyMockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-empty-case-"));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = emptyMockDir;
  try {
    const r = await ruleByAgent(dir, "p13", { persona: "product-owner" });
    assert.equal(r.escalated, true);
    assert.match(r.rationale, /says always escalate/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ruleByAgent: the retry succeeds when the second turn comes back with a verdict", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-agent-retry-"));
  const { dir, prevEgress } = await makeProject(tmp);
  propose(dir, "p13", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-rule-retry-"));
  const rulePath = join(mockDir, "rule.json");
  // The mock reads its canned response off disk on every call, so rewriting the file
  // between the two calls is how a first failing turn and a second successful one are
  // expressed. `subtype` stands in for the CLI's own account of a session cut short.
  writeFileSync(rulePath, JSON.stringify({ ok: false, text: "", subtype: "error_max_turns" }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => {
    warnings.push(a.join(" "));
    writeFileSync(rulePath, JSON.stringify({
      text: 'Fine.\n\n```json\n{"verdict":"approve","rationale":"the brief answers the question","conditions":[]}\n```',
    }));
  };
  try {
    const r = await ruleByAgent(dir, "p13", { persona: "product-owner" });
    assert.equal(r.verdict, "approve");
    // The warning named the turn cap, read off the CLI's subtype rather than a turn count.
    assert.match(warnings[0], /hit the turn cap \(error_max_turns\)/);
    assert.match(warnings[0], /retrying once/);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
  } finally {
    console.warn = origWarn;
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("a G1 ruling whose conditions do not parse is re-prompted once, and the corrected reply is what lands", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-grammar-"));
  const { dir, prevEgress } = await makeProject(tmp);
  // G1 in the fixture is held by a human; rebound here so a persona rules it.
  const cfgPath = join(dir, ".sdlc/config.yaml");
  writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace("G1: { holder: tech-lead }", 'G1: { holder: "agent:product-owner", escalate_to: tech-lead }'));
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "agent holds G1"], dir);
  propose(dir, "archaeology-applications", { gate: "G1", question: "Is this what applications does?", recommendation: "Mostly." });

  const reply = (conditions) => ({
    text: '```json\n' + JSON.stringify({ verdict: "approve", rationale: "the recovery holds up", conditions }) + '\n```',
  });
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-grammar-"));
  // Two turns: the first reply carries a formatting slip rather than a disagreement —
  // `confirm` takes no text, and the second line has no colon at all — and the re-prompt
  // gets it right.
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify({
    sequence: [
      reply(["confirm D-applications-1 because the README agrees", "please drop D-applications-2"]),
      reply(["confirm D-applications-1", "obsolete D-applications-2: the fee table is gone"]),
    ],
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await ruleByAgent(dir, "archaeology-applications", { persona: "product-owner" });
    assert.equal(r.verdict, "approve");
    assert.deepEqual(r.unparsed, []);
    const gate = parseYaml(readFileSync(join(dir, ".sdlc/gates/archaeology-applications.yaml"), "utf8"));
    assert.deepEqual(gate.conditions, ["confirm D-applications-1", "obsolete D-applications-2: the fee table is gone"]);
    assert.equal(gate.unparsed_conditions, undefined);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("conditions still unreadable after the re-prompt are recorded, and the ruling proceeds", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-rule-grammar-stuck-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const cfgPath = join(dir, ".sdlc/config.yaml");
  writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace("G1: { holder: tech-lead }", 'G1: { holder: "agent:product-owner", escalate_to: tech-lead }'));
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "agent holds G1"], dir);
  propose(dir, "archaeology-applications", { gate: "G1", question: "Is this what applications does?", recommendation: "Mostly." });

  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-grammar-stuck-"));
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify({
    text: '```json\n' + JSON.stringify({
      verdict: "approve",
      rationale: "the recovery holds up",
      conditions: ["confirm D-applications-1", "please just drop the second one"],
    }) + '\n```',
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    const r = await ruleByAgent(dir, "archaeology-applications", { persona: "product-owner" });
    assert.equal(r.verdict, "approve", "the verdict was still reached");
    assert.deepEqual(r.unparsed, ["please just drop the second one"]);
    assert.ok(warnings.some((w) => /still unreadable after one re-prompt/.test(w)), warnings.join(" | "));
    const gate = parseYaml(readFileSync(join(dir, ".sdlc/gates/archaeology-applications.yaml"), "utf8"));
    assert.deepEqual(gate.conditions, ["confirm D-applications-1", "please just drop the second one"]);
    assert.deepEqual(gate.unparsed_conditions, ["please just drop the second one"]);
  } finally {
    console.warn = origWarn;
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("rulingTurns: a G1 ruling gets the stage default, other gates a dozen, and policy.budgets.rule overrides both", () => {
  assert.equal(rulingTurns({}, "G1"), 40);
  assert.equal(rulingTurns({}, "G3"), 12);
  assert.equal(rulingTurns({ policy: { budgets: { rule: 60 } } }, "G1"), 60);
  assert.equal(rulingTurns({ policy: { budgets: { rule: 60 } } }, "G3"), 60);
});

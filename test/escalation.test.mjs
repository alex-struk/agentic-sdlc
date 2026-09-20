import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { git } from "../src/lib/git.mjs";
import { propose } from "../src/commands/propose.mjs";
import { ruleByAgent, rulePending, simulatedRole } from "../src/commands/rule.mjs";

// A first run simulates every role, the tech lead included: the tech lead holds the policy
// gate as an agent, and that is what says escalations stay inside the run.
const config = (tlHolder) => `
pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: p, domains: [a] }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: "agent:ux-reviewer", escalate_to: tech-lead }
    G2: { holder: tech-lead }
    G3: { holder: tech-lead }
    G-POL: { holder: ${tlHolder}, escalate_to: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;

const SIMULATED = config('"agent:tech-lead"');
const HUMAN_TECH_LEAD = config("tech-lead");

function project(t, cfg) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-escalation-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], d); git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, ".sdlc", "personas"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), cfg);
  writeFileSync(join(d, ".gitattributes"), ".sdlc/runs/*.md merge=union\n");
  for (const p of ["ux-reviewer", "tech-lead"]) writeFileSync(join(d, `.sdlc/personas/${p}.md`), `# Persona: ${p}\n\nRules.\n`);
  writeFileSync(join(d, "README.md"), "x"); git(["add", "-A"], d); git(["commit", "-q", "-m", "init"], d);
  propose(d, "design-a", { gate: "G-DESIGN", question: "Do these screens serve the criteria?", recommendation: "Yes." });
  git(["checkout", "-q", "main"], d);
  return d;
}

// The mock executor answers every ruling turn from one `rule.json`, so each step of a test
// points it at the reply that step should get.
function reply(t, verdict, rationale) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-escalation-mock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "rule.json"), JSON.stringify({ text: `\`\`\`json\n${JSON.stringify({ verdict, rationale, conditions: [] })}\n\`\`\`` }));
  process.env.SDLC_MOCK_DIR = dir;
}

function withMock(t) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const names = join(mkdtempSync(join(tmpdir(), "sdlc-escalation-egress-")), "names.txt");
  writeFileSync(names, "");
  process.env.SDLC_EGRESS_NAMES = names;
  process.env.SDLC_EXECUTOR = "mock";
  t.after(() => {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    if (prevEgress === undefined) delete process.env.SDLC_EGRESS_NAMES; else process.env.SDLC_EGRESS_NAMES = prevEgress;
  });
}

const gateFile = (d, name) => parseYaml(readFileSync(join(d, `.sdlc/gates/${name}.yaml`), "utf8"));

test("a role is simulated exactly when the policy has an agent holding a gate as it", () => {
  const cfg = (tl) => ({ policy: { gates: { G0: { holder: "agent:product-owner" }, "G-POL": { holder: tl } } } });
  assert.equal(simulatedRole(cfg("agent:tech-lead"), "tech-lead"), true);
  assert.equal(simulatedRole(cfg("tech-lead"), "tech-lead"), false);
  assert.equal(simulatedRole(cfg("agent:tech-lead"), undefined), false);
});

test("in a simulated run the tech-lead agent rules an escalation, and an approval merges", async (t) => {
  withMock(t);
  const d = project(t, SIMULATED);
  reply(t, "escalate", "a pattern the design system does not cover");
  await ruleByAgent(d, "design-a", { persona: "ux-reviewer" });
  git(["checkout", "-q", "main"], d);

  reply(t, "approve", "the pattern is built from tokens and named as the project's own");
  const r = await ruleByAgent(d, "design-a", { persona: "tech-lead" });
  assert.equal(r.verdict, "approve");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  const g = gateFile(d, "design-a");
  assert.equal(g.by, "agent:tech-lead");
  assert.equal(g.held_by, "agent");
});

// A project whose tech lead is a person has said so in its policy, and an agent must not
// take the ruling that person is owed.
test("where the tech lead is a person, no agent may rule the escalation", async (t) => {
  withMock(t);
  const d = project(t, HUMAN_TECH_LEAD);
  reply(t, "escalate", "needs the tech lead");
  await ruleByAgent(d, "design-a", { persona: "ux-reviewer" });
  git(["checkout", "-q", "main"], d);
  await assert.rejects(() => ruleByAgent(d, "design-a", { persona: "tech-lead" }), /agent:tech-lead is not a holder of G-DESIGN/);
});

test("an agent cannot rule a gate it neither holds nor has been escalated", async (t) => {
  withMock(t);
  const d = project(t, SIMULATED);
  await assert.rejects(() => ruleByAgent(d, "design-a", { persona: "tech-lead" }), /not a holder of G-DESIGN/);
});

// The tech-lead agent's own escalation is the one that means "the pipeline cannot do this",
// so it stops the run: a batch leaves it for a person, and the agent cannot rule it again.
test("the tech-lead agent's own escalation waits for a person", async (t) => {
  withMock(t);
  const d = project(t, SIMULATED);
  reply(t, "escalate", "the stage had no tool to check the screens with");
  await ruleByAgent(d, "design-a", { persona: "ux-reviewer" });
  git(["checkout", "-q", "main"], d);

  reply(t, "escalate", "the pipeline cannot check a catalogue; that is its owner's to fix");
  const r = await ruleByAgent(d, "design-a", { persona: "tech-lead" });
  assert.equal(r.escalated, true);
  assert.equal(gateFile(d, "design-a").by, "agent:tech-lead");
  git(["checkout", "-q", "main"], d);

  await assert.rejects(() => ruleByAgent(d, "design-a", { persona: "tech-lead" }), /not a holder of G-DESIGN/);
  reply(t, "approve", "should never be asked");
  const batch = await rulePending(d);
  assert.deepEqual(batch.map((x) => x.name), [], "a batch leaves it for a person");
});

test("a batch hands an open escalation to the simulated tech lead", async (t) => {
  withMock(t);
  const d = project(t, SIMULATED);
  reply(t, "escalate", "a pattern the design system does not cover");
  const first = await rulePending(d);
  assert.equal(first[0].verdict, "escalate");

  reply(t, "approve", "accepted as the project's own component");
  const second = await rulePending(d);
  assert.equal(second.length, 1);
  assert.equal(second[0].verdict, "approve");
  assert.equal(gateFile(d, "design-a").by, "agent:tech-lead");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
});

// The batch is the one command that walks proposal branches, so it is the one that can
// leave the repository standing on one. Both halves of that are guarded here: it refuses
// to start on a tree it did not dirty, and when a ruling turn dirties one it says where
// it left the caller.
test("a batch refuses to start on a dirty tree, and opens no branch", async (t) => {
  withMock(t);
  const d = project(t, SIMULATED);
  writeFileSync(join(d, "untracked-output.txt"), "generated");

  reply(t, "approve", "should never be asked");
  await assert.rejects(() => rulePending(d), /rule --pending: the working tree has uncommitted changes/);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main",
    "the batch must not open a proposal branch it is going to stop on");
});

test("a batch stopped by a dirty tree names the branch it leaves the caller on", async (t) => {
  withMock(t);
  const d = project(t, SIMULATED);
  // The ruling turn itself writes a file: the mock executor is told to, so the dirt can
  // only have come from the turn, which is exactly the case the stop is for.
  const mock = mkdtempSync(join(tmpdir(), "sdlc-escalation-mock-"));
  t.after(() => rmSync(mock, { recursive: true, force: true }));
  writeFileSync(join(mock, "rule.json"), JSON.stringify({
    text: "```json\n" + JSON.stringify({ verdict: "approve", rationale: "r", conditions: [] }) + "\n```",
    files: { "tampered.txt": "the turn wrote this" },
  }));
  process.env.SDLC_MOCK_DIR = mock;

  const r = await rulePending(d);
  assert.ok(r.stopped, "the batch stops rather than carrying the turn's changes onto main");
  assert.match(r.stopped, /left on proposal\/design-a, not main/);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "proposal/design-a");
});

// A persona brief is the ruler's instruction sheet, not part of the proposal, so a
// proposal opened before a brief was corrected must still be ruled by the corrected one.
test("a ruling reads the persona brief from main, not from the proposal's branch", async (t) => {
  withMock(t);
  const d = project(t, SIMULATED);
  // The branch already exists, carrying the brief as it stood when it was opened. Declare
  // the gate escalated there, and correct it on main afterwards.
  git(["checkout", "-q", "proposal/design-a"], d);
  writeFileSync(join(d, ".sdlc/personas/ux-reviewer.md"), "---\nescalates: [G-DESIGN]\n---\n# Persona: ux-reviewer\n\nRules.\n");
  git(["add", "-A"], d); git(["commit", "-q", "-m", "brief that defers G-DESIGN"], d);
  git(["checkout", "-q", "main"], d);

  reply(t, "approve", "the screens serve the criteria");
  const r = await ruleByAgent(d, "design-a", { persona: "ux-reviewer" });
  assert.equal(r.verdict, "approve", "main's brief governs, so the persona is asked");
  assert.ok(!r.escalated);
  assert.equal(gateFile(d, "design-a").by, "agent:ux-reviewer");
});

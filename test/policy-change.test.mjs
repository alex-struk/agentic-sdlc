// test/policy-change.test.mjs — a proposal that changes the project's policy.
//
// The `policy` block of `.sdlc/config.yaml` says who holds each gate. A proposal that
// changes it is ruled at G-POL and nowhere else, and the seat that may rule it is the one
// `main`'s policy names: a proposal cannot choose who rules it by naming them in the
// change it asks for. Both seats are held to this the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOk } from "../src/lib/git.mjs";
import { rule, ruleByAgent, rulePending } from "../src/commands/rule.mjs";
import { proposedPolicyChange } from "../src/runner/ruling-config.mjs";

const CONFIG = `pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: sample, domains: [alpha] }
policy:
  default_tier: STANDARD
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: "agent:product-owner", escalate_to: tech-lead }
    G-DESIGN: { holder: "agent:product-owner", escalate_to: tech-lead }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead }
    G-POL: { holder: tech-lead, escalate_to: delivery-lead }
skills: { packs: [] }
egress: { rules: [E-2] }
`;

function project(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-policy-change-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d);
  git(["config", "user.name", "t"], d);
  mkdirSync(join(d, ".sdlc", "personas"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), CONFIG);
  writeFileSync(join(d, ".gitattributes"), ".sdlc/runs/*.md merge=union\n");
  for (const p of ["product-owner", "architect", "reviewer", "tech-lead"]) writeFileSync(join(d, `.sdlc/personas/${p}.md`), `# Persona: ${p}\n\nRules.\n`);
  writeFileSync(join(d, "README.md"), "x\n");
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "init"], d);
  return d;
}

// A proposal at `gate` whose branch rewrites the config with `edit`, or leaves it alone.
function openProposal(d, name, gate, edit = null) {
  git(["checkout", "-q", "-b", `proposal/${name}`], d);
  mkdirSync(join(d, ".sdlc", "proposals"), { recursive: true });
  writeFileSync(join(d, `.sdlc/proposals/${name}.md`),
    `---\ngate: ${gate}\nquestion: "Does this hold?"\nrecommendation: "It does."\nopened: 2026-09-24T00:00:00.000Z\n---\n\n# Does this hold?\n`);
  if (edit) writeFileSync(join(d, ".sdlc/config.yaml"), edit(readFileSync(join(d, ".sdlc/config.yaml"), "utf8")));
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", `propose ${name}`], d);
  git(["checkout", "-q", "main"], d);
}

const handG2ToAPerson = (text) => text.replace('G2: { holder: "agent:architect", escalate_to: tech-lead }', "G2: { holder: architect, escalate_to: tech-lead }");
const handGPolToAnAgent = (text) => text.replace("G-POL: { holder: tech-lead, escalate_to: delivery-lead }", 'G-POL: { holder: "agent:architect", escalate_to: architect }');

function mockApproval(t) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-policy-change-mock-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR; });
  writeFileSync(join(dir, "rule.json"), JSON.stringify({ text: "```json\n" + JSON.stringify({ verdict: "approve", rationale: "it holds", conditions: [] }) + "\n```" }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = dir;
}

test("whether a proposal changes the policy block is read against its merge base", (t) => {
  const d = project(t);
  openProposal(d, "plain", "G2");
  openProposal(d, "policy", "G2", handG2ToAPerson);
  openProposal(d, "address", "G2", (text) => `${text}targets:\n  candidate: { base_url: "http://host.invalid:1000", identity: session-route }\n`);
  assert.equal(proposedPolicyChange(d, "proposal/plain").changed, false);
  assert.equal(proposedPolicyChange(d, "proposal/address").changed, false, "a change outside policy is not a policy change");
  const change = proposedPolicyChange(d, "proposal/policy");
  assert.equal(change.changed, true);
  assert.equal(change.mainPolicy.gates.G2.holder, "agent:architect");
});

test("a proposal that changes policy is refused at any gate but G-POL, from either seat", async (t) => {
  const d = project(t);
  openProposal(d, "sneak", "G2", handG2ToAPerson);
  assert.throws(() => rule(d, "sneak", "approve", { by: "tech-lead", note: "fine" }), /changes the policy block[\s\S]*G-POL/);
  mockApproval(t);
  await assert.rejects(() => ruleByAgent(d, "sneak", { persona: "architect" }), /changes the policy block[\s\S]*G-POL/);
  assert.equal(gitOk(["cat-file", "-e", "proposal/sneak:.sdlc/gates/sneak.yaml"], d), false, "nothing was ruled");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
});

test("a policy change at G-POL is seated by main's policy, not by the policy it proposes", async (t) => {
  const d = project(t);
  openProposal(d, "handover", "G-POL", handGPolToAnAgent);
  mockApproval(t);
  await assert.rejects(() => ruleByAgent(d, "handover", { persona: "architect" }), /agent:architect is not a holder of G-POL/,
    "the holder the proposal names does not rule it");
  assert.throws(() => rule(d, "handover", "approve", { by: "architect", note: "fine" }), /architect is not a holder of G-POL/);
  const r = rule(d, "handover", "approve", { by: "tech-lead", note: "the architect may hold policy from here on" });
  assert.equal(r.verdict, "approve");
});

test("a batch leaves a policy change at the wrong gate open and says why", async (t) => {
  const d = project(t);
  openProposal(d, "sneak", "G2", handG2ToAPerson);
  mockApproval(t);
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let batch;
  try { batch = await rulePending(d); } finally { console.log = log; }
  assert.equal(batch.length, 0);
  assert.match(lines.join("\n"), /sneak: left open — [\s\S]*G-POL/);
  assert.equal(gitOk(["cat-file", "-e", "proposal/sneak:.sdlc/gates/sneak.yaml"], d), false);
});

// Which agent backend does the work is policy: `policy.agents` sits in the block, so moving
// work onto another backend is a change a proposal at any other gate cannot carry, and one
// the persona seat at that gate cannot rule, whichever backend it would itself run on.
const moveWorkToCodex = (text) => text.replace("  default_tier: STANDARD\n", "  default_tier: STANDARD\n  agents: { backend: codex }\n");

test("a proposal that moves the work to another agent backend is a policy change", (t) => {
  const d = project(t);
  openProposal(d, "engine", "G2", moveWorkToCodex);
  assert.equal(proposedPolicyChange(d, "proposal/engine").changed, true);
});

test("a proposal at G2 that moves the work to another agent backend is not ruled at G2", async (t) => {
  const d = project(t);
  openProposal(d, "engine-g2", "G2", moveWorkToCodex);
  mockApproval(t);
  await assert.rejects(() => ruleByAgent(d, "engine-g2", { persona: "architect" }), /G-POL/);
  assert.equal(gitOk(["cat-file", "-e", "main:.sdlc/gates/engine-g2.yaml"], d), false);
});

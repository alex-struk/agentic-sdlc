import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { propose } from "../src/commands/propose.mjs";
import { rule } from "../src/commands/rule.mjs";

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

function project() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-gate-"));
  git(["init", "-q", "-b", "main"], d); git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, ".sdlc"), { recursive: true }); writeFileSync(join(d, ".sdlc/config.yaml"), CONFIG);
  writeFileSync(join(d, "README.md"), "x"); git(["add", "-A"], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

test("propose then approve merges into main with a gate record", () => {
  const d = project();
  const { branch } = propose(d, "harness-ready", { gate: "G1", question: "Is the harness ready?", recommendation: "Yes." });
  assert.equal(branch, "proposal/harness-ready");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), branch);
  assert.throws(() => rule(d, "harness-ready", "approve", { by: "ux-reviewer" }), /not a holder/);
  rule(d, "harness-ready", "approve", { by: "tech-lead", note: "checks green" });
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  assert.ok(existsSync(join(d, ".sdlc/gates/harness-ready.yaml")));
  assert.match(readFileSync(join(d, ".sdlc/gates/harness-ready.yaml"), "utf8"), /verdict: approve/);
  assert.match(git(["log", "--oneline", "-3"], d), /harness-ready/);
});

test("return keeps the branch open and records the verdict", () => {
  const d = project();
  propose(d, "plan-v1", { gate: "G2", question: "Sound?", recommendation: "No." });
  rule(d, "plan-v1", "return", { by: "tech-lead", note: "criterion R-1.2 unassigned" });
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "proposal/plan-v1");
  assert.match(readFileSync(join(d, ".sdlc/gates/plan-v1.yaml"), "utf8"), /verdict: return/);
});

test("an agent-held gate records held_by agent and can escalate to the human", () => {
  const d = project();
  propose(d, "intent-1", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  rule(d, "intent-1", "approve", { by: "agent:product-owner", note: "rationale…" });
  assert.match(readFileSync(join(d, ".sdlc/gates/intent-1.yaml"), "utf8"), /held_by: agent/);
  const d2 = project();
  propose(d2, "intent-2", { gate: "G0", question: "?", recommendation: "?" });
  rule(d2, "intent-2", "approve", { by: "tech-lead" });
  assert.match(readFileSync(join(d2, ".sdlc/gates/intent-2.yaml"), "utf8"), /held_by: human/);
});

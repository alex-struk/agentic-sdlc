// test/ruling-config.test.mjs — which revision of the project's configuration a ruling
// reasons from.
//
// `.sdlc/config.yaml` is versioned with the repository, so a proposal branch carries it as
// it stood the day the branch was opened. Some of what it holds describes the world the
// project runs in now — an address, a service, a toolchain — and a ruler quoting the
// branch's copy of that reasons to a conclusion that is right about the branch and wrong
// about the project. The rest is `policy`, which is the terms the proposal was made under
// and stays with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { buildPersonaPrompt } from "../src/runner/persona.mjs";
import { rulingConfig } from "../src/runner/ruling-config.mjs";

const config = ({ address = "http://host.invalid:1000", stack = "openshift-ts", tier = "STANDARD" } = {}) => `pipeline: { repo: agentic-sdlc, ref: main }
profile: rebuild
stack: ${stack}
project: { name: sample, domains: [alpha] }
targets:
  candidate:
    base_url: ${address}
    identity: session-route
policy:
  default_tier: ${tier}
  gates:
    G0: { holder: "agent:reviewer", escalate_to: tech-lead }
    G1: { holder: "agent:reviewer", escalate_to: tech-lead }
    G-DESIGN: { holder: "agent:reviewer", escalate_to: tech-lead }
    G2: { holder: tech-lead }
    G3: { holder: tech-lead }
    G-POL: { holder: "agent:tech-lead", escalate_to: tech-lead }
skills: { packs: [] }
egress: { rules: [E-2] }
`;

const PROPOSAL = (name, gate) => `---
gate: ${gate}
question: "Does this hold?"
recommendation: "It does."
opened: 2026-09-21T00:00:00.000Z
---

# Does this hold?
`;

function project(t, text = config()) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-ruling-config-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d);
  git(["config", "user.name", "t"], d);
  mkdirSync(join(d, ".sdlc", "personas"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), text);
  writeFileSync(join(d, ".sdlc/personas/reviewer.md"), "# Persona: reviewer\n\nRules on the work in front of it.\n");
  writeFileSync(join(d, "README.md"), "x\n");
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "init"], d);
  return d;
}

// A proposal branch with a page on it and nothing else, which is the shape every ruling
// below is built against.
function openProposal(d, name, gate = "G-DESIGN") {
  git(["checkout", "-q", "-b", `proposal/${name}`], d);
  mkdirSync(join(d, ".sdlc", "proposals"), { recursive: true });
  writeFileSync(join(d, `.sdlc/proposals/${name}.md`), PROPOSAL(name, gate));
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", `propose ${name}`], d);
}

// Commits a new configuration on `main` while a proposal branch is already open, then
// leaves the branch checked out the way a ruling has it.
function moveMainOn(d, name, text) {
  git(["checkout", "-q", "main"], d);
  writeFileSync(join(d, ".sdlc/config.yaml"), text);
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "the project moves"], d);
  git(["checkout", "-q", `proposal/${name}`], d);
}

test("a ruling prompt quotes the configuration from main, not as the branch carries it", async (t) => {
  const d = project(t);
  openProposal(d, "design-alpha");
  moveMainOn(d, "design-alpha", config({ address: "http://host.invalid:2000" }));

  const prompt = await buildPersonaPrompt(d, "design-alpha", "reviewer", { tier: "STANDARD", gate: "G-DESIGN" });
  assert.match(prompt, /## The project's configuration/);
  assert.match(prompt, /host\.invalid:2000/, "the address the project serves on now is in the prompt");
  assert.match(prompt, /Rule from this, not from the copy of `\.sdlc\/config\.yaml` on the branch/);
});

test("a branch that disagrees with main on a block it did not change has the difference disclosed", async (t) => {
  const d = project(t);
  openProposal(d, "design-alpha");
  moveMainOn(d, "design-alpha", config({ address: "http://host.invalid:2000" }));

  const prompt = await buildPersonaPrompt(d, "design-alpha", "reviewer", { tier: "STANDARD", gate: "G-DESIGN" });
  assert.match(prompt, /### Where the branch disagrees with `main`/);
  assert.match(prompt, /This proposal does not change `targets`/);
  assert.match(prompt, /`targets` on `main` \(this governs\)/);
  assert.match(prompt, /`targets` as this branch carries it \(stale\)/);
  assert.match(prompt, /host\.invalid:1000/, "the stale value is quoted too, so the difference is visible");
});

test("a proposal whose subject is the configuration is ruled on what it proposes", async (t) => {
  const d = project(t);
  git(["checkout", "-q", "-b", "proposal/policy-targets"], d);
  mkdirSync(join(d, ".sdlc", "proposals"), { recursive: true });
  writeFileSync(join(d, ".sdlc/proposals/policy-targets.md"), PROPOSAL("policy-targets", "G-DESIGN"));
  writeFileSync(join(d, ".sdlc/config.yaml"), config({ address: "http://host.invalid:3000" }));
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "propose a new address"], d);

  const prompt = await buildPersonaPrompt(d, "policy-targets", "reviewer", { tier: "STANDARD", gate: "G-DESIGN" });
  assert.match(prompt, /### What this proposal changes/);
  assert.match(prompt, /This proposal changes `targets`/);
  assert.match(prompt, /host\.invalid:3000/, "the proposed address is what the ruling is on");
  assert.match(prompt, /Currently on `main`/);
  assert.match(prompt, /host\.invalid:1000/, "and what the project has now is shown beside it");
  assert.doesNotMatch(prompt, /### Where the branch disagrees with `main`/,
    "a block the proposal changes is its own change, not a stale snapshot");
});

test("policy is read from the branch, and main having moved on is still said out loud", async (t) => {
  const d = project(t);
  openProposal(d, "design-alpha");
  moveMainOn(d, "design-alpha", config({ tier: "HIGH" }));

  const prompt = await buildPersonaPrompt(d, "design-alpha", "reviewer", { tier: "STANDARD", gate: "G-DESIGN" });
  assert.match(prompt, /`policy` above is the branch's own copy, because it is the policy this proposal was made under/);
  assert.match(prompt, /`main` carries a different `policy`/);
  assert.match(prompt, /default_tier: HIGH/, "what a proposal opened today would be ruled under is quoted");
});

test("the stack profile a ruling reads is the one the project is on now", async (t) => {
  const d = project(t, config({ stack: "no-such-stack" }));
  git(["checkout", "-q", "-b", "proposal/design-alpha"], d);
  mkdirSync(join(d, ".sdlc", "proposals"), { recursive: true });
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, ".sdlc/proposals/design-alpha.md"), PROPOSAL("design-alpha", "G-DESIGN"));
  // A file the installed stack profile declares its toolchain writes and the project
  // commits, which a ruling leaves out of the diff and names instead.
  writeFileSync(join(d, "app/package-lock.json"), '{"lockfileVersion": 3}\n');
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "propose"], d);
  moveMainOn(d, "design-alpha", config({ stack: "openshift-ts" }));

  const prompt = await buildPersonaPrompt(d, "design-alpha", "reviewer", { tier: "STANDARD", gate: "G-DESIGN" });
  assert.match(prompt, /Left out as machine-generated[^\n]*app\/package-lock\.json/,
    "the stack the project is on now decides what counts as machine-generated");
});

test("rulingConfig says which revision governs each block and why", (t) => {
  const d = project(t);
  openProposal(d, "design-alpha");
  moveMainOn(d, "design-alpha", config({ address: "http://host.invalid:2000", tier: "HIGH" }));

  const { config: resolved, blocks } = rulingConfig(d, "proposal/design-alpha");
  const of = (key) => blocks.find((b) => b.key === key);
  assert.equal(of("targets").governs, "main");
  assert.equal(of("targets").proposed, false);
  assert.equal(of("targets").differs, true);
  assert.equal(resolved.targets.candidate.base_url, "http://host.invalid:2000");
  assert.equal(of("policy").governs, "branch");
  assert.equal(resolved.policy.default_tier, "STANDARD", "the branch's policy is what the ruling is made under");
  assert.equal(of("project").differs, false, "a block neither revision touched reads as agreeing");
});

test("a block the proposal changes governs from the branch, whichever kind of block it is", (t) => {
  const d = project(t);
  git(["checkout", "-q", "-b", "proposal/policy-tier"], d);
  writeFileSync(join(d, ".sdlc/config.yaml"), config({ tier: "CRITICAL" }));
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "propose a tier"], d);

  const { config: resolved, blocks } = rulingConfig(d, "proposal/policy-tier");
  const policy = blocks.find((b) => b.key === "policy");
  assert.equal(policy.proposed, true);
  assert.equal(policy.governs, "branch");
  assert.equal(resolved.policy.default_tier, "CRITICAL");
});

test("a project whose main has no configuration falls back to the branch's own copy", (t) => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-ruling-config-bare-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d);
  git(["config", "user.name", "t"], d);
  writeFileSync(join(d, "README.md"), "x\n");
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "init"], d);
  git(["checkout", "-q", "-b", "proposal/first"], d);
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), config());
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "the first configuration"], d);

  const { config: resolved, fallback } = rulingConfig(d, "proposal/first");
  assert.equal(fallback, "branch");
  assert.equal(resolved.targets.candidate.base_url, "http://host.invalid:1000");
});

// The ledger of instructions an earlier ruling left owed lives on `main`: a return's
// conditions are filed there because a branch nobody merges is a record nobody reads. The
// guard that refuses a ruling for closing a reference nothing has open already reads
// `main`'s copy, so a prompt reading the checkout's shows the ruler a different list from
// the one it is judged against.
test("the instructions a ruler is told are owed are main's, not the branch's", async (t) => {
  const d = project(t);
  openProposal(d, "design-alpha");
  git(["checkout", "-q", "main"], d);
  writeFileSync(join(d, ".sdlc/conditions.yaml"),
    "conditions:\n  - ref: design-earlier#1\n    text: Name the observation the assertion reads\n    from: design-earlier\n    gate: G-DESIGN\n    stage: design\n    by: agent:reviewer\n    at: 2026-09-20T00:00:00.000Z\n");
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "a return files its condition"], d);
  git(["checkout", "-q", "proposal/design-alpha"], d);

  const prompt = await buildPersonaPrompt(d, "design-alpha", "reviewer", { tier: "STANDARD", gate: "G-DESIGN" });
  assert.match(prompt, /## Instructions an earlier ruling left owed/);
  assert.match(prompt, /design-earlier#1/, "the reference the ruler may close is the one the guard will accept");
  assert.match(prompt, /Name the observation the assertion reads/);
});

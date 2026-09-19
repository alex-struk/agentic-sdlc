import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { git } from "../src/lib/git.mjs";
import { buildVerified, rulePending, simulatedRole } from "../src/commands/rule.mjs";

function repo(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-rule-build-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["init", "-q", "-b", "proposal/build-slice-1"]);
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, "app", "index.ts"), "export {};\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "x"]);
  return { d, run };
}

const tree = (d) => execFileSync("git", ["rev-parse", "HEAD:app"], { cwd: d, encoding: "utf8" }).trim();
const result = (d, over) => {
  mkdirSync(join(d, "tests", "results", "new"), { recursive: true });
  writeFileSync(join(d, "tests", "results", "new", "slice-1.json"), JSON.stringify({ slice: 1, proposal: "build-slice-1", app_tree: tree(d), verdict: "pass", ...over }));
};

test("a build proposal with no verify result may not be ruled", (t) => {
  const { d } = repo(t);
  assert.match(buildVerified(d, "build-slice-1").reason, /run sdlc run verify --slice 1 first/);
});

test("a passing result for the application as it stands lets the ruling go ahead", (t) => {
  const { d } = repo(t);
  result(d, {});
  assert.equal(buildVerified(d, "build-slice-1").ok, true);
});

test("a result for a different application tree, a different proposal, or a failure does not", (t) => {
  const { d, run } = repo(t);
  result(d, {});
  writeFileSync(join(d, "app", "index.ts"), "export const x = 1;\n");
  run(["add", "app"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "changed"]);
  assert.match(buildVerified(d, "build-slice-1").reason, /application changed since it was verified/);
  result(d, { proposal: "build-slice-1-2" });
  assert.match(buildVerified(d, "build-slice-1").reason, /for build-slice-1-2/);
  result(d, { verdict: "fail" });
  assert.match(buildVerified(d, "build-slice-1").reason, /did not pass/);
});

test("names other than a build proposal are not held to a verify", (t) => {
  const { d } = repo(t);
  assert.equal(buildVerified(d, "design-users").ok, true);
});

// A simulated project: the tech lead is played by an agent too, which is what lets it
// rule an escalation inside the run instead of stopping it for a person nobody asked for.
const SIMULATED = `
pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: p, domains: [a] }
policy:
  gates:
    G0: { holder: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: tech-lead }
    G2: { holder: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead }
    G-POL: { holder: "agent:tech-lead", escalate_to: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;

function project(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-rule-build-escalation-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], d); git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, ".sdlc", "personas"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), SIMULATED);
  writeFileSync(join(d, ".gitattributes"), ".sdlc/runs/*.md merge=union\n");
  for (const p of ["reviewer", "tech-lead"]) writeFileSync(join(d, `.sdlc/personas/${p}.md`), `# Persona: ${p}\n\nRules.\n`);
  writeFileSync(join(d, "README.md"), "x"); git(["add", "-A"], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

function reply(t, verdict, rationale) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-rule-build-mock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "rule.json"), JSON.stringify({ text: `\`\`\`json\n${JSON.stringify({ verdict, rationale, conditions: [] })}\n\`\`\`` }));
  process.env.SDLC_MOCK_DIR = dir;
}

function withMock(t) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const names = join(mkdtempSync(join(tmpdir(), "sdlc-rule-build-egress-")), "names.txt");
  writeFileSync(names, "");
  process.env.SDLC_EGRESS_NAMES = names;
  process.env.SDLC_EXECUTOR = "mock";
  t.after(() => {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    if (prevEgress === undefined) delete process.env.SDLC_EGRESS_NAMES; else process.env.SDLC_EGRESS_NAMES = prevEgress;
  });
}

test("a build proposal escalated by verify itself is handed to the simulated tech lead, verify's failure notwithstanding", async (t) => {
  withMock(t);
  const d = project(t);

  // Opens the branch by hand, the way `verify --slice 1` would after a build proposal
  // failed three times running: a failing result file, and a gate file already carrying
  // an escalation raised by the runner rather than by any persona.
  git(["checkout", "-q", "-b", "proposal/build-slice-1"], d);
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, "app", "index.ts"), "export {};\n");
  mkdirSync(join(d, ".sdlc", "proposals"), { recursive: true });
  writeFileSync(join(d, ".sdlc/proposals/build-slice-1.md"), "---\ngate: G3\nquestion: \"Does it work?\"\nrecommendation: \"Yes.\"\nopened: 2026-09-19T00:00:00.000Z\n---\n\n# Does it work?\n");
  git(["add", "-A"], d);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "open build-slice-1"], d);
  const appTree = git(["rev-parse", "HEAD:app"], d);
  mkdirSync(join(d, "tests", "results", "new"), { recursive: true });
  writeFileSync(join(d, "tests/results/new/slice-1.json"), JSON.stringify({
    slice: 1, proposal: "build-slice-1", app_tree: appTree, at: "2026-09-19T00:00:00.000Z", verdict: "fail", rows: [],
  }));
  mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
  writeFileSync(join(d, ".sdlc/gates/build-slice-1.yaml"), [
    "gate: G3", "verdict: escalated", "by: runner:verify", "held_by: runner", "escalate_to: tech-lead",
    "rationale: Slice 1 has failed verify 3 times.", "conditions: []", "at: 2026-09-19T00:00:00.000Z", "",
  ].join("\n"));
  git(["add", "-A"], d);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "verify escalates build-slice-1"], d);
  git(["checkout", "-q", "main"], d);

  assert.equal(simulatedRole(parseYaml(git(["show", "HEAD:.sdlc/config.yaml"], d)), "tech-lead"), true);

  reply(t, "approve", "the failures are already fixed on this branch and the code meets the criteria");
  const batch = await rulePending(d);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].name, "build-slice-1");
  assert.equal(batch[0].verdict, "approve");
  const gate = parseYaml(git(["show", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d));
  assert.equal(gate.by, "agent:tech-lead");
  assert.equal(gate.held_by, "agent");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
});

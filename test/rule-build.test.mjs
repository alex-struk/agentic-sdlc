import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { git, gitOk } from "../src/lib/git.mjs";
import { buildVerified, rule, ruleByAgent, rulePending, simulatedRole } from "../src/commands/rule.mjs";
import { COMMANDS } from "../src/cli.mjs";

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

test("a build proposal with no verify result may not be approved", (t) => {
  const { d } = repo(t);
  assert.match(buildVerified(d, "build-slice-1").reason, /run sdlc run verify --slice 1 first/);
});

test("a passing result for the application as it stands lets the approval go ahead", (t) => {
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

test("a result the suite could not bind is reported as not passed, not as missing", (t) => {
  const { d } = repo(t);
  result(d, { verdict: "unbound" });
  const v = buildVerified(d, "build-slice-1");
  assert.equal(v.ok, false);
  assert.equal(v.notPassed, true);
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

// The same project with a person in the G3 seat, which is the substitution the pipeline
// promises: whatever an agent holder is held to there, a person typing --by is held to.
const HUMAN_HELD = SIMULATED.replace(
  'G3: { holder: "agent:reviewer", escalate_to: tech-lead }',
  "G3: { holder: tech-lead, escalate_to: delivery-lead }");

function project(t, config = SIMULATED) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-rule-build-escalation-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], d); git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, ".sdlc", "personas"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), config);
  writeFileSync(join(d, ".gitattributes"), ".sdlc/runs/*.md merge=union\n");
  for (const p of ["reviewer", "tech-lead"]) writeFileSync(join(d, `.sdlc/personas/${p}.md`), `# Persona: ${p}\n\nRules.\n`);
  writeFileSync(join(d, "README.md"), "x"); git(["add", "-A"], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

// Opens `proposal/build-slice-1` the way the pipeline leaves it: an application, a G3
// proposal page, and then whatever verify wrote about it — a result file carrying the
// verdict given, and a gate file only where the retry ceiling was reached. `verdict:
// null` is the slice verify has not run against yet.
function buildProposal(d, { verdict = "pass", escalatedTo = null } = {}) {
  const commit = (m) => {
    git(["add", "-A"], d);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", m], d);
  };
  git(["checkout", "-q", "-b", "proposal/build-slice-1"], d);
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, "app", "index.ts"), "export {};\n");
  mkdirSync(join(d, ".sdlc", "proposals"), { recursive: true });
  writeFileSync(join(d, ".sdlc/proposals/build-slice-1.md"),
    "---\ngate: G3\nquestion: \"Does it work?\"\nrecommendation: \"Yes.\"\nopened: 2026-09-19T00:00:00.000Z\n---\n\n# Does it work?\n");
  commit("open build-slice-1");
  if (verdict) {
    mkdirSync(join(d, "tests", "results", "new"), { recursive: true });
    writeFileSync(join(d, "tests/results/new/slice-1.json"), JSON.stringify({
      slice: 1, proposal: "build-slice-1", app_tree: git(["rev-parse", "HEAD:app"], d),
      at: "2026-09-19T00:00:00.000Z", verdict, rows: [],
    }));
  }
  if (escalatedTo) {
    mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
    writeFileSync(join(d, ".sdlc/gates/build-slice-1.yaml"), [
      "gate: G3", "verdict: escalated", "by: runner:verify", "held_by: runner", `escalate_to: ${escalatedTo}`,
      "rationale: Slice 1 has failed verify 3 times.", "conditions: []", "at: 2026-09-19T00:00:00.000Z", "",
    ].join("\n"));
  }
  if (verdict || escalatedTo) commit(`verify slice 1: ${verdict ?? "escalated"}`);
  git(["checkout", "-q", "main"], d);
}

function reply(t, verdict, rationale) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-rule-build-mock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "rule.json"), JSON.stringify({ text: `\`\`\`json\n${JSON.stringify({ verdict, rationale, conditions: [] })}\n\`\`\`` }));
  process.env.SDLC_MOCK_DIR = dir;
}

// Conditions alongside the verdict, and — via `sequence` — a different reply for the
// re-prompt turn than for the first one. The mock executor consumes one entry per call and
// reuses the last once the list runs out, so a single-entry list stands in for a persona
// that repeats itself when asked again.
function replyWith(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-rule-build-mock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const turn = ({ verdict, rationale, conditions }) => ({ text: `\`\`\`json\n${JSON.stringify({ verdict, rationale, conditions })}\n\`\`\`` });
  writeFileSync(join(dir, "rule.json"), JSON.stringify({ sequence: entries.map(turn) }));
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

// Collects what a batch printed, so a skip the batch makes silently can be told from one
// it names.
async function said(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try { return { value: await fn(), lines: lines.join("\n") }; } finally { console.log = log; }
}

test("a build proposal escalated by verify itself is handed to the simulated tech lead, verify's failure notwithstanding", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "fail", escalatedTo: "tech-lead" });

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

test("a verdict the suite could not reach is still ruled: its agent holder returns the build", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "unbound" });
  reply(t, "return", "the criteria this slice claims were never exercised");
  const r = await ruleByAgent(d, "build-slice-1", { persona: "reviewer" });
  assert.equal(r.verdict, "return");
  const gate = parseYaml(git(["show", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d));
  assert.equal(gate.verdict, "return");
  assert.equal(gate.by, "agent:reviewer");
});

test("and escalates it, when that is the ruling the holder reaches", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "unbound" });
  reply(t, "escalate", "nothing here can be exercised and I cannot tell whether the application is at fault");
  const r = await ruleByAgent(d, "build-slice-1", { persona: "reviewer" });
  assert.equal(r.escalated, true);
  const gate = parseYaml(git(["show", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d));
  assert.equal(gate.verdict, "escalated");
  assert.equal(gate.escalate_to, "tech-lead");
});

test("an approval without a passing result is refused, and leaves the proposal open", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "unbound" });
  reply(t, "approve", "it looks right to me");
  await assert.rejects(() => ruleByAgent(d, "build-slice-1", { persona: "reviewer" }), /did not pass verify/);
  assert.equal(gitOk(["cat-file", "-e", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d), false,
    "no gate file: nothing was written before the refusal");
  assert.equal(gitOk(["cat-file", "-e", "main:app/index.ts"], d), false, "and nothing was merged");
});

test("a passing result lets the agent holder approve and merge as before", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "pass" });
  reply(t, "approve", "every criterion this slice claims passes against the running application");
  const r = await ruleByAgent(d, "build-slice-1", { persona: "reviewer" });
  assert.equal(r.verdict, "approve");
  assert.equal(gitOk(["cat-file", "-e", "main:app/index.ts"], d), true);
});

test("a person in the gate seat is refused the same approval, and returns the same build", (t) => {
  const d = project(t, HUMAN_HELD);
  buildProposal(d, { verdict: "unbound" });
  assert.throws(() => rule(d, "build-slice-1", "approve", { by: "tech-lead", note: "looks fine" }), /did not pass verify/);
  assert.equal(gitOk(["cat-file", "-e", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d), false);
  const r = rule(d, "build-slice-1", "return", { by: "tech-lead", note: "nothing was exercised", conditions: ["bind what the suite could not reach"] });
  assert.equal(r.verdict, "return");
  const gate = parseYaml(git(["show", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d));
  assert.equal(gate.verdict, "return");
});

// Whether a build may be approved on criteria nobody asserted is a permission the project
// sets at G3. Narrowed, it binds both seats the same way, and the ruler still decides every
// other verdict.
test("policy.gates.G3.approve_unasserted: false refuses a pass-unasserted approval from either seat", async (t) => {
  withMock(t);
  const agentHeld = project(t, SIMULATED.replace('G3: { holder: "agent:reviewer", escalate_to: tech-lead }',
    'G3: { holder: "agent:reviewer", escalate_to: tech-lead, approve_unasserted: false }'));
  buildProposal(agentHeld, { verdict: "pass-unasserted" });
  reply(t, "approve", "the asserted criteria pass and the unasserted one is acceptable");
  await assert.rejects(() => ruleByAgent(agentHeld, "build-slice-1", { persona: "reviewer" }), /approve_unasserted/);
  assert.equal(gitOk(["cat-file", "-e", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], agentHeld), false);

  const personHeld = project(t, HUMAN_HELD.replace("G3: { holder: tech-lead, escalate_to: delivery-lead }",
    "G3: { holder: tech-lead, escalate_to: delivery-lead, approve_unasserted: false }"));
  buildProposal(personHeld, { verdict: "pass-unasserted" });
  assert.throws(() => rule(personHeld, "build-slice-1", "approve", { by: "tech-lead", note: "fine" }), /approve_unasserted/);
  assert.equal(rule(personHeld, "build-slice-1", "return", { by: "tech-lead", note: "assert it", conditions: ["write a test for the unasserted criterion"] }).verdict, "return");
});

test("by default a pass-unasserted build may be approved", (t) => {
  const d = project(t, HUMAN_HELD);
  buildProposal(d, { verdict: "pass-unasserted" });
  assert.equal(rule(d, "build-slice-1", "approve", { by: "tech-lead", note: "the unasserted criterion is acceptable" }).verdict, "approve");
});

// `sdlc rule` used to print one line: `<name>: <verdict> at <gate>`. That is
// indistinguishable at the terminal from a return that carried no conditions at all, which
// three operators each found out the hard way — the fix is what these two tests cover.
test("sdlc rule prints a return's every condition in full, and where the ruling was recorded", async (t) => {
  const d = project(t, HUMAN_HELD);
  buildProposal(d, { verdict: "pass" });
  const c1 = "Give the results list an accessible name.";
  const c2 = "Add a loading state while the second page of results is fetched.";
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  // `COMMANDS.rule` reads `process.cwd()` the way the real CLI does when it is run from
  // inside a project, so the process is put there for the call and returned afterward —
  // `test/sandbox.test.mjs` and `test/verify-stage.test.mjs` do the same.
  const origCwd = process.cwd();
  process.chdir(d);
  let code;
  try {
    code = await COMMANDS.rule({
      pos: ["build-slice-1", "return"],
      flags: { by: "tech-lead", note: "the route is sound; two things have to change first", condition: [c1, c2] },
    });
  } finally { console.log = orig; process.chdir(origCwd); }
  const out = lines.join("\n");
  assert.equal(code, 0);
  assert.match(out, /^build-slice-1: return at G3$/m);
  assert.match(out, /^\s+conditions:$/m);
  assert.ok(out.includes(`- ${c1}`), out);
  assert.ok(out.includes(`- ${c2}`), out);
  assert.ok(out.includes(".sdlc/gates/build-slice-1.yaml"), out);
  assert.ok(out.includes("on proposal/build-slice-1"), out);
});

test("sdlc rule prints 'conditions: none' for an approval that carried none, rather than staying silent", async (t) => {
  const d = project(t, HUMAN_HELD);
  buildProposal(d, { verdict: "pass" });
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  const origCwd = process.cwd();
  process.chdir(d);
  try {
    await COMMANDS.rule({ pos: ["build-slice-1", "approve"], flags: { by: "tech-lead", note: "every criterion this slice claims passes" } });
  } finally { console.log = orig; process.chdir(origCwd); }
  const out = lines.join("\n");
  assert.match(out, /^build-slice-1: approve at G3$/m);
  assert.match(out, /^\s+conditions: none$/m);
});

test("an escalation's target may approve without one, and the escalation is the record of it", (t) => {
  const d = project(t, HUMAN_HELD);
  buildProposal(d, { verdict: "fail", escalatedTo: "delivery-lead" });
  const r = rule(d, "build-slice-1", "approve", { by: "delivery-lead", note: "the remaining failures are the suite's, not the application's" });
  assert.equal(r.verdict, "approve");
  assert.equal(gitOk(["cat-file", "-e", "main:app/index.ts"], d), true);
  const raised = parseYaml(git(["show", "proposal/build-slice-1~1:.sdlc/gates/build-slice-1.yaml"], d));
  assert.equal(raised.verdict, "escalated");
  const gate = parseYaml(git(["show", "main:.sdlc/gates/build-slice-1.yaml"], d));
  assert.equal(gate.by, "delivery-lead");
  assert.equal(gate.held_by, "human");
});

test("the batch names the build it is leaving alone, and stays quiet about one verify has not reached", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "unbound" });
  const notPassed = await said(() => rulePending(d));
  assert.equal(notPassed.value.length, 0);
  assert.match(notPassed.lines, /build-slice-1 did not pass verify; rule it by name/);

  const e = project(t);
  buildProposal(e, { verdict: null });
  const never = await said(() => rulePending(e));
  assert.equal(never.value.length, 0);
  assert.doesNotMatch(never.lines, /build-slice-1/);
});

// --- a return whose plain condition names a path the stage cannot deliver ---
//
// `assertDeliverableRulable` refuses this at the very end of the ruling, after a verdict,
// a rationale and every other condition have already been produced. The three tests below
// are the same three the human-facing decision record for this fix describes: a first
// undeliverable reply is corrected on one re-prompt; a reply that is still undeliverable
// the second time is refused without losing what it said; and the human seat, which has no
// turn to re-prompt, is refused the same way and can reuse its own other conditions.

const OK_CONDITION = "Give app/routes/list.tsx an accessible name.";
const UNDELIVERABLE_CONDITION = "Move the criterion out of plan/tasks.md and into slice 3.";
const CORRECTED_CONDITION = "addressed-to plan: the slice claims a criterion plan/tasks.md never assigned it; move it to a later slice.";

test("a return whose plain condition names an undeliverable path is re-prompted once, and the corrected reply is recorded", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "pass" });
  replyWith(t, [
    { verdict: "return", rationale: "the route is sound; the plan asked this slice for something it cannot show", conditions: [OK_CONDITION, UNDELIVERABLE_CONDITION] },
    { verdict: "return", rationale: "the route is sound; the plan asked this slice for something it cannot show", conditions: [OK_CONDITION, CORRECTED_CONDITION] },
  ]);
  const said1 = await said(() => ruleByAgent(d, "build-slice-1", { persona: "reviewer" }));
  const r = said1.value;
  assert.equal(r.verdict, "return");
  assert.deepEqual(r.addressed, ["plan"], "the corrected condition was filed to the stage it named");
  const gate = parseYaml(git(["show", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d));
  assert.equal(gate.verdict, "return");
  assert.deepEqual(gate.conditions, [OK_CONDITION, CORRECTED_CONDITION], "the kept condition survived; the fixed one is what landed");

  // The re-prompt this guard runs (`0028`) used to leave no trace anywhere that it had
  // fired. It now says so at the terminal, naming what the first reply got wrong, and the
  // gate file carries the same account.
  assert.equal(r.reprompted, true);
  assert.match(said1.lines, /re-asking once/);
  assert.match(said1.lines, /plan\/tasks\.md/);
  assert.match(gate.reprompt, /plan\/tasks\.md/, "the gate file records what the first attempt got wrong");
  assert.match(gate.reprompt, /You ruled return\./);

  // Two turns ran — the first reply and the re-prompt — and the mock charges one turn
  // each; the gate file's own total is the sum, not just the second turn's alone.
  assert.equal(gate.turns, 2, "the first turn's cost is not dropped when the second one lands");
  assert.equal(r.turns, 2);
});

test("a plain condition still undeliverable after the re-prompt is refused, and the verdict and every condition are still visible", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "pass" });
  // One entry: the mock executor repeats it on the re-prompt turn, standing in for a
  // persona that writes the same line again.
  replyWith(t, [
    { verdict: "return", rationale: "the route is sound; the plan asked this slice for something it cannot show", conditions: [OK_CONDITION, UNDELIVERABLE_CONDITION] },
  ]);
  let thrown;
  await assert.rejects(() => ruleByAgent(d, "build-slice-1", { persona: "reviewer" }), (e) => { thrown = e; return true; });
  assert.match(thrown.message, /plan\/tasks\.md/);
  assert.match(thrown.message, /addressed-to plan: /);
  assert.match(thrown.message, /Nothing is recorded/);
  assert.match(thrown.message, /verdict: return/);
  assert.match(thrown.message, new RegExp(OK_CONDITION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the condition that was fine is still shown, not only the bad one");
  assert.match(thrown.message, new RegExp(UNDELIVERABLE_CONDITION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // Nothing was recorded: no gate file on the proposal branch, and the caller is back on
  // main with a clean tree, exactly as any other refused ruling leaves it (`0025`).
  assert.equal(gitOk(["cat-file", "-e", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d), false);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  assert.equal(git(["status", "--porcelain"], d), "");
});

test("a person in the gate seat is refused the same undeliverable condition with the same guidance, and keeps the rest to reuse", (t) => {
  const d = project(t, HUMAN_HELD);
  buildProposal(d, { verdict: "pass" });
  let thrown;
  assert.throws(
    () => rule(d, "build-slice-1", "return", { by: "tech-lead", note: "the route is sound; the plan asked for something this slice cannot show", conditions: [OK_CONDITION, UNDELIVERABLE_CONDITION] }),
    (e) => { thrown = e; return true; },
  );
  assert.match(thrown.message, /plan\/tasks\.md/);
  assert.match(thrown.message, /addressed-to plan: /);
  assert.match(thrown.message, new RegExp(OK_CONDITION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the condition that was fine is not lost");
  assert.equal(gitOk(["cat-file", "-e", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d), false, "nothing was written before the refusal");
  assert.equal(git(["status", "--porcelain"], d), "");

  // There is no turn to re-prompt on this seat, so the person simply reuses the condition
  // that was never in question and rewrites the one that was — nothing of theirs was lost.
  const r = rule(d, "build-slice-1", "return", { by: "tech-lead", note: "the route is sound; the plan asked for something this slice cannot show", conditions: [OK_CONDITION, CORRECTED_CONDITION] });
  assert.equal(r.verdict, "return");
  const gate = parseYaml(git(["show", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d));
  assert.deepEqual(gate.conditions, [OK_CONDITION, CORRECTED_CONDITION]);
});

// An approval the branch holds no passing result for is the verdict and the evidence
// disagreeing about what was just ruled — the same shape as a verdict carrying a condition
// form it may not (`0028`, `0036`). The pipeline records neither claim, so the ruler is
// asked once which of the two it means rather than losing a turn's rationale over it.
test("an approval with no passing result is re-prompted once, and the corrected ruling is what lands", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "unbound" });
  replyWith(t, [
    { verdict: "approve", rationale: "the route reads correctly and I would accept it", conditions: [] },
    { verdict: "return", rationale: "nothing the slice claims was exercised", conditions: ["bind what the suite could not reach"] },
  ]);
  const { value: r, lines } = await said(() => ruleByAgent(d, "build-slice-1", { persona: "reviewer" }));
  assert.equal(r.verdict, "return");
  assert.equal(r.reprompted, true);
  const gate = parseYaml(git(["show", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d));
  assert.equal(gate.verdict, "return");
  assert.deepEqual(gate.conditions, ["bind what the suite could not reach"]);
  assert.match(gate.reprompt, /An approval is recorded only against a current passing verify result/);
  assert.equal(gate.turns, 2, "both turns are counted, not only the one that answered");
  assert.match(lines, /re-asking once/);
});

// The other way out of the same re-prompt: the ruler holds that nothing here can be
// exercised and hands the question up, which asserts nothing about the application and
// needs no evidence.
test("an approval with no passing result may escalate on the second turn", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "unbound" });
  replyWith(t, [
    { verdict: "approve", rationale: "it looks right to me", conditions: [] },
    { verdict: "escalate", rationale: "nothing here can be exercised and I cannot tell whether the application is at fault", conditions: [] },
  ]);
  const r = await said(() => ruleByAgent(d, "build-slice-1", { persona: "reviewer" }));
  assert.equal(r.value.escalated, true);
  assert.equal(r.value.reprompted, true);
  const gate = parseYaml(git(["show", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d));
  assert.equal(gate.verdict, "escalated");
  assert.equal(gate.turns, 2);
});

// The guard is unchanged: a second reply that still approves is refused, and the refusal
// shows the whole of what the ruling produced rather than the evidence line alone.
test("an approval still without a passing result after the re-prompt is refused, with the ruling shown", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "unbound" });
  const held = "the results list still has no accessible name";
  replyWith(t, [
    { verdict: "approve", rationale: "it looks right to me", conditions: [held] },
    { verdict: "approve", rationale: "it still looks right to me", conditions: [held] },
  ]);
  let thrown;
  await said(async () => {
    await assert.rejects(() => ruleByAgent(d, "build-slice-1", { persona: "reviewer" }), (e) => { thrown = e; return true; });
  });
  assert.match(thrown.message, /did not pass verify/);
  assert.match(thrown.message, /return the proposal and keep your findings as its conditions, or escalate/);
  assert.match(thrown.message, /verdict: approve/);
  assert.ok(thrown.message.includes(held), "the condition the ruling produced is shown too");
  assert.equal(gitOk(["cat-file", "-e", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d), false, "nothing was ruled");
  assert.equal(gitOk(["cat-file", "-e", "main:app/index.ts"], d), false, "and nothing was merged");
});

// The human seat reads the same sentence. There is no turn to redo, so there is no
// re-prompt; what the refusal owes a person is the whole ruling back, ready to retype.
test("a person's approval with no passing result is refused with the same guidance and the whole ruling", (t) => {
  const d = project(t, HUMAN_HELD);
  buildProposal(d, { verdict: "unbound" });
  const held = "the results list still has no accessible name";
  let thrown;
  assert.throws(
    () => rule(d, "build-slice-1", "approve", { by: "tech-lead", note: "looks fine", conditions: [held] }),
    (e) => { thrown = e; return true; },
  );
  assert.match(thrown.message, /did not pass verify/);
  assert.match(thrown.message, /return the proposal and keep your findings as its conditions, or escalate/);
  assert.match(thrown.message, /verdict: approve/);
  assert.ok(thrown.message.includes(held));
  assert.equal(gitOk(["cat-file", "-e", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d), false);
});

// What `main` holds after a ruling that was refused: the run record's own lines, and the
// journal entries a ruling wrote. Read with `git show` rather than off disk, because a
// refused ruling leaves the caller wherever it was standing.
const filesOnMain = (d, dir) => {
  try { return git(["ls-tree", "--name-only", `main:${dir}`], d).split("\n").filter(Boolean); }
  catch { return []; }
};
const runLinesOnMain = (d) => filesOnMain(d, ".sdlc/runs")
  .flatMap((f) => git(["show", `main:.sdlc/runs/${f}`], d).split("\n"))
  .filter((l) => l.startsWith("- "));
const rulingJournalOnMain = (d) => filesOnMain(d, ".sdlc/journal")
  .filter((f) => f.endsWith("-rule.md"))
  .map((f) => git(["show", `main:.sdlc/journal/${f}`], d));

// A refused ruling has spent a turn, and until this it spent it into nothing: no gate file
// is the point of the refusal, but no run-record line and no journal entry meant the cost
// and the reasoning both went unrecorded, and an operator reading the project afterwards
// could not tell a refused ruling from a proposal nobody had looked at.
test("a refused ruling records what it produced and what was refused, on main", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "unbound" });
  const held = "the results list still has no accessible name";
  const why = "every criterion the slice claims reads as met to me";
  replyWith(t, [
    { verdict: "approve", rationale: why, conditions: [held] },
    { verdict: "approve", rationale: why, conditions: [held] },
  ]);
  await said(async () => {
    await assert.rejects(() => ruleByAgent(d, "build-slice-1", { persona: "reviewer" }));
  });

  const run = runLinesOnMain(d).find((l) => /refused/.test(l));
  assert.ok(run, `no refusal in the run record: ${runLinesOnMain(d).join(" | ")}`);
  assert.match(run, /rule build-slice-1 refused at G3 by agent:reviewer \(agent\)/);
  assert.match(run, /did not pass verify/);

  const entries = rulingJournalOnMain(d);
  assert.equal(entries.length, 1, "one journal entry, for the one ruling that was refused");
  const [entry] = entries;
  assert.match(entry, /stage: "rule"/);
  assert.match(entry, /turns: 2/, "the re-prompt turn is counted in what the refusal cost");
  assert.match(entry, /\*\*Verdict:\*\* approve/);
  assert.ok(entry.includes(why), "the rationale the ruler reached is kept");
  assert.ok(entry.includes(held), "and every condition it attached");
  assert.match(entry, /did not pass verify/);
  // The refusal is still a refusal: nothing was ruled and nothing was merged.
  assert.equal(gitOk(["cat-file", "-e", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d), false);
  assert.equal(gitOk(["cat-file", "-e", "main:app/index.ts"], d), false);
  assert.equal(git(["status", "--porcelain"], d), "");
});

// A reply the ruling protocol could not be read out of costs the same turn and leaves the
// same silence, so it is recorded the same way — with the reply's failure in place of a
// verdict, because there is no verdict to keep.
test("a reply with no verdict block is recorded as a turn spent with no ruling read out of it", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "pass" });
  const dir = mkdtempSync(join(tmpdir(), "sdlc-rule-build-mock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "rule.json"), JSON.stringify({ text: "I would rather not put this in a block." }));
  process.env.SDLC_MOCK_DIR = dir;

  await assert.rejects(() => ruleByAgent(d, "build-slice-1", { persona: "reviewer" }), /no verdict block/);
  const run = runLinesOnMain(d).find((l) => /unanswered/.test(l));
  assert.ok(run, `no unanswered line in the run record: ${runLinesOnMain(d).join(" | ")}`);
  assert.match(run, /no verdict block/);
  const [entry] = rulingJournalOnMain(d);
  assert.ok(entry, "the turn it cost is journalled even though no ruling came out of it");
  assert.match(entry, /turns: 1/);
  assert.match(entry, /no verdict block/);
  assert.ok(!/\*\*Verdict:\*\*/.test(entry), "there is no verdict to record");
});

// The human seat is recorded the same way, and for the same reason: what happened to the
// proposal is the same fact on either seat. There is no turn behind it, so the cost is
// recorded as nothing rather than left out.
test("a person's refused ruling is recorded on main too, at no cost", (t) => {
  const d = project(t, HUMAN_HELD);
  buildProposal(d, { verdict: "unbound" });
  const held = "the results list still has no accessible name";
  assert.throws(() => rule(d, "build-slice-1", "approve", { by: "tech-lead", note: "looks fine", conditions: [held] }));
  const run = runLinesOnMain(d).find((l) => /refused/.test(l));
  assert.ok(run, `no refusal in the run record: ${runLinesOnMain(d).join(" | ")}`);
  assert.match(run, /rule build-slice-1 refused at G3 by tech-lead \(human\)/);
  const [entry] = rulingJournalOnMain(d);
  assert.ok(entry);
  assert.match(entry, /turns: 0/);
  assert.match(entry, /cost: 0/);
  assert.ok(entry.includes(held));
  assert.equal(git(["status", "--porcelain"], d), "");
});

// A tampered working tree is the one refusal that records nothing: switching to main with
// uncommitted changes present carries them across wherever the file is identical on both
// branches, which would put the tampering on main under a commit about a refused ruling.
test("a refusal on a tampered tree records nothing and leaves the tampering where it was made", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "pass" });
  const dir = mkdtempSync(join(tmpdir(), "sdlc-rule-build-mock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "rule.json"), JSON.stringify({
    text: `\`\`\`json\n${JSON.stringify({ verdict: "approve", rationale: "fine", conditions: [] })}\n\`\`\``,
    files: { "app/index.ts": "export const tampered = 1;\n" },
  }));
  process.env.SDLC_MOCK_DIR = dir;

  await assert.rejects(() => ruleByAgent(d, "build-slice-1", { persona: "reviewer" }), /modified the working tree/);
  assert.deepEqual(rulingJournalOnMain(d), [], "nothing was written to main while the tree was dirty");
  assert.match(git(["status", "--porcelain"], d), /app\/index\.ts/, "and the tampering is still visible");
});

// A `claude` binary that reports a sign-in failure to whatever asks it, and keeps a line per
// stage that asked — so a ruling that stopped before its own turn can be told from one that
// spent the turn to find out.
function fakeSignInFailure(t, root) {
  const bin = join(root, "fake-claude");
  const calls = join(root, "calls.txt");
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    'import { appendFileSync, readFileSync } from "node:fs";',
    'readFileSync(0, "utf8");',
    `appendFileSync(${JSON.stringify(calls)}, (process.env.SDLC_STAGE ?? "?") + "\\n");`,
    'process.stdout.write(JSON.stringify({ is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed" }));',
  ].join("\n"));
  chmodSync(bin, 0o755);
  const prev = { executor: process.env.SDLC_EXECUTOR, dir: process.env.SDLC_MOCK_DIR };
  delete process.env.SDLC_EXECUTOR;
  delete process.env.SDLC_MOCK_DIR;
  process.env.SDLC_CLAUDE_BIN = bin;
  process.env.SDLC_CLAUDE_HOME = join(root, "claude-home");
  process.env.SDLC_CREDENTIALS = join(root, "no-such-credentials.json");
  t.after(() => {
    for (const k of ["SDLC_CLAUDE_BIN", "SDLC_CLAUDE_HOME", "SDLC_CREDENTIALS"]) delete process.env[k];
    if (prev.executor !== undefined) process.env.SDLC_EXECUTOR = prev.executor;
    if (prev.dir !== undefined) process.env.SDLC_MOCK_DIR = prev.dir;
  });
  return () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
}

// A ruling turn is short, but it is a paid turn, and a credential too old to refresh fails it
// at the end of one exactly as it would at the start. `run` asks the question for a fraction
// of a cent before it starts a stage; a gate seat was spending its turn to find out.
test("a ruling checks that this machine can sign in before it spends its turn", async (t) => {
  const d = project(t);
  buildProposal(d, { verdict: "pass" });
  const root = mkdtempSync(join(tmpdir(), "sdlc-rule-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = fakeSignInFailure(t, root);

  await assert.rejects(() => ruleByAgent(d, "build-slice-1", { persona: "reviewer" }),
    /was not started[\s\S]*OAuth session expired[\s\S]*operator's own CLI login/);
  assert.deepEqual(calls(), ["preflight"], "the one-turn check ran and the ruling turn never did");
  assert.equal(gitOk(["cat-file", "-e", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d), false,
    "and nothing was ruled");
  assert.equal(git(["status", "--porcelain"], d), "");
});

test("and the check is skipped under the mock executor, which never reaches a session at all", async (t) => {
  withMock(t);
  const d = project(t);
  buildProposal(d, { verdict: "pass" });
  reply(t, "approve", "every criterion this slice claims passes against the running application");
  // The mock refuses a stage it has no canned reply for, and there is a reply for `rule` and
  // none for `preflight` — so a ruling that completes here is one that asked nothing of a
  // session it never needed.
  const r = await ruleByAgent(d, "build-slice-1", { persona: "reviewer" });
  assert.equal(r.verdict, "approve");
  assert.equal(existsSync(join(process.env.SDLC_MOCK_DIR, "preflight.json")), false);
});

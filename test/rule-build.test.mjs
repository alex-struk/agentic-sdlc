import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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

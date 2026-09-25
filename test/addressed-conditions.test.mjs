// test/addressed-conditions.test.mjs — `addressed-to <stage>: <why>`, the ruling condition
// whose work belongs to a stage other than the one being ruled, and the filtering that
// keeps every other stage's conditions out of a revise prompt.
//
// Builds the same fixture the other stage tests build — a ratified `applications` domain,
// an approved contract and the blind acceptance suite — and drives every stage through the
// mock executor, so nothing here needs Docker, a browser or a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { propose } from "../src/commands/propose.mjs";
import { rule, ruleByAgent } from "../src/commands/rule.mjs";
import { stageFor, revisableStages } from "../src/stages/registry.mjs";
import { loadConfig } from "../src/config/load.mjs";
import { addressedConditions, malformedAddressedConditions, splitConditionsByAddressee } from "../src/spec/criteria.mjs";
import { open as openOwed, openFor, settle } from "../src/spec/owed.mjs";

// The request list as the file stores it, entry for entry.
const readRevisionRequests = (d) => {
  const p = join(d, ".sdlc", "revision-requests.yaml");
  return existsSync(p) ? parseYaml(readFileSync(p, "utf8"))?.requests ?? [] : [];
};
const addRevisionRequests = (d, entries) => openOwed(d, "request", entries).path;
const settleRevisionRound = (d, { taken }) => settle(d, "request", { close: taken });
const openRevisionRequestsFor = (d, stage) => openFor(d, stage, { kinds: ["request"] });
import { finishStage } from "../src/runner/finish-stage.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;
const MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;
const COMMIT = ["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m"];

// The ruling's own words, and the shape they arrive in. Both are neutral: a slice claims a
// criterion nothing it builds can demonstrate, which is a fact about the plan and not about
// the application the ruling is looking at.
const WHY = "slice 2 claims a criterion about a fee being recalculated, and nothing the slice builds ever recalculates one; the slice has to give the criterion up or be widened to cover it";
const CONDITION = `addressed-to plan: ${WHY}`;
const MINE = "app/routes.js returns 500 where the criterion says the record is rejected with an error";

const DOMAIN_TEXT = `# applications

### D-applications-1 · v1 · confirmed · recovered
When an applicant submits a permit application, the system shall reject it unless the applicant is at least 19 years old.
- cites: src/routes.js:4
- reconciliation: implemented-only
- given: an applicant submitting a permit application
- when: the applicant is under 19 years old
- then: the application is rejected with an error and no record is created

### D-applications-2 · v1 · confirmed · recovered
When a permit application is accepted, the system shall change its status to accepted.
- cites: src/routes.js:10
- reconciliation: implemented-only
- given: a submitted permit application that passes the age check
- when: the application is accepted
- then: the application's status changes to accepted

### D-applications-3 · v1 · confirmed · recovered
The system shall recalculate the intake fee whenever an accepted application is edited.
- cites: src/routes.js:14
- reconciliation: implemented-only
- given: an accepted permit application
- when: the application is edited
- then: the intake fee is recalculated from the current record
`;

function restoreEgress(prev) {
  if (prev === undefined) delete process.env.SDLC_EGRESS_NAMES;
  else process.env.SDLC_EGRESS_NAMES = prev;
}

function mock(on) {
  if (!on) { delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR; return; }
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
}

// A project whose `applications` domain is ratified, whose contract is approved, and whose
// blind acceptance suite is on main — everything a ruling at G3 needs to stand against.
async function newFixtureProject(tmp, name = "permit-intake") {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  const dir = join(tmp, name);
  await newProject({ dir, from: FROM });
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  git(["add", "-A"], dir);
  git([...COMMIT, "fill constitution"], dir);
  return { dir, prevEgress };
}

async function ready(tmp) {
  const { dir, prevEgress } = await newFixtureProject(tmp);

  writeFileSync(join(dir, "spec", "domains", "applications.md"), DOMAIN_TEXT);
  propose(dir, "archaeology-applications", {
    gate: "G1",
    question: "Is this what the applications domain does, and which of it is the contract?",
    recommendation: "recovered three criteria from the fixture's old application",
    paths: ["spec/domains/applications.md"],
  });
  rule(dir, "archaeology-applications", "approve", { by: "tech-lead" });
  const ratified = await runStage(dir, "ratify", { domain: "applications" });
  if (!ratified.ok) throw new Error(`ratify failed: ${JSON.stringify(ratified.messages)}`);

  mock(true);
  const contractRun = await runStage(dir, "contract");
  if (!contractRun.ok) throw new Error(`contract failed: ${JSON.stringify(contractRun.messages)}`);
  mock(false);
  rule(dir, "contract-v1", "approve", { by: "tech-lead" });

  mock(true);
  const derived = await runStage(dir, "derive-tests", { domain: "applications" });
  if (!derived.ok) throw new Error(`derive-tests failed: ${JSON.stringify(derived.messages)}`);
  mock(false);
  rule(dir, "derive-tests-applications", "approve", { by: "tech-lead" });
  return { dir, prevEgress };
}

// A G3 proposal standing open, the way a build proposal stands open once verify has
// reported against it and written no gate file.
function openProposal(dir, name) {
  propose(dir, name, { gate: "G3", question: "Does this slice do what its criteria say?", recommendation: "Ruling wanted." });
  return name;
}

// The mock executor answers every ruling turn from one `rule.json`.
function agentReply(verdict, conditions, rationale = "the slice is sound; the plan it was cut from is not") {
  const d = mkdtempSync(join(tmpdir(), "sdlc-addressed-mock-"));
  writeFileSync(join(d, "rule.json"), JSON.stringify({ text: `\`\`\`json\n${JSON.stringify({ verdict, rationale, conditions })}\n\`\`\`` }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = d;
}

// A different reply per turn, for the re-prompt tests below: the mock executor consumes
// one `sequence` entry per call to it and reuses the last once the list runs out.
function agentReplySequence(entries, rationale = "the slice is sound; the plan it was cut from is not") {
  const d = mkdtempSync(join(tmpdir(), "sdlc-addressed-mock-"));
  const turn = (conditions) => ({ text: `\`\`\`json\n${JSON.stringify({ verdict: "return", rationale, conditions })}\n\`\`\`` });
  writeFileSync(join(d, "rule.json"), JSON.stringify({ sequence: entries.map(turn) }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = d;
}

// The same, where the verdict changes between turns as well as the conditions: each entry
// is `[verdict, conditions]`.
function agentVerdictSequence(entries, rationale = "the slice is sound; the plan it was cut from is not") {
  const d = mkdtempSync(join(tmpdir(), "sdlc-addressed-mock-"));
  const turn = ([verdict, conditions]) => ({ text: `\`\`\`json\n${JSON.stringify({ verdict, rationale, conditions })}\n\`\`\`` });
  writeFileSync(join(d, "rule.json"), JSON.stringify({ sequence: entries.map(turn) }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = d;
}

const requestsOnMain = (dir) => {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  if (branch !== "main") git(["checkout", "-q", "main"], dir);
  const list = readRevisionRequests(dir);
  if (branch !== "main") git(["checkout", "-q", branch], dir);
  return list;
};

// --- the form itself ---

test("the condition form carries a stage and a reason, and a form with no reason is not one", () => {
  assert.deepEqual(addressedConditions([CONDITION, MINE]),
    [{ verb: "addressed-to", stage: "plan", text: WHY }]);

  // Whitespace is collapsed, exactly as every other condition form collapses it.
  assert.deepEqual(addressedConditions(["addressed-to design:   two    spaces  "]),
    [{ verb: "addressed-to", stage: "design", text: "two spaces" }]);

  // A line that opens with the verb and says nothing is reported as the malformed
  // condition it is, rather than read as a request with no reason on it.
  assert.deepEqual(malformedAddressedConditions([
    "addressed-to plan:",
    "addressed-to plan:    ",
    "addressed-to plan",
    CONDITION,
    MINE,
  ]), ["addressed-to plan:", "addressed-to plan:    ", "addressed-to plan"]);
});

test("a condition list splits into the conditions of the stage being asked and the ones addressed elsewhere", () => {
  const overreach = "test-overreaches R-1.2: the test reads an audit log the criterion never names";
  const split = splitConditionsByAddressee([MINE, CONDITION, overreach]);
  assert.deepEqual(split.mine, [MINE]);
  assert.deepEqual(split.elsewhere, [
    { stage: "plan", text: WHY },
    { stage: "derive-tests", text: "the test reads an audit log the criterion never names" },
  ]);

  // A list with nothing addressed elsewhere comes back exactly as it went in.
  assert.deepEqual(splitConditionsByAddressee([MINE]), { mine: [MINE], elsewhere: [], accounted: [] });
});

test("the stages a condition may be addressed to are the ones with a revision mode", () => {
  const stages = revisableStages();
  assert.ok(stages.includes("plan"), JSON.stringify(stages));
  assert.ok(stages.includes("build"));
  assert.ok(stages.includes("derive-tests"));
  // A stage that cannot be asked to do its work again is not one a condition can reach.
  assert.ok(!stages.includes("verify"), JSON.stringify(stages));
  assert.ok(!stages.includes("ratify"));
});

// --- filing, from either seat ---

// Everything about a request except the moment it was filed, which is the one field a
// test cannot state in advance.
const withoutTime = (r) => { const { at, ...rest } = r; assert.match(at, /^\d{4}-\d{2}-\d{2}T/); return rest; };

test("a human ruling that returns a proposal files the request and the ruler's own words", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-addressed-human-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => restoreEgress(prevEgress));

  openProposal(dir, "build-slice-2");
  const r = rule(dir, "build-slice-2", "return", {
    by: "tech-lead",
    note: "the slice is built as planned; the plan asked it for something it cannot show",
    conditions: [MINE, CONDITION],
  });
  assert.deepEqual(r.addressed, ["plan"]);

  // The gate file records the whole ruling, both conditions, on the branch.
  const gate = parseYaml(readFileSync(join(dir, ".sdlc/gates/build-slice-2.yaml"), "utf8"));
  assert.equal(gate.verdict, "return");
  assert.equal(gate.held_by, "human");
  assert.deepEqual(gate.conditions, [MINE, CONDITION]);

  // And the request is on main, where the stage it is addressed to reads it.
  assert.deepEqual(requestsOnMain(dir).map(withoutTime), [
    { stage: "plan", why: WHY, from: "build-slice-2", gate: "G3", by: "tech-lead" },
  ]);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/build-slice-2");
});

test("an agent in the same seat files the same request", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-addressed-agent-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => { mock(false); restoreEgress(prevEgress); });

  openProposal(dir, "slice-2-review");
  agentReply("return", [MINE, CONDITION]);
  const r = await ruleByAgent(dir, "slice-2-review", { persona: "reviewer" });
  assert.equal(r.verdict, "return");
  assert.deepEqual(r.addressed, ["plan"]);
  assert.deepEqual(requestsOnMain(dir).map(withoutTime), [
    { stage: "plan", why: WHY, from: "slice-2-review", gate: "G3", by: "agent:reviewer" },
  ]);
});

test("a condition naming a stage that cannot be asked to revise files nothing and says which", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-addressed-unknown-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => restoreEgress(prevEgress));

  openProposal(dir, "build-slice-2");
  const r = rule(dir, "build-slice-2", "return", {
    by: "tech-lead",
    note: "returned",
    conditions: ["addressed-to verify: the suite should have been run twice"],
  });
  assert.deepEqual(r.addressed, []);
  assert.deepEqual(r.unroutable, ["verify"]);
  assert.deepEqual(requestsOnMain(dir), []);
});

// --- the guard: this condition asks for a revision, and nothing else ---

test("an approval may not carry it, from either seat", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-addressed-approve-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => { mock(false); restoreEgress(prevEgress); });

  openProposal(dir, "build-slice-2");
  assert.throws(() => rule(dir, "build-slice-2", "approve", { by: "tech-lead", conditions: [CONDITION] }),
    /addressed-to.*return/s);
  assert.ok(!existsSync(join(dir, ".sdlc/gates/build-slice-2.yaml")), "nothing was ruled");
  assert.deepEqual(requestsOnMain(dir), [], "and nothing was filed");

  git(["checkout", "-q", "main"], dir);
  openProposal(dir, "slice-2-review");
  agentReply("approve", [CONDITION]);
  await assert.rejects(() => ruleByAgent(dir, "slice-2-review", { persona: "reviewer" }), /addressed-to.*return/s);
  assert.ok(!existsSync(join(dir, ".sdlc/gates/slice-2-review.yaml")));
  assert.deepEqual(requestsOnMain(dir), []);
});

// An approval carrying this form is the verdict and the condition disagreeing about what
// was just ruled, and the ruler's position can be perfectly coherent: the artifact in front
// of it is right, and another artifact has to change. The pipeline records neither claim,
// so the ruler is asked once which of the two it means rather than losing the turn over it.
test("an approval carrying it is re-prompted once, and the corrected ruling is what lands", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-addressed-approve-reprompt-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => { mock(false); restoreEgress(prevEgress); });

  openProposal(dir, "slice-2-review");
  agentVerdictSequence([["approve", [CONDITION]], ["return", [MINE, CONDITION]]]);
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let r;
  try { r = await ruleByAgent(dir, "slice-2-review", { persona: "reviewer" }); }
  finally { console.log = origLog; }

  assert.equal(r.verdict, "return");
  assert.equal(r.reprompted, true);
  const gate = parseYaml(readFileSync(join(dir, ".sdlc/gates/slice-2-review.yaml"), "utf8"));
  assert.deepEqual(gate.conditions, [MINE, CONDITION]);
  assert.match(gate.reprompt, /An approval may not carry it/);
  assert.equal(gate.turns, 2, "both turns are counted, not only the one that answered");
  // Said at the terminal as it happens, the way every other re-prompt is.
  assert.ok(logs.some((l) => /re-asking once/.test(l)), logs.join(" | "));
  // And the corrected ruling did the filing, so the request reached the stage.
  assert.deepEqual(requestsOnMain(dir).map(withoutTime), [
    { stage: "plan", why: WHY, from: "slice-2-review", gate: "G3", by: "agent:reviewer" },
  ]);
});

// The other way out of the re-prompt: the ruler meant the approval, and drops the
// condition. Nothing is filed, because nothing asked for anything.
test("an approval that drops the condition on the second turn is approved with it gone", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-addressed-approve-dropped-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => { mock(false); restoreEgress(prevEgress); });

  openProposal(dir, "slice-2-review");
  agentVerdictSequence([["approve", [CONDITION]], ["approve", []]]);
  const r = await ruleByAgent(dir, "slice-2-review", { persona: "reviewer" });
  assert.equal(r.verdict, "approve");
  assert.equal(r.reprompted, true);
  assert.deepEqual(requestsOnMain(dir), []);
});

// The guard is unchanged: a second reply still carrying it is refused exactly as before,
// and the refusal shows the whole ruling rather than the one line that sank it.
test("an approval still carrying it after the re-prompt is refused, with the verdict and every condition shown", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-addressed-approve-twice-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => { mock(false); restoreEgress(prevEgress); });

  openProposal(dir, "slice-2-review");
  agentVerdictSequence([["approve", [MINE, CONDITION]], ["approve", [MINE, CONDITION]]]);
  await assert.rejects(() => ruleByAgent(dir, "slice-2-review", { persona: "reviewer" }), (e) => {
    assert.match(e.message, /An approval may not carry it/);
    assert.match(e.message, /verdict: approve/);
    assert.ok(e.message.includes(MINE), "the condition that was fine is shown too");
    assert.ok(e.message.includes(CONDITION));
    return true;
  });
  assert.ok(!existsSync(join(dir, ".sdlc/gates/slice-2-review.yaml")), "nothing was ruled");
  assert.deepEqual(requestsOnMain(dir), [], "and nothing was filed");
});

test("it files a request and changes nothing the stage it is addressed to owns", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-addressed-scope-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => restoreEgress(prevEgress));

  git(["checkout", "-q", "main"], dir);
  const before = {
    plan: git(["rev-parse", "HEAD:plan"], dir),
    index: git(["rev-parse", "HEAD:spec/criteria-index.json"], dir),
  };

  openProposal(dir, "build-slice-2");
  rule(dir, "build-slice-2", "return", { by: "tech-lead", note: "returned", conditions: [CONDITION] });

  git(["checkout", "-q", "main"], dir);
  assert.equal(git(["rev-parse", "HEAD:plan"], dir), before.plan, "the plan itself is untouched");
  assert.equal(git(["rev-parse", "HEAD:spec/criteria-index.json"], dir), before.index);

  // The filing commit carries the request list and nothing else.
  const files = git(["show", "--name-only", "--format=", "HEAD"], dir).split("\n").filter(Boolean);
  assert.deepEqual(files, [".sdlc/revision-requests.yaml"]);

  // And no gate has been ruled by the filing: the plan's own gate still stands where it did.
  const gates = git(["show", "--name-only", "--format=", "HEAD"], dir);
  assert.ok(!gates.includes(".sdlc/gates/"), "a request rules nothing");
});

test("a form with no reason is refused, and nothing is ruled or filed", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-addressed-noreason-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => { mock(false); restoreEgress(prevEgress); });

  openProposal(dir, "build-slice-2");
  assert.throws(() => rule(dir, "build-slice-2", "return", { by: "tech-lead", conditions: ["addressed-to plan:   "] }),
    /carries no reason/);
  assert.ok(!existsSync(join(dir, ".sdlc/gates/build-slice-2.yaml")));
  assert.deepEqual(requestsOnMain(dir), []);

  git(["checkout", "-q", "main"], dir);
  openProposal(dir, "slice-2-review");
  agentReply("return", ["addressed-to plan:"]);
  await assert.rejects(() => ruleByAgent(dir, "slice-2-review", { persona: "reviewer" }), /carries no reason/);
  assert.deepEqual(requestsOnMain(dir), []);
});

// The same shape as the undeliverable-plain-condition defect: a line whose verb is right
// and whose reason is missing is a formatting slip, not a disagreement, so it gets the same
// one re-prompt before the refusal above is reached.
test("a form with no reason is re-prompted once, and the corrected reply is what lands", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-addressed-reprompt-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => { mock(false); restoreEgress(prevEgress); });

  openProposal(dir, "slice-2-review");
  agentReplySequence([[MINE, "addressed-to plan:"], [MINE, CONDITION]]);
  const r = await ruleByAgent(dir, "slice-2-review", { persona: "reviewer" });
  assert.equal(r.verdict, "return");
  assert.deepEqual(r.addressed, ["plan"]);
  const gate = parseYaml(readFileSync(join(dir, ".sdlc/gates/slice-2-review.yaml"), "utf8"));
  assert.deepEqual(gate.conditions, [MINE, CONDITION]);
  assert.deepEqual(requestsOnMain(dir).map(withoutTime), [
    { stage: "plan", why: WHY, from: "slice-2-review", gate: "G3", by: "agent:reviewer" },
  ]);
});

// A closed condition vocabulary is closed on purpose, and this verb is not read out of one.
test("a line in this form at a gate with a closed grammar is left to that grammar", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-addressed-g1-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => restoreEgress(prevEgress));

  propose(dir, "archaeology-fees", { gate: "G1", question: "Is this what the fees domain does?", recommendation: "Ruling wanted." });
  const r = rule(dir, "archaeology-fees", "return", { by: "tech-lead", note: "go again", conditions: [CONDITION] });
  assert.deepEqual(r.addressed ?? [], []);
  assert.deepEqual(requestsOnMain(dir), []);
  const gate = parseYaml(readFileSync(join(dir, ".sdlc/gates/archaeology-fees.yaml"), "utf8"));
  assert.deepEqual(gate.conditions, [CONDITION]);
});

// --- what a revise prompt carries, and what it says about what it does not ---
//
// These drive the stages directly against a bare repository holding a hand-written gate
// file, the way `test/plan-revise.test.mjs` does: what is under test is which conditions
// reach a prompt, which needs a ruling and a stage and nothing else.
import { mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { requestedRevision, returnedRulingOn, settleRequestedRevision } from "../src/stages/proposals.mjs";

const OVERREACH = "test-overreaches R-1.3: the test signs in as a reviewer and reads an audit log the criterion never names";

function repo(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-addressed-repo-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]);
  writeFileSync(join(d, "README.md"), "x\n");
  run(["add", "-A"]);
  run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "start"]);
  return { d, run };
}

// Enough of a project for the checks that run before a revision source: an accepted
// criterion to plan against, a screen catalogue, and a surface page in the domain.
function plannable(d, run) {
  mkdirSync(join(d, "spec", "contract"), { recursive: true });
  mkdirSync(join(d, "design"), { recursive: true });
  writeFileSync(join(d, "spec", "criteria-index.json"), JSON.stringify({
    generated_from: "0".repeat(40),
    criteria: [{ id: "R-1.1", domain: "applications", version: 1, state: "accepted", statement: "a submitted application is acknowledged" }],
  }));
  writeFileSync(join(d, "design", "screens.yaml"), "screens: []\n");
  writeFileSync(join(d, "spec", "contract", "surface.yaml"), "pages:\n  - id: applications-list\n    domain: applications\n    route: /applications\n");
  run(["add", "-A"]);
  run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "seed"]);
}

// A returned proposal standing on its own branch, ruled with `conditions`.
function returned(d, run, { name, gate, rationale, conditions }) {
  run(["checkout", "-q", "-b", `proposal/${name}`]);
  mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
  mkdirSync(join(d, ".sdlc", "proposals"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "proposals", `${name}.md`), `---\ngate: ${gate}\n---\n`);
  writeFileSync(join(d, ".sdlc", "gates", `${name}.yaml`),
    `gate: ${gate}\nverdict: return\nby: agent:reviewer\nheld_by: agent\nrationale: ${rationale}\n`
    + `conditions:\n${conditions.map((c) => `  - ${JSON.stringify(c)}`).join("\n")}\n`);
  run(["add", "-A"]);
  run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "returned"]);
  run(["checkout", "-q", "main"]);
}

test("a returned ruling hands a stage its own conditions and accounts for the rest by stage", (t) => {
  const { d, run } = repo(t);
  returned(d, run, { name: "plan", gate: "G2", rationale: "three of these are not the planner's", conditions: [MINE, CONDITION, OVERREACH] });
  const found = returnedRulingOn(d, "plan", "proposal/plan");
  assert.deepEqual(found.conditions, [MINE]);
  assert.deepEqual(found.addressedElsewhere, [
    { stage: "plan", text: WHY },
    { stage: "derive-tests", text: OVERREACH.slice("test-overreaches R-1.3: ".length) },
  ]);
});

// A closed grammar is closed on purpose: nothing reads a second verb out of it, so
// nothing is taken out of the list the stage that owns the grammar is given.
test("a ruling whose conditions are a closed grammar keeps every line", (t) => {
  const { d, run } = repo(t);
  returned(d, run, { name: "archaeology-fees", gate: "G1", rationale: "go again", conditions: [CONDITION, "spec-wrong R-1.1: the statement names the wrong actor"] });
  const found = returnedRulingOn(d, "archaeology-fees", "proposal/archaeology-fees");
  assert.deepEqual(found.conditions, [CONDITION, "spec-wrong R-1.1: the statement names the wrong actor"]);
  assert.deepEqual(found.addressedElsewhere, []);
});

test("a plan revise prompt carries only the planner's conditions, and names the ones it is not carrying", (t) => {
  const { d, run } = repo(t);
  plannable(d, run);
  const planCondition = "plan/tasks.md leaves criterion R-1.3 unassigned to any slice";
  returned(d, run, {
    name: "plan", gate: "G2", rationale: "the cut is close",
    conditions: [planCondition, "addressed-to design: the screen the second slice delivers is not drawn anywhere", OVERREACH],
  });
  const stage = stageFor("plan");
  const ctx = { revise: true, dryRun: true };
  const check = stage.preChecks(d, ctx).find((c) => c.id === "plan-revise-source");
  assert.equal(check.ok, true);

  const prompt = stage.prompt(ctx);
  assert.match(prompt, /- plan\/tasks\.md leaves criterion R-1\.3 unassigned/, "its own condition is carried");
  assert.ok(!prompt.includes("- addressed-to design:"), "and a condition for another stage is not");
  assert.ok(!prompt.includes("- test-overreaches"), "nor one naming a criterion whose test another stage writes");

  // Told they exist, told where they went, and told in whose words.
  assert.match(prompt, /2 condition/, "the count of what is not being carried");
  assert.match(prompt, /to design: the screen the second slice delivers is not drawn anywhere/);
  assert.match(prompt, /to derive-tests: the test signs in as a reviewer/);
});

test("a build revise prompt reports the same way", (t) => {
  const { d, run } = repo(t);
  returned(d, run, { name: "build-slice-2", gate: "G3", rationale: "two of these are yours", conditions: [MINE, CONDITION] });
  const found = returnedRulingOn(d, "build-slice-2", "proposal/build-slice-2");
  const ctx = {
    revise: true,
    slice: 2,
    revision: { name: "build-slice-2", ...found },
    buildSlice: { number: 2, body: "a slice", criteria: ["R-1.1"] },
    config: { project: { name: "p" }, targets: { new: { base_url: "http://localhost:3000" } } },
  };
  const prompt = stageFor("build").prompt(ctx);
  assert.match(prompt, /- app\/routes\.js returns 500/);
  assert.ok(!prompt.includes("- addressed-to plan:"));
  assert.match(prompt, /1 condition/);
  assert.match(prompt, /to plan: slice 2 claims a criterion about a fee/);
});

// --- an approved artifact, reopened by a condition raised against it ---

// Requests on file, addressed to a stage, the way rulings elsewhere leave them. `entries`
// are written in the order given, which is the order they were filed in.
function requestsOnFile(d, run, entries) {
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  const rows = entries.map((e, i) => `  - stage: ${e.stage}\n    why: ${JSON.stringify(e.why)}\n`
    + `    from: ${e.from ?? "build-slice-2"}\n    gate: ${e.gate ?? "G3"}\n    by: ${e.by ?? "agent:reviewer"}\n`
    + `    at: 2026-01-0${i + 1}T00:00:00.000Z\n`);
  writeFileSync(join(d, ".sdlc", "revision-requests.yaml"), `requests:\n${rows.join("")}`);
  run(["add", "-A"]);
  run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "filed"]);
}

function requestOnMain(d, run, stage, why) {
  requestsOnFile(d, run, [{ stage, why }]);
}

test("a stage with nothing returned is revisable by a request addressed to it, and is handed the reason verbatim", (t) => {
  const { d, run } = repo(t);
  plannable(d, run);
  requestOnMain(d, run, "plan", WHY);
  const stage = stageFor("plan");
  const ctx = { revise: true, dryRun: true };
  const check = stage.preChecks(d, ctx).find((c) => c.id === "plan-revise-source");
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(ctx.revision.name, null, "there is no returned proposal behind this one");
  assert.equal(ctx.revision.requests.length, 1);
  assert.equal(ctx.revision.requests[0].from, "build-slice-2");

  const prompt = stage.prompt(ctx);
  assert.ok(prompt.includes(WHY), "the reason reaches the stage that has to do the work");
  assert.match(prompt, /build-slice-2/, "with the proposal it was raised on");
  assert.match(prompt, /G3/, "the gate it was raised at");
  assert.match(prompt, /agent:reviewer/, "and who raised it");
  assert.match(prompt, /own gate/, "and that its own gate is what accepts the result");

  // No overlay: what is being revised is on main, already approved, not on a branch.
  assert.equal(ctx.revision.branchCommit, undefined);
});

test("a request is spent by a run that delivered, not by the run that read it", async (t) => {
  const { d, run } = repo(t);
  plannable(d, run);
  requestOnMain(d, run, "plan", WHY);
  const head = git(["rev-parse", "HEAD"], d);
  const ctx = { revise: true };
  assert.equal(stageFor("plan").preChecks(d, ctx).find((c) => c.id === "plan-revise-source").ok, true);

  // Reading the round costs nothing. A run refused after this point, or one whose agent
  // turn never comes back, leaves the ask for the next run to find.
  assert.equal(openRevisionRequestsFor(d, "plan").length, 1, "still open until something is delivered");
  assert.equal(git(["rev-parse", "HEAD"], d), head, "and nothing has been committed for it");

  settleRequestedRevision(d, "plan", ctx, "## Journal\n\nThe slice now gives the criterion up.", "plan-2");

  assert.deepEqual(openRevisionRequestsFor(d, "plan"), [], "nothing is left open for a second run to take again");
  const [taken] = readRevisionRequests(d);
  assert.equal(taken.why, WHY, "the reason an approved artifact was opened again survives being acted on");
  assert.equal(taken.from, "build-slice-2");
  assert.match(taken.taken, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(git(["log", "-1", "--pretty=%s"], d), /^record\(plan\): 1 revision request taken up by plan-2$/);

  // Taken up means taken up, not answered: the next run has nothing to start from again.
  const second = { revise: true };
  const again = stageFor("plan").preChecks(d, second).find((c) => c.id === "plan-revise-source");
  assert.equal(again.ok, false);
  assert.match(again.messages[0], /no returned plan ruling/);
});

// The guard the whole route turns on: a request asks for work, and asks for nothing else.
test("taking a request rules nothing, approves nothing and changes no artifact", (t) => {
  const { d, run } = repo(t);
  plannable(d, run);
  mkdirSync(join(d, "plan"), { recursive: true });
  writeFileSync(join(d, "plan", "tasks.md"), "# slices\n");
  run(["add", "-A"]);
  run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "plan"]);
  requestOnMain(d, run, "plan", WHY);
  const before = execFileSync("git", ["rev-parse", "HEAD:plan"], { cwd: d, encoding: "utf8" }).trim();

  const ctx = { revise: true };
  stageFor("plan").preChecks(d, ctx);
  settleRequestedRevision(d, "plan", ctx, "## Journal\n\nThe slice now gives the criterion up.", "plan-2");

  assert.equal(execFileSync("git", ["rev-parse", "HEAD:plan"], { cwd: d, encoding: "utf8" }).trim(), before,
    "the artifact the request names is not touched by the request");
  const files = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: d, encoding: "utf8" });
  assert.deepEqual(files.split("\n").filter(Boolean), [".sdlc/revision-requests.yaml"]);
  assert.ok(!existsSync(join(d, ".sdlc", "gates")), "and no gate has been ruled");
  assert.equal(readRevisionRequests(d).length, 1, "the request itself was taken up, so this is what taking one does");
  assert.ok(readRevisionRequests(d)[0].taken);
});

// The mechanism is keyed on a stage having a revision mode, not on a list of stage names.
test("a request reaches any stage that can be asked to revise", (t) => {
  const { d, run } = repo(t);
  plannable(d, run);
  requestOnMain(d, run, "design", "the screen the second slice delivers is not drawn anywhere");
  const ctx = { revise: true, domain: "applications", dryRun: true, config: { project: { domains: ["applications"] } } };
  const check = stageFor("design").preChecks(d, ctx).find((c) => c.id === "design-revise-source");
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.ok(stageFor("design").prompt(ctx).includes("the screen the second slice delivers is not drawn anywhere"));

  // Including a stage that writes its revise prompt itself rather than through the shared
  // renderer, and which must not tell the writer its own proposal was returned.
  const { d: d2, run: run2 } = repo(t);
  requestOnMain(d2, run2, "derive-tests", "the applications suite asserts a total no criterion states");
  const testsCtx = { revise: true, domain: "applications", dryRun: true };
  testsCtx.revision = requestedRevision(d2, "derive-tests");
  const testsPrompt = stageFor("derive-tests").prompt(testsCtx);
  assert.ok(testsPrompt.includes("the applications suite asserts a total no criterion states"));
  assert.ok(!testsPrompt.includes("proposed and returned"), "a reopening is not a return");
});

test("a dry run reads the request and does not take it", (t) => {
  const { d, run } = repo(t);
  requestOnMain(d, run, "plan", WHY);
  const ctx = { revise: true, dryRun: true };
  stageFor("plan").preChecks(d, ctx);
  assert.equal(openRevisionRequestsFor(d, "plan").length, 1);
});

// A revision source is the one pre-check with a side effect of its own, so it is settled
// last: a run refused for an unrelated reason must leave the request for the corrected
// re-run to find, not spend it on a run that never happened.
test("a run refused by an earlier pre-check leaves the request open", (t) => {
  const { d, run } = repo(t);
  requestOnMain(d, run, "plan", WHY);
  const ctx = { revise: true };
  const checks = stageFor("plan").preChecks(d, ctx);
  assert.ok(checks.some((c) => !c.ok), "this repository has no criteria to plan against");
  assert.equal(openRevisionRequestsFor(d, "plan").length, 1);
});

// --- two requests addressed to one stage are one round ---
//
// A ruler who routes two conditions to the same stage means them together: they are halves
// of one observation about that artifact, and an artifact that answers one of them alone
// can end up consistent with neither.

const WHY_SECOND = "slice 3 claims the same criterion as slice 2, so whichever slice keeps it has to be the only one that does";
const WHY_OTHER = "the slices are cut so that nothing is demonstrable until the last of them lands";

test("every open request addressed to a stage reaches its prompt, in its ruler's own words, as one round", (t) => {
  const { d, run } = repo(t);
  plannable(d, run);
  requestsOnFile(d, run, [{ stage: "plan", why: WHY }, { stage: "plan", why: WHY_SECOND }]);

  const ctx = { revise: true, dryRun: true };
  assert.equal(stageFor("plan").preChecks(d, ctx).find((c) => c.id === "plan-revise-source").ok, true);
  assert.equal(ctx.revision.requests.length, 2, "the whole round, not the head of the queue");

  const prompt = stageFor("plan").prompt(ctx);
  assert.ok(prompt.includes(WHY), "the first ruler's words, verbatim");
  assert.ok(prompt.includes(WHY_SECOND), "and the second's");
  assert.match(prompt, /^1\. build-slice-2 — ruled at G3 by agent:reviewer:$/m, "each numbered, with where it came from");
  assert.match(prompt, /^2\. build-slice-2 — ruled at G3 by agent:reviewer:$/m);
  assert.match(prompt, /2 conditions ruled elsewhere are addressed to this stage/);
  assert.match(prompt, /They are one round and every one of them is here\. Answer all of them in this run/);
  assert.match(prompt, /deferred-request <n>: <why it cannot be answered here>/,
    "and the one thing it may say back about an ask it cannot answer");
});

test("requests from different rulings stay in filing order, with one ruling's own kept together", (t) => {
  const { d, run } = repo(t);
  plannable(d, run);
  requestsOnFile(d, run, [
    { stage: "plan", why: WHY, from: "build-slice-2" },
    { stage: "plan", why: WHY_OTHER, from: "build-slice-3" },
    { stage: "plan", why: WHY_SECOND, from: "build-slice-2" },
  ]);
  const ctx = { revise: true, dryRun: true };
  stageFor("plan").preChecks(d, ctx);
  assert.deepEqual(ctx.revision.requests.map((r) => r.why), [WHY, WHY_SECOND, WHY_OTHER],
    "the older ruling first, and both of its conditions before the newer ruling's");
});

// A revision driven by a returned ruling answers that ruling. A request filed against the
// same stage from somewhere else is open the whole time and is no part of it, so the writer
// is told it exists rather than being handed a narrower job with nothing to explain it.
test("a revision from a returned ruling names the requests addressed to the same stage that it is not answering", (t) => {
  const { d, run } = repo(t);
  plannable(d, run);
  requestOnMain(d, run, "plan", WHY);
  returned(d, run, {
    name: "plan", gate: "G2", rationale: "the cut is close",
    conditions: ["plan/tasks.md leaves criterion R-1.3 unassigned to any slice"],
  });

  const ctx = { revise: true, dryRun: true };
  assert.equal(stageFor("plan").preChecks(d, ctx).find((c) => c.id === "plan-revise-source").ok, true);
  const prompt = stageFor("plan").prompt(ctx);
  assert.match(prompt, /1 request addressed to this stage is open and no part of this revision/);
  assert.ok(prompt.includes(`- from build-slice-2 (G3, agent:reviewer): ${WHY}`));
  assert.equal(openRevisionRequestsFor(d, "plan").length, 1, "and it stays open, because this run is not answering it");
});

// --- the round is spent, or deferred, where the run delivers ---

function fileRequests(dir, entries) {
  addRevisionRequests(dir, entries.map((e, i) => ({
    stage: e.stage, why: e.why, from: e.from ?? "build-slice-2", gate: "G3", by: "agent:reviewer",
    at: `2026-01-0${i + 1}T00:00:00.000Z`,
  })));
  git(["add", "-A"], dir);
  git([...COMMIT, "file revision requests"], dir);
}

// A gated stage reduced to what `finishStage` reads of one: a name, a gate the policy
// holds, post-checks that pass and a proposal to open. What is under test is what happens
// to the round when the work lands, which no part of a real stage's own work decides.
const deliveringStage = {
  name: "plan",
  title: "plan (revise)",
  gate: "G2",
  postChecks: () => [],
  proposal: () => ({ name: "plan-2", question: "Is the revised cut right?", recommendation: "the slices were recut" }),
};

async function deliver(dir, journal) {
  const ctx = { revise: true, revision: requestedRevision(dir, "plan") };
  const r = await finishStage(dir, deliveringStage, ctx, { text: journal, cost: 0, turns: 1, sessionId: "mock" });
  assert.equal(r.ok, true, JSON.stringify(r.messages));
  return { ctx, result: r };
}

test("a run that delivers marks every request of its round taken, at one instant and in one commit", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-round-taken-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { dir, prevEgress } = await newFixtureProject(tmp, "round-taken");
  try {
    fileRequests(dir, [{ stage: "plan", why: WHY }, { stage: "plan", why: WHY_SECOND }]);
    const { ctx } = await deliver(dir, "## Journal\n\nBoth asks are about the same criterion, and the recut answers them together.");
    assert.equal(ctx.revision.requests.length, 2);

    const list = readRevisionRequests(dir);
    assert.equal(list.filter((r) => r.taken).length, 2, "both, or the next run answers half an ask");
    assert.equal(list[0].taken, list[1].taken, "at the same instant: a round moves whole");
    assert.deepEqual(openRevisionRequestsFor(dir, "plan"), []);
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /^record\(plan\): 2 revision requests taken up by plan-2$/);
    assert.deepEqual(git(["show", "--name-only", "--format=", "HEAD"], dir).split("\n").filter(Boolean),
      [".sdlc/revision-requests.yaml"], "the ledger alone: taking a round rules nothing and merges nothing");
  } finally {
    restoreEgress(prevEgress);
  }
});

test("a request the run says it could not answer is left open, with its reason on file", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-round-deferred-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { dir, prevEgress } = await newFixtureProject(tmp, "round-deferred");
  const DEFERRED = "the screen this would need is not drawn anywhere, and a plan cannot add one";
  try {
    fileRequests(dir, [{ stage: "plan", why: WHY }, { stage: "plan", why: WHY_SECOND }]);
    await deliver(dir, `## Journal\n\nThe first ask is answered: slice 2 gives the criterion up.\n\ndeferred-request 2: ${DEFERRED}`);

    const list = readRevisionRequests(dir);
    assert.ok(list[0].taken, "the one the run answered is spent");
    assert.ok(!list[1].taken, "and the one it could not is still asked for");
    assert.equal(list[1].why, WHY_SECOND, "unchanged");
    assert.equal(list[1].deferred.why, DEFERRED, "with the account of why it could not be answered here");
    assert.equal(list[1].deferred.proposal, "plan-2");
    assert.deepEqual(openRevisionRequestsFor(dir, "plan").map((r) => r.why), [WHY_SECOND]);
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /^record\(plan\): 1 of 2 revision requests taken up by plan-2$/);
    assert.match(git(["log", "-1", "--pretty=%b"], dir), /deferred, still open: build-slice-2 \(G3\)/);
  } finally {
    restoreEgress(prevEgress);
  }
});

test("a round nothing can match whole is not marked at all", (t) => {
  const { d, run } = repo(t);
  requestsOnFile(d, run, [{ stage: "plan", why: WHY }, { stage: "plan", why: WHY_SECOND }]);
  const round = openRevisionRequestsFor(d, "plan");

  // The second entry is spent underneath — a round already settled once, a file edited by
  // hand. Marking the first anyway would report half a round as answered.
  settleRevisionRound(d, { taken: [round[1]] });
  assert.equal(settleRevisionRound(d, { taken: round }), null, "nothing is written");
  const list = readRevisionRequests(d);
  assert.ok(!list[0].taken, "the request nothing answered is still open");
  assert.ok(list[1].taken);
});

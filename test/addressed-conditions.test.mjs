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
import { readRevisionRequests } from "../src/spec/revisions.mjs";

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
async function ready(tmp) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  const dir = join(tmp, "permit-intake");
  await newProject({ dir, from: FROM });
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  git(["add", "-A"], dir);
  git([...COMMIT, "fill constitution"], dir);

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
  assert.deepEqual(splitConditionsByAddressee([MINE]), { mine: [MINE], elsewhere: [] });
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
import { returnedRulingOn } from "../src/stages/proposals.mjs";
import { openRevisionRequestsFor } from "../src/spec/revisions.mjs";

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

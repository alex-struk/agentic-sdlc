// test/test-overreaches.test.mjs — `test-overreaches <ID>: <why>`, the ruling that says a
// criterion stands and the acceptance test derived from it reaches past what it asks for.
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
import { rule, ruleByAgent, buildVerified } from "../src/commands/rule.mjs";
import { stageFor } from "../src/stages/registry.mjs";
import { loadConfig } from "../src/config/load.mjs";
import { overreachConditions, malformedOverreachConditions } from "../src/spec/criteria.mjs";
import { readRedo } from "../src/spec/redo.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;
const MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;
const COMMIT = ["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m"];

// The ruling's own words, and the shape they arrive in. Both are neutral: the criterion
// says a status changes, and the test derived from it went and read an audit log nobody
// asked for.
const WHY = "the test signs in as a reviewer and reads an audit log entry; the criterion says only that the status changes, and names no audit log at all";
const CONDITION = `test-overreaches R-1.2: ${WHY}`;

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

// A project whose `applications` domain is ratified (R-1.1, R-1.2, R-1.3 accepted), whose
// contract is approved, and whose blind acceptance suite is on main — everything a ruling
// needs to turn a criterion id into a redo entry, and everything `derive-tests --stale`
// reads to build its prompt.
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
// reported `unbound` against it and written no gate file.
function openProposal(dir, name) {
  propose(dir, name, { gate: "G3", question: "Does this slice do what its criteria say?", recommendation: "Ruling wanted." });
  return name;
}

// The mock executor answers every ruling turn from one `rule.json`.
function agentReply(verdict, conditions, rationale = "the criterion is right; its test is not") {
  const d = mkdtempSync(join(tmpdir(), "sdlc-overreach-mock-"));
  writeFileSync(join(d, "rule.json"), JSON.stringify({ text: `\`\`\`json\n${JSON.stringify({ verdict, rationale, conditions })}\n\`\`\`` }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = d;
}

const redoOnMain = (dir) => {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  if (branch !== "main") git(["checkout", "-q", "main"], dir);
  const list = readRedo(dir);
  if (branch !== "main") git(["checkout", "-q", branch], dir);
  return list;
};

// --- the form itself ---

test("the condition form carries a criterion id and a reason, and a form with no reason is not one", () => {
  const parsed = overreachConditions([CONDITION, "R-1.1 still fails against the application"]);
  assert.deepEqual(parsed, [{ verb: "test-overreaches", id: "R-1.2", text: WHY }]);

  // Whitespace is collapsed, exactly as every other condition form collapses it.
  assert.deepEqual(overreachConditions(["test-overreaches R-1.3:   two    spaces  "]),
    [{ verb: "test-overreaches", id: "R-1.3", text: "two spaces" }]);

  // A line that opens with the verb and says nothing is reported as the malformed
  // condition it is, rather than read as a request with no reason on it.
  assert.deepEqual(malformedOverreachConditions([
    "test-overreaches R-1.2:",
    "test-overreaches R-1.2:    ",
    "test-overreaches R-1.2",
    CONDITION,
    "some other condition",
  ]), ["test-overreaches R-1.2:", "test-overreaches R-1.2:    ", "test-overreaches R-1.2"]);
});

// --- filing, from either seat ---

test("a human ruling that returns a proposal files the criterion and the ruler's own words", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-overreach-human-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => restoreEgress(prevEgress));

  openProposal(dir, "build-slice-1");
  const r = rule(dir, "build-slice-1", "return", {
    by: "tech-lead",
    note: "R-1.2 could not be exercised; its test reaches past the criterion",
    conditions: [CONDITION],
  });
  assert.deepEqual(r.filed, ["R-1.2"]);

  // The gate file records the ruling in the same shape an agent's does, on the branch.
  const gate = parseYaml(readFileSync(join(dir, ".sdlc/gates/build-slice-1.yaml"), "utf8"));
  assert.equal(gate.verdict, "return");
  assert.equal(gate.held_by, "human");
  assert.deepEqual(gate.conditions, [CONDITION]);

  // And the request is on main, where `derive-tests --stale` reads it.
  assert.deepEqual(redoOnMain(dir), [{ id: "R-1.2", version: 1, why: WHY, verb: "test-overreaches" }]);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/build-slice-1");
});

test("an agent in the same seat files the same entry", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-overreach-agent-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => { mock(false); restoreEgress(prevEgress); });

  openProposal(dir, "slice-1-review");
  agentReply("return", [CONDITION]);
  const r = await ruleByAgent(dir, "slice-1-review", { persona: "reviewer" });
  assert.equal(r.verdict, "return");
  assert.deepEqual(r.filed, ["R-1.2"]);
  assert.deepEqual(redoOnMain(dir), [{ id: "R-1.2", version: 1, why: WHY, verb: "test-overreaches" }]);
});

// --- the guard: this verdict asks for a test to be written again, and nothing else ---

test("an approval may not carry it, from either seat", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-overreach-approve-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => { mock(false); restoreEgress(prevEgress); });

  openProposal(dir, "build-slice-1");
  assert.throws(() => rule(dir, "build-slice-1", "approve", { by: "tech-lead", conditions: [CONDITION] }),
    /test-overreaches.*return/s);
  assert.ok(!existsSync(join(dir, ".sdlc/gates/build-slice-1.yaml")), "nothing was ruled");
  assert.deepEqual(redoOnMain(dir), [], "and nothing was filed");

  git(["checkout", "-q", "main"], dir);
  openProposal(dir, "slice-1-review");
  agentReply("approve", [CONDITION]);
  await assert.rejects(() => ruleByAgent(dir, "slice-1-review", { persona: "reviewer" }), /test-overreaches.*return/s);
  assert.ok(!existsSync(join(dir, ".sdlc/gates/slice-1-review.yaml")));
  assert.deepEqual(redoOnMain(dir), []);
});

test("it files a request and changes nothing about the criterion or about what has been verified", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-overreach-scope-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => restoreEgress(prevEgress));

  // The state verify leaves behind when it reports `unbound`: a result recording the
  // verdict, and no gate file.
  git(["checkout", "-q", "main"], dir);
  const before = {
    index: git(["rev-parse", "HEAD:spec/criteria-index.json"], dir),
    domain: git(["rev-parse", "HEAD:spec/domains/applications.md"], dir),
    suite: git(["rev-parse", "HEAD:tests/acceptance/applications"], dir),
  };

  openProposal(dir, "build-slice-1");
  rule(dir, "build-slice-1", "return", { by: "tech-lead", note: "returned", conditions: [CONDITION] });

  git(["checkout", "-q", "main"], dir);
  assert.equal(git(["rev-parse", "HEAD:spec/criteria-index.json"], dir), before.index, "the criterion is untouched");
  assert.equal(git(["rev-parse", "HEAD:spec/domains/applications.md"], dir), before.domain);
  assert.equal(git(["rev-parse", "HEAD:tests/acceptance/applications"], dir), before.suite, "no test is rewritten by the ruling");

  // The filing commit carries the redo list and nothing else.
  const files = git(["show", "--name-only", "--format=", "HEAD"], dir).split("\n").filter(Boolean);
  assert.deepEqual(files, ["tests/acceptance/redo.yaml"]);

  // And the criterion is no nearer to passing: the slice is still unverified.
  assert.equal(buildVerified(dir, "build-slice-1").ok, false);
});

test("a form with no reason is refused, and nothing is ruled or filed", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-overreach-noreason-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => { mock(false); restoreEgress(prevEgress); });

  openProposal(dir, "build-slice-1");
  assert.throws(() => rule(dir, "build-slice-1", "return", { by: "tech-lead", conditions: ["test-overreaches R-1.2:   "] }),
    /carries no reason/);
  assert.ok(!existsSync(join(dir, ".sdlc/gates/build-slice-1.yaml")));
  assert.deepEqual(redoOnMain(dir), []);

  git(["checkout", "-q", "main"], dir);
  openProposal(dir, "slice-1-review");
  agentReply("return", ["test-overreaches R-1.2:"]);
  await assert.rejects(() => ruleByAgent(dir, "slice-1-review", { persona: "reviewer" }), /carries no reason/);
  assert.deepEqual(redoOnMain(dir), []);
});

test("a condition naming a criterion the project does not have files nothing and says which line", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-overreach-unknown-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => restoreEgress(prevEgress));

  openProposal(dir, "build-slice-1");
  const r = rule(dir, "build-slice-1", "return", {
    by: "tech-lead",
    note: "returned",
    conditions: ["test-overreaches R-9.9: the test asserts a total the criterion never mentions"],
  });
  assert.deepEqual(r.filed, []);
  assert.deepEqual(r.unfiled, ["R-9.9"]);
  assert.deepEqual(redoOnMain(dir), []);
});

// --- the reason reaching the writer ---

test("the ruler's reason reaches the prompt derive-tests --stale hands the test writer", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-overreach-prompt-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => restoreEgress(prevEgress));

  openProposal(dir, "build-slice-1");
  rule(dir, "build-slice-1", "return", { by: "tech-lead", note: "returned", conditions: [CONDITION] });
  git(["checkout", "-q", "main"], dir);

  const { config } = loadConfig(join(dir, ".sdlc", "config.yaml"));
  const stage = stageFor("derive-tests");
  const ctx = { domain: "applications", stale: true, projectDir: dir, config };
  const checks = stage.preChecks(dir, ctx);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  assert.deepEqual((ctx.deriveTestsCriteria ?? []).map((c) => c.id), ["R-1.2"],
    "only the criterion the ruling named is derived again");

  const prompt = stage.prompt(ctx);
  assert.ok(prompt.includes(WHY), "the ruler's own words reach the stage that has to redo the work");
  assert.match(prompt, /R-1\.2/);
  assert.match(prompt, /reached past/, "and are framed as what the replacement must not do");

  // A domain nobody has sent anything back for reads exactly as it always has.
  const plain = { domain: "applications", projectDir: dir, config };
  stage.preChecks(dir, plain);
  assert.ok(!stage.prompt(plain).includes(WHY));
});

// A closed condition vocabulary is closed on purpose. At G1 nothing has been derived yet,
// the ratification and calibration grammars own every line, and a line one of them cannot
// read is recorded verbatim for a person to rewrite — not read as a second verb and acted
// on behind the stage that refuses the file.
test("a line in this form at a gate with a closed grammar is left to that grammar", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-overreach-g1-"));
  const { dir, prevEgress } = await ready(tmp);
  t.after(() => restoreEgress(prevEgress));

  propose(dir, "archaeology-fees", { gate: "G1", question: "Is this what the fees domain does?", recommendation: "Ruling wanted." });
  const r = rule(dir, "archaeology-fees", "return", { by: "tech-lead", note: "go again", conditions: [CONDITION] });
  assert.deepEqual(r.filed, []);
  assert.deepEqual(redoOnMain(dir), []);
  // The line itself is kept exactly as it was written, where the ratification grammar's
  // own reader will report it.
  const gate = parseYaml(readFileSync(join(dir, ".sdlc/gates/archaeology-fees.yaml"), "utf8"));
  assert.deepEqual(gate.conditions, [CONDITION]);
});

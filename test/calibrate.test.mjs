// test/calibrate.test.mjs — the `calibrate` stage: run the merged acceptance suite
// against a target, turn every failure into a product-owner ruling, and apply the
// rulings that came back on the next run.
//
// Builds its own fixture the way test/test-stages.test.mjs does — a ratified
// `applications` domain, an approved contract, the blind acceptance suite and the old
// target's adapter — and drives every stage through the mock executor, the mock oracle
// and the mock test runner, so nothing here needs Docker, a browser or a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { git } from "../src/lib/git.mjs";
import { readJournal } from "../src/runner/journal.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { rule, ruleByAgent } from "../src/commands/rule.mjs";
import { propose } from "../src/commands/propose.mjs";
import { writeLocal } from "../src/oracle/ports.mjs";
import { STAGES, PROFILES } from "../src/profiles.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;
const MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;

const COMMIT = ["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m"];

async function makeProject(tmp) {
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
  return { dir, prevEgress };
}

function restoreEgress(prev) {
  if (prev === undefined) delete process.env.SDLC_EGRESS_NAMES;
  else process.env.SDLC_EGRESS_NAMES = prev;
}

// Three confirmed criteria for the applications domain, ratified in one pass the way
// test/test-stages.test.mjs does it: this file's subject is calibration, not the path a
// domain takes to being ratified.
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

const ORACLE_BLOCK = `
oracle:
  target: old
  compose: sources/old/docker-compose.yml
  seed: tests/seed/
  base_url: http://localhost:3100
  identity: sandbox-idp
`;

// `readLocal`/`writeLocal` round-trip exactly this shape (`src/oracle/ports.mjs`) —
// standing in for what a real `sdlc oracle up` would have written. The ports are
// deliberately not the ones `ORACLE_BLOCK` configures: `oracle up` takes whatever was
// free on the machine it ran on, so the live URL and the configured URL genuinely differ,
// and a result set that recorded the live one would be committing one laptop's accident.
function writeOldOracleLocal(dir) {
  writeLocal(dir, "old", {
    target: "old",
    base_url: "http://localhost:3187",
    mail_api: "http://localhost:8031",
    ports: { app: 3187, db: 5507, mail_api: 8031 },
    compose_project: "sdlc-permit-intake-old",
  });
}

// A project with `applications` ratified (R-1.1, R-1.2, R-1.3 accepted), the contract
// approved, the blind acceptance suite merged (specs for R-1.1 and R-1.2, R-1.3 recorded
// not-testable) and the old target's adapter merged — everything `calibrate` reads.
// G1 is rebound to the product-owner persona at the end, after the two G1 rulings this
// setup makes as a human: a calibration ruling carries conditions, and only an agent
// ruling can attach them.
async function makeReadyForCalibrate(tmp) {
  const { dir, prevEgress } = await makeProject(tmp);

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

  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  const contractRun = await runStage(dir, "contract");
  if (!contractRun.ok) throw new Error(`contract failed: ${JSON.stringify(contractRun.messages)}`);
  delete process.env.SDLC_EXECUTOR;
  delete process.env.SDLC_MOCK_DIR;
  rule(dir, "contract-v1", "approve", { by: "tech-lead" });

  const cfgPath = join(dir, ".sdlc", "config.yaml");
  writeFileSync(cfgPath, readFileSync(cfgPath, "utf8")
    .replace("G1: { holder: tech-lead }", 'G1: { holder: "agent:product-owner", escalate_to: tech-lead }')
    + ORACLE_BLOCK);
  git(["add", "-A"], dir);
  git([...COMMIT, "the product owner holds G1; the old target is the oracle (test)"], dir);

  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  const derived = await runStage(dir, "derive-tests", { domain: "applications" });
  if (!derived.ok) throw new Error(`derive-tests failed: ${JSON.stringify(derived.messages)}`);
  delete process.env.SDLC_EXECUTOR;
  delete process.env.SDLC_MOCK_DIR;
  // G3's holder is the reviewer persona; tech-lead is its escalate_to and may rule directly.
  rule(dir, "derive-tests-applications", "approve", { by: "tech-lead" });

  writeOldOracleLocal(dir);
  process.env.SDLC_ORACLE = "mock";
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  const bound = await runStage(dir, "bind-adapter", { target: "old" });
  if (!bound.ok) throw new Error(`bind-adapter failed: ${JSON.stringify(bound.messages)}`);
  delete process.env.SDLC_ORACLE;
  delete process.env.SDLC_EXECUTOR;
  delete process.env.SDLC_MOCK_DIR;
  rule(dir, "bind-adapter-old", "approve", { by: "tech-lead" });

  return { dir, prevEgress };
}

// The mock test runner reads `<SDLC_MOCK_DIR>/calibrate.json` for its rows
// (`src/testrun/playwright.mjs`), so a test that wants a different suite outcome writes
// its own directory rather than the fixture's.
function mockRunnerDir(name, rows) {
  const d = mkdtempSync(join(tmpdir(), `sdlc-calibrate-rows-${name}-`));
  writeFileSync(join(d, "calibrate.json"), JSON.stringify({ rows }));
  return d;
}

const PASSING_ROW = {
  id: "R-1.1", version: 1, domain: "applications", file: "tests/acceptance/applications/R-1.1.spec.ts",
  result: "pass",
  tests: [{ title: "the applicant is under 19 years old", status: "passed" }],
};

const FAILING_ROW = {
  id: "R-1.2", version: 1, domain: "applications", file: "tests/acceptance/applications/R-1.2.spec.ts",
  result: "fail",
  tests: [{
    title: "When a permit application is accepted, the system shall change its status to accepted.",
    status: "failed",
    error: "expect(received).toBe(expected)\n\nExpected: \"accepted\"\nReceived: \"submitted\"",
  }],
};

function calibrateEnv(mockDir) {
  process.env.SDLC_ORACLE = "mock";
  process.env.SDLC_TEST_RUNNER = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
}

function clearCalibrateEnv() {
  delete process.env.SDLC_ORACLE;
  delete process.env.SDLC_TEST_RUNNER;
  delete process.env.SDLC_MOCK_DIR;
  delete process.env.SDLC_EXECUTOR;
}

function latest(dir) {
  return JSON.parse(readFileSync(join(dir, "tests/results/old/latest.json"), "utf8"));
}

function rowFor(results, id) {
  return results.rows.find((r) => r.id === id);
}

test("calibrate sits in STAGES after bind-adapter, and in the rebuild profile but not greenfield", () => {
  assert.ok(STAGES.includes("calibrate"));
  assert.ok(STAGES.indexOf("calibrate") > STAGES.indexOf("bind-adapter"));
  assert.ok(PROFILES.rebuild.includes("calibrate"));
  assert.ok(!PROFILES.greenfield.includes("calibrate"));
});

test("sdlc run calibrate --target old: writes a dated result set and latest.json, and opens calibrate-old-1 over the failing criterion", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-first-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    const r = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    const results = latest(dir);
    assert.equal(results.target, "old");
    // The target's configured base URL, not the port `oracle up` happened to land on.
    assert.equal(results.base_url, "http://localhost:3100");
    assert.equal(rowFor(results, "R-1.1").result, "pass");
    assert.equal(rowFor(results, "R-1.2").result, "fail");
    assert.equal(rowFor(results, "R-1.3").result, "not-testable");
    // One row per accepted criterion of the domain, whether or not it has a test file.
    assert.equal(results.rows.length, 3);

    const today = new Date().toISOString().slice(0, 10);
    assert.ok(existsSync(join(dir, `tests/results/old/${today}.json`)), "the dated result set");

    assert.ok(r.proposal, "a failing row with no ruling opens a proposal");
    assert.equal(r.proposal.name, "calibrate-old-1");
    assert.equal(r.proposal.gate, "G1");
    const page = readFileSync(join(dir, ".sdlc/proposals/calibrate-old-1.md"), "utf8");
    assert.match(page, /R-1\.2/);
    assert.ok(!page.includes("R-1.1"), "a passing criterion is not asked about");
    assert.match(page, /Received: "submitted"/);
    assert.match(page, /defect-in-old <ID>/);
    assert.match(page, /spec-wrong <ID>/);
    assert.match(page, /test-wrong <ID>/);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("sdlc run calibrate --target old: the second run applies the ruling — a note kept, a statement edited, a test sent back — and asks nothing further", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-apply-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    const first = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(first.ok, true, JSON.stringify(first.messages));

    // The product-owner persona rules the calibration proposal, one condition per verb.
    const rulingMock = mkdtempSync(join(tmpdir(), "sdlc-calibrate-ruling-"));
    writeFileSync(join(rulingMock, "rule.json"), JSON.stringify({
      text: '```json\n' + JSON.stringify({
        verdict: "approve",
        rationale: "the status wording is the old system's own defect; the fee criterion's test asserts the wrong thing",
        conditions: [
          "defect-in-old R-1.2",
          "spec-wrong R-1.1: The system shall reject a permit application from an applicant under 19 years old.",
          "test-wrong R-1.3: the test asserts a fee amount the fee page never shows",
        ],
      }) + '\n```',
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = rulingMock;
    const ruled = await ruleByAgent(dir, "calibrate-old-1", { persona: "product-owner" });
    assert.equal(ruled.verdict, "approve");
    assert.deepEqual(ruled.unparsed, [], "every calibration verb parses");
    delete process.env.SDLC_EXECUTOR;
    process.env.SDLC_MOCK_DIR = MOCK_DIR;

    const second = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(second.ok, true, JSON.stringify(second.messages));

    const domainText = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    // defect-in-old: the criterion stands, with the ruling recorded on it.
    assert.match(domainText, /- note: calibrate \d{4}-\d{2}-\d{2}: the old target fails this; kept, the rebuild must pass it/);
    // spec-wrong: the statement is replaced and the version bumped, confidence untouched.
    assert.match(domainText, /### R-1\.1 · v2 · confirmed · recovered\nThe system shall reject a permit application from an applicant under 19 years old\./);
    const index = JSON.parse(readFileSync(join(dir, "spec/criteria-index.json"), "utf8"));
    assert.equal(index.criteria.find((c) => c.id === "R-1.1").version, 2);
    // test-wrong: back to derive-tests for that criterion, with the reason.
    const redo = parseYaml(readFileSync(join(dir, "tests/acceptance/redo.yaml"), "utf8"));
    assert.deepEqual(redo.redo, [{ id: "R-1.3", version: 1, why: "the test asserts a fee amount the fee page never shows" }]);

    const results = latest(dir);
    // The edited criterion's own test is now a version behind, which is what sends it
    // back through derive-tests --stale rather than being read as a real failure.
    assert.equal(rowFor(results, "R-1.1").result, "stale");
    assert.equal(rowFor(results, "R-1.2").result, "fail");
    assert.equal(rowFor(results, "R-1.2").ruled, "defect-in-old");

    const applied = parseYaml(readFileSync(join(dir, "tests/results/old/applied.yaml"), "utf8"));
    assert.deepEqual(applied.applied, ["calibrate-old-1"]);

    assert.ok(!second.proposal, "no failing row is left unruled, so nothing is asked");
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("sdlc run calibrate --target old: a third run applies nothing twice — the note stays single and the version stays put", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-twice-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    await runStage(dir, "calibrate", { target: "old" });

    const rulingMock = mkdtempSync(join(tmpdir(), "sdlc-calibrate-ruling-twice-"));
    writeFileSync(join(rulingMock, "rule.json"), JSON.stringify({
      text: '```json\n' + JSON.stringify({
        verdict: "approve",
        rationale: "the old system really does leave the status alone",
        conditions: ["defect-in-old R-1.2", "spec-wrong R-1.1: The system shall reject an applicant under 19."],
      }) + '\n```',
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = rulingMock;
    await ruleByAgent(dir, "calibrate-old-1", { persona: "product-owner" });
    delete process.env.SDLC_EXECUTOR;
    process.env.SDLC_MOCK_DIR = MOCK_DIR;

    const second = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(second.ok, true, JSON.stringify(second.messages));
    const third = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(third.ok, true, JSON.stringify(third.messages));

    const domainText = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.equal(domainText.match(/the old target fails this/g).length, 1, "the note is appended once");
    assert.match(domainText, /### R-1\.1 · v2 · /, "the version is bumped once");
    const applied = parseYaml(readFileSync(join(dir, "tests/results/old/applied.yaml"), "utf8"));
    assert.deepEqual(applied.applied, ["calibrate-old-1"]);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("sdlc run calibrate --target old: a result set with no failures opens nothing", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-green-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  const green = mockRunnerDir("green", [PASSING_ROW, { ...FAILING_ROW, result: "pass", tests: [{ title: "status", status: "passed" }] }]);
  calibrateEnv(green);
  try {
    const r = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.ok(!r.proposal);
    assert.ok(!existsSync(join(dir, ".sdlc/proposals/calibrate-old-1.md")));
    const results = latest(dir);
    assert.equal(results.rows.filter((row) => row.result === "fail").length, 0);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("a calibration proposal ruled with a ratification verb is re-prompted once, and recorded as unparsed if it comes back the same", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-grammar-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  const warnings = [];
  const origWarn = console.warn;
  try {
    const first = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(first.ok, true, JSON.stringify(first.messages));

    const rulingMock = mkdtempSync(join(tmpdir(), "sdlc-calibrate-grammar-mock-"));
    const reply = (conditions) => ({
      text: '```json\n' + JSON.stringify({ verdict: "approve", rationale: "the old target is right", conditions }) + '\n```',
    });
    // `confirm` is a ratification verb: it means nothing on a calibration ruling, and the
    // re-prompt asks for the calibration grammar instead. This persona repeats itself.
    writeFileSync(join(rulingMock, "rule.json"), JSON.stringify({
      sequence: [reply(["confirm R-1.2"]), reply(["confirm R-1.2"])],
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = rulingMock;
    console.warn = (...a) => warnings.push(a.join(" "));
    const ruled = await ruleByAgent(dir, "calibrate-old-1", { persona: "product-owner" });
    console.warn = origWarn;
    assert.equal(ruled.verdict, "approve");
    assert.deepEqual(ruled.unparsed, ["confirm R-1.2"]);
    assert.ok(warnings.some((w) => /still unreadable after one re-prompt/.test(w)), warnings.join(" | "));
    const gate = parseYaml(readFileSync(join(dir, ".sdlc/gates/calibrate-old-1.yaml"), "utf8"));
    assert.deepEqual(gate.unparsed_conditions, ["confirm R-1.2"]);
  } finally {
    console.warn = origWarn;
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("a calibration proposal ruled in the calibration grammar needs no re-prompt", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-grammar-ok-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    await runStage(dir, "calibrate", { target: "old" });
    const rulingMock = mkdtempSync(join(tmpdir(), "sdlc-calibrate-grammar-ok-mock-"));
    writeFileSync(join(rulingMock, "rule.json"), JSON.stringify({
      text: '```json\n' + JSON.stringify({
        verdict: "approve", rationale: "the old target is right", conditions: ["test-wrong R-1.2: the test signs in as the wrong persona"],
      }) + '\n```',
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = rulingMock;
    const ruled = await ruleByAgent(dir, "calibrate-old-1", { persona: "product-owner" });
    assert.deepEqual(ruled.unparsed, []);
    const gate = parseYaml(readFileSync(join(dir, ".sdlc/gates/calibrate-old-1.yaml"), "utf8"));
    assert.deepEqual(gate.conditions, ["test-wrong R-1.2: the test signs in as the wrong persona"]);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("sdlc run calibrate: a target that is neither the oracle nor in config.targets is refused before anything runs", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-target-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    const r = await runStage(dir, "calibrate", { target: "staging" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /staging/.test(m)), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.ok(!existsSync(join(dir, "tests/results/staging")));
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

// The last thing a calibrate run said about itself. `runStage` returns the run's outcome
// rather than its text, and the text is what the journal entry carries — so anything the
// stage reports in words (a domain file it refused to rewrite, a proposal it left alone)
// is read back from there.
function lastCalibrateText(dir) {
  const entries = readJournal(dir).filter((e) => e.stage === "calibrate");
  return entries.length ? entries[entries.length - 1].body : "";
}

// Rules the open calibration proposal as the product-owner persona, which is the only way
// a ruling carries conditions. Leaves the repository wherever the ruling left it: an
// approve merges to `main`, an escalation stays on the proposal branch.
async function ruleCalibration(dir, name, { verdict = "approve", rationale, conditions = [] }) {
  const mock = mkdtempSync(join(tmpdir(), "sdlc-calibrate-ruling-"));
  writeFileSync(join(mock, "rule.json"), JSON.stringify({
    text: '```json\n' + JSON.stringify({ verdict, rationale, conditions }) + '\n```',
  }));
  const prevMockDir = process.env.SDLC_MOCK_DIR;
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mock;
  try {
    return await ruleByAgent(dir, name, { persona: "product-owner" });
  } finally {
    delete process.env.SDLC_EXECUTOR;
    if (prevMockDir === undefined) delete process.env.SDLC_MOCK_DIR;
    else process.env.SDLC_MOCK_DIR = prevMockDir;
  }
}

// A second domain in the shape an agent writes one before anybody has ratified it: the
// bullets are not in the canonical order and no block declares its `state`, so a pass
// that read this file and wrote it back through the serialiser would visibly reformat it.
const FEES_RAW = `# fees

Recovered from the old application's fee tables. Nothing here is ratified yet.

### D-fees-1 · v1 · inferred · recovered
The system shall charge a flat intake fee of $50 on every submitted application.
- given: an application being submitted
- cites: src/fees.js:8
- then: a $50 intake fee is recorded against it
`;

function writeSecondDomain(dir, text) {
  writeFileSync(join(dir, "spec", "domains", "fees.md"), text);
  git(["add", "-A"], dir);
  git([...COMMIT, "recover the fees domain (test)"], dir);
}

test("calibrate leaves a domain file no ruling names exactly as it found it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-untouched-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  writeSecondDomain(dir, FEES_RAW);
  calibrateEnv(MOCK_DIR);
  try {
    await runStage(dir, "calibrate", { target: "old" });
    await ruleCalibration(dir, "calibrate-old-1", {
      rationale: "the old system really does leave the status alone",
      conditions: ["defect-in-old R-1.2"],
    });
    const second = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(second.ok, true, JSON.stringify(second.messages));

    // The ruling did land where it was aimed …
    assert.match(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), /the old target fails this/);
    // … and nowhere else. A domain awaiting ratification is not this stage's to reformat.
    assert.equal(readFileSync(join(dir, "spec/domains/fees.md"), "utf8"), FEES_RAW);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("calibrate refuses to rewrite a domain file that does not parse, and reports the conditions it was holding", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-unparseable-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  // A second block whose heading is missing its separators: the parser reports it and
  // recovers nothing from it, so serialising what it did understand would delete it.
  const feesBroken = `${FEES_RAW}
### D-fees-2 v1 confirmed recovered
The system shall waive the intake fee for a renewal.
- cites: src/fees.js:22
`;
  writeSecondDomain(dir, feesBroken);
  calibrateEnv(MOCK_DIR);
  try {
    await runStage(dir, "calibrate", { target: "old" });
    await ruleCalibration(dir, "calibrate-old-1", {
      rationale: "the old system leaves the status alone, and charges the flat fee it says it does",
      conditions: ["defect-in-old R-1.2", "defect-in-old D-fees-1"],
    });
    const second = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(second.ok, true, JSON.stringify(second.messages));

    assert.equal(readFileSync(join(dir, "spec/domains/fees.md"), "utf8"), feesBroken, "nothing was written over the malformed file");
    assert.match(lastCalibrateText(dir), /spec\/domains\/fees\.md does not parse; 1 condition\(s\) not applied/);
    // The condition aimed at the other domain still landed: one unreadable file does not
    // block the rest of the same ruling.
    assert.match(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), /the old target fails this/);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("a second calibrate run on the same day writes a second dated result set rather than overwriting the first", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-dated-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    await runStage(dir, "calibrate", { target: "old" });
    git(["checkout", "-q", "main"], dir);
    const second = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(second.ok, true, JSON.stringify(second.messages));

    const today = new Date().toISOString().slice(0, 10);
    assert.ok(existsSync(join(dir, `tests/results/old/${today}.json`)), "the first run's record");
    assert.ok(existsSync(join(dir, `tests/results/old/${today}-2.json`)), "the second run's record");
    assert.ok(existsSync(join(dir, "tests/results/old/latest.json")), "latest.json is still overwritten");
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("a calibration proposal still open stops a second one being opened, and the run says so", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-open-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    const first = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(first.proposal.name, "calibrate-old-1");
    // `propose` leaves the caller on the proposal branch; a run starts from main.
    git(["checkout", "-q", "main"], dir);

    const second = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(second.ok, true, JSON.stringify(second.messages));
    assert.ok(!second.proposal, "the unanswered question is not asked a second time");
    assert.ok(!existsSync(join(dir, ".sdlc/proposals/calibrate-old-2.md")));
    // The results are still written: the run is a record of what the target does today,
    // whether or not anybody has answered yesterday's question about it.
    assert.equal(rowFor(latest(dir), "R-1.2").result, "fail");
    assert.match(lastCalibrateText(dir), /proposal\/calibrate-old-1 is still open/);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("an escalated calibration ruling leaves the question open rather than counting as an answer", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-escalated-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    await runStage(dir, "calibrate", { target: "old" });
    const ruled = await ruleCalibration(dir, "calibrate-old-1", {
      verdict: "escalate",
      rationale: "whether the old status wording is a defect is the tech lead's call, not mine",
    });
    assert.equal(ruled.escalated, true);
    // An escalation is committed on the proposal branch and nowhere else.
    git(["checkout", "-q", "main"], dir);

    const second = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(second.ok, true, JSON.stringify(second.messages));
    assert.ok(!second.proposal, "a question waiting on a person is not re-asked as calibrate-old-2");
    assert.ok(!existsSync(join(dir, ".sdlc/proposals/calibrate-old-2.md")));
    assert.match(lastCalibrateText(dir), /proposal\/calibrate-old-1 is still open/);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("derive-tests --stale takes the ids it has just derived off redo.yaml", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-redo-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    await runStage(dir, "calibrate", { target: "old" });
    await ruleCalibration(dir, "calibrate-old-1", {
      rationale: "the status wording is the old system's own defect; the fee criterion's test asserts the wrong thing",
      conditions: [
        "defect-in-old R-1.2",
        "spec-wrong R-1.1: The system shall reject a permit application from an applicant under 19 years old.",
        "test-wrong R-1.3: the test asserts a fee amount the fee page never shows",
      ],
    });
    const second = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(second.ok, true, JSON.stringify(second.messages));
    const asked = parseYaml(readFileSync(join(dir, "tests/acceptance/redo.yaml"), "utf8"));
    assert.deepEqual(asked.redo.map((r) => r.id), ["R-1.3"]);
    clearCalibrateEnv();

    // Two criteria go back through the blind stage for two different reasons: R-1.1
    // because `spec-wrong` moved it to v2 and left its test behind, R-1.3 because
    // `test-wrong` put it on redo.yaml. The agent rewrites R-1.1's test and leaves R-1.3
    // not-testable, the surface still exposing no fee amount.
    const staleMock = mkdtempSync(join(tmpdir(), "sdlc-calibrate-redo-mock-"));
    writeFileSync(join(staleMock, "derive-tests.json"), JSON.stringify({
      text: "Rewrote R-1.1 against the corrected statement. R-1.3 still has no observable fee amount, so its not-testable entry stands.",
      files: {
        "tests/acceptance/applications/R-1.1.spec.ts":
          "// criterion: @R-1.1 v2\n// provenance: blind, spec@000000000000000000000000000000000000000b, derived 2026-09-07\n"
          + 'import { test, expect, persona } from "../../fixtures";\n\n'
          + 'test("The system shall reject a permit application from an applicant under 19 years old.", async ({ surface }) => {\n'
          + "  await surface.signIn(persona.applicant);\n"
          + "  await surface.applicationsNew.submit({ age: 17 });\n"
          + '  expect(await surface.applicationsNew.status()).toBe("rejected");\n});\n',
      },
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = staleMock;
    const derived = await runStage(dir, "derive-tests", { domain: "applications", stale: true });
    assert.equal(derived.ok, true, JSON.stringify(derived.messages));

    const after = parseYaml(readFileSync(join(dir, "tests/acceptance/redo.yaml"), "utf8"));
    assert.deepEqual(after.redo, [], "the request has been answered, so it is off the list");
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

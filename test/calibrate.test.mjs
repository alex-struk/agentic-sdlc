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
// standing in for what a real `sdlc oracle up` would have written.
function writeOldOracleLocal(dir) {
  writeLocal(dir, "old", {
    target: "old",
    base_url: "http://localhost:3100",
    mail_api: "http://localhost:8025",
    ports: { app: 3100, db: 5500, mail_api: 8025 },
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
    assert.deepEqual(redo.redo, [{ id: "R-1.3", why: "the test asserts a fee amount the fee page never shows" }]);

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

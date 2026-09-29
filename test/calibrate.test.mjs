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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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

// Both `bind-adapter` and `calibrate` refuse a `sandbox-idp` target with nothing in
// `SDLC_SANDBOX_PASSWORD`, and this fixture's oracle uses that identity. Only the
// presence of the variable is checked here — the mock executor spawns no session and the
// mock test runner opens no browser, so the value itself never reaches anything.
process.env.SDLC_SANDBOX_PASSWORD = "set-for-tests";

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
// setup makes as a human: the calibration rulings this file is about are the persona's,
// and its brief is what holds the grammar they are written in.
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

test("sdlc run calibrate --target old: writes a dated result set and latest.json, has the reviewer sort the failure, then opens calibrate-old-1 over it", async () => {
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
    // Sorted first. Whether the project's own adapter caused a failure is a technical
    // question for the reviewer, and the product owner is not asked it.
    assert.equal(r.proposal.name, "calibrate-triage-old-1");
    assert.equal(r.proposal.gate, "G3");
    const triagePage = git(["show", `${r.proposal.branch}:.sdlc/proposals/calibrate-triage-old-1.md`], dir);
    assert.match(triagePage, /R-1\.2/);
    assert.ok(!triagePage.includes("R-1.1"), "a passing criterion is not asked about");
    assert.match(triagePage, /Received: "submitted"/);
    assert.match(triagePage, /adapter-wrong <ID>/);
    assert.match(triagePage, /product-question <ID>/);
    assert.ok(!triagePage.includes("defect-in-old <ID>"), "the reviewer is not asked a product question");

    const sorted = await passToProductOwner(dir, ["R-1.2"]);
    assert.equal(sorted.proposal.name, "calibrate-old-1");
    assert.equal(sorted.proposal.gate, "G1");
    assert.ok(!existsSync(join(dir, `tests/results/old/${today}-2.json`)), "applying a ruling runs no suite, so it writes no second dated record");
    const page = git(["show", `${sorted.proposal.branch}:.sdlc/proposals/calibrate-old-1.md`], dir);
    assert.match(page, /R-1\.2/);
    assert.ok(!page.includes("R-1.1"), "a passing criterion is not asked about");
    assert.match(page, /Received: "submitted"/);
    assert.match(page, /defect-in-old <ID>/);
    assert.match(page, /spec-wrong <ID>/);
    assert.match(page, /test-wrong <ID>/);
    assert.ok(!page.includes("adapter-wrong"), "the product owner is not asked about the adapter");
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
    await passToProductOwner(dir, ["R-1.2"]);

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
    assert.deepEqual(applied.applied, ["calibrate-triage-old-1", "calibrate-old-1"]);

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
    await passToProductOwner(dir, ["R-1.2"]);

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
    assert.deepEqual(applied.applied, ["calibrate-triage-old-1", "calibrate-old-1"]);
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

// An unbound row reaches neither the reviewer nor the product owner, so the calibration that
// finds one files it for the binding run, with the adapter's own reason and the adapter it was
// found under, and closes it once a later calibration finds the binding reaches the test.
test("sdlc run calibrate --target old: an unbound row is filed for bind-adapter with the adapter's reason, and closed once it passes", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-unbound-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  const unbound = { ...FAILING_ROW, result: "unbound", tests: [{ title: "status", status: "failed", error: 'Error: unbound: application.status — no field labelled "Status"' }] };
  calibrateEnv(mockRunnerDir("unbound", [PASSING_ROW, unbound]));
  try {
    const r = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.ok(!r.proposal, "an unbound row is asked of nobody");
    const tree = git(["rev-parse", "HEAD:tests/adapters/old"], dir);
    assert.equal(rowFor(latest(dir), "R-1.2").adapter, tree, "a row records the adapter it was found under");
    const [entry] = parseYaml(git(["show", "main:tests/adapters/rebind.yaml"], dir)).rebind;
    assert.deepEqual([entry.id, entry.target, entry.found, entry.adapter, entry.by], ["R-1.2", "old", "unbound", tree, "runner:calibrate"]);
    assert.equal(entry.why, 'unbound: application.status — no field labelled "Status"');
    assert.equal(entry.closed, undefined);

    calibrateEnv(mockRunnerDir("bound", [PASSING_ROW, { ...FAILING_ROW, result: "pass", tests: [{ title: "status", status: "passed" }] }]));
    const again = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(again.ok, true, JSON.stringify(again.messages));
    const [settled] = parseYaml(git(["show", "main:tests/adapters/rebind.yaml"], dir)).rebind;
    assert.equal(settled.closed.outcome, "met");
    assert.match(settled.closed.why, /the calibration row is pass/);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

// A missing test whose test now exists is owed a run, and the calibration that runs it closes
// the item with the row it ran as the evidence.
test("sdlc run calibrate --target old: a missing test whose test ran is closed, with the row as its evidence", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-missing-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  const owedPath = join(dir, ".sdlc/owed.yaml");
  const owed = parseYaml(readFileSync(owedPath, "utf8"));
  assert.deepEqual(owed.owed.filter((e) => e.kind === "missing-test").map((e) => [e.item, e.stage]), [["R-1.3", "contract"]],
    "approving the derivation opened the record's item");
  owed.owed.push({ kind: "missing-test", item: "R-1.2", id: "R-1.2", version: 1, domain: "applications", stage: "calibrate", target: "old",
    why: "a test for v1 exists and has not run", by: "runner", at: "2026-01-01T00:00:00.000Z" });
  writeFileSync(owedPath, stringifyYaml(owed));
  git(["add", "-A"], dir);
  git([...COMMIT, "an item owed a run (test)"], dir);
  const green = mockRunnerDir("missing", [PASSING_ROW, { ...FAILING_ROW, result: "pass", tests: [{ title: "status", status: "passed" }] }]);
  calibrateEnv(green);
  try {
    const r = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    const after = parseYaml(git(["show", "main:.sdlc/owed.yaml"], dir)).owed.filter((e) => e.kind === "missing-test");
    const ran = after.find((e) => e.item === "R-1.2");
    assert.equal(ran.closed.outcome, "met");
    assert.equal(ran.closed.why, "tests/results/old/latest.json: R-1.2 v1 pass");
    assert.equal(after.find((e) => e.item === "R-1.3").closed, undefined, "a criterion still recorded untestable stays owed");
    assert.equal(git(["status", "--porcelain"], dir), "");
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
    await passToProductOwner(dir, ["R-1.2"]);

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
    await passToProductOwner(dir, ["R-1.2"]);
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

// Sorts the open triage proposal as the reviewer persona, passing every named failure on to
// the product owner, then applies that sorting with `--skip-suite`, which is what opens the
// product owner's own proposal. Leaves the repository on `main`.
async function passToProductOwner(dir, ids, { triage = "calibrate-triage-old-1" } = {}) {
  const mock = mkdtempSync(join(tmpdir(), "sdlc-calibrate-triage-"));
  writeFileSync(join(mock, "rule.json"), JSON.stringify({
    text: '```json\n' + JSON.stringify({
      verdict: "approve",
      rationale: "nothing in the evidence points at the adapter",
      conditions: ids.map((id) => `product-question ${id}`),
    }) + '\n```',
  }));
  const prevMockDir = process.env.SDLC_MOCK_DIR;
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mock;
  try {
    const ruled = await ruleByAgent(dir, triage, { persona: "reviewer" });
    if (ruled.verdict !== "approve") throw new Error(`triage was not approved: ${JSON.stringify(ruled)}`);
  } finally {
    delete process.env.SDLC_EXECUTOR;
    if (prevMockDir === undefined) delete process.env.SDLC_MOCK_DIR;
    else process.env.SDLC_MOCK_DIR = prevMockDir;
  }
  git(["checkout", "-q", "main"], dir);
  const sorted = await runStage(dir, "calibrate", { target: "old", skipSuite: true });
  if (!sorted.ok) throw new Error(`calibrate --skip-suite failed: ${JSON.stringify(sorted.messages)}`);
  return sorted;
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
    await passToProductOwner(dir, ["R-1.2"]);
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
    await passToProductOwner(dir, ["R-1.2"]);
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

test("calibrate stays runnable when every ruling is held — a domain that never parses does not wedge the stage", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-all-held-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  // Corrupts the *only* domain the ruling below can name, after the fixture that needs
  // it parseable (ratify, contract, derive-tests, bind-adapter) has already run. Every
  // condition this ruling carries is therefore held on every later run, forever — the
  // shape that used to leave the stage dead once `applied.yaml` had already recorded a
  // first attempt with nothing new to say.
  const applicationsBroken = `${DOMAIN_TEXT}
### D-applications-4 v1 confirmed recovered
The system shall notify the applicant when a permit is issued.
- cites: src/routes.js:20
`;
  writeFileSync(join(dir, "spec", "domains", "applications.md"), applicationsBroken);
  git(["add", "-A"], dir);
  git([...COMMIT, "break the applications domain (test)"], dir);
  calibrateEnv(MOCK_DIR);
  try {
    await runStage(dir, "calibrate", { target: "old" });
    await passToProductOwner(dir, ["R-1.2"]);
    // One condition per gate, and each names a different criterion, so the two gates
    // never share a condition line verbatim — `applyCalibrateGates` credits a held
    // condition's *first* owner when two gates carry the identical text, which a test
    // naming the same criterion twice the same way would trip over for a reason that has
    // nothing to do with the bug this reproduces.
    await ruleCalibration(dir, "calibrate-old-1", {
      rationale: "the old system leaves the status alone",
      conditions: ["defect-in-old R-1.2"],
    });

    // First processing of the held gate: `applied.yaml` does not exist yet, so writing
    // it — even recording nothing applied — is a real change and this run commits fine.
    // Since nothing was actually resolved, the same failures are still unruled once the
    // suite finishes, so this run also opens a fresh question over them.
    const second = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(second.ok, true, JSON.stringify(second.messages));
    assert.match(lastCalibrateText(dir), /spec\/domains\/applications\.md does not parse; 1 condition\(s\) not applied/);
    assert.equal(second.proposal?.name, "calibrate-old-2");

    // Approved the same way, and held the same way: the domain still does not parse.
    await ruleCalibration(dir, "calibrate-old-2", {
      rationale: "the age check criterion is worded wrong",
      conditions: ["spec-wrong R-1.1: The system shall reject an applicant under 19."],
    });

    // Second processing of a held gate (now two of them, calibrate-old-1 and -2, both
    // still entirely held): neither has ever recorded anything real, so `applied.yaml`
    // re-serialises to the exact text already on disk. This is the run that used to
    // throw "nothing to commit" — the domain file was never touched, so the only path
    // calibrate had staged for its own commit was `applied.yaml`, byte-for-byte identical
    // to what `git` already has.
    const third = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(third.ok, true, JSON.stringify(third.messages));
    assert.match(lastCalibrateText(dir), /spec\/domains\/applications\.md does not parse; 2 condition\(s\) not applied/);

    // No product ruling was ever actually applied, so nothing on `main` claims one was. The
    // reviewer's sorting touches no domain file, so it is the one thing recorded.
    assert.equal(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), applicationsBroken, "the malformed file was never rewritten");
    const applied = parseYaml(readFileSync(join(dir, "tests/results/old/applied.yaml"), "utf8"));
    assert.deepEqual(applied.applied, ["calibrate-triage-old-1"]);
    assert.deepEqual(applied.rulings.map((x) => `${x.id} ${x.verb}`), ["R-1.2 product-question"]);
    const subjects = git(["log", "--pretty=%s"], dir).split("\n");
    assert.ok(subjects.every((s) => !/apply rulings calibrate-old-[12]\b/.test(s)), `a commit claimed rulings were applied: ${JSON.stringify(subjects)}`);
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
    assert.equal(first.proposal.name, "calibrate-triage-old-1");
    // `propose` leaves the caller on the proposal branch; a run starts from main.
    git(["checkout", "-q", "main"], dir);

    const second = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(second.ok, true, JSON.stringify(second.messages));
    assert.ok(!second.proposal, "the unanswered question is not asked a second time");
    assert.ok(!existsSync(join(dir, ".sdlc/proposals/calibrate-triage-old-2.md")));
    // The results are still written: the run is a record of what the target does today,
    // whether or not anybody has answered yesterday's question about it.
    assert.equal(rowFor(latest(dir), "R-1.2").result, "fail");
    assert.match(lastCalibrateText(dir), /proposal\/calibrate-triage-old-1 is still open/);
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
    await passToProductOwner(dir, ["R-1.2"]);
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

test("derive-tests --stale closes the redo entries it has just answered", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-redo-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    await runStage(dir, "calibrate", { target: "old" });
    await passToProductOwner(dir, ["R-1.2"]);
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

    const after = parseYaml(git(["show", `${derived.proposal.branch}:tests/acceptance/redo.yaml`], dir));
    assert.deepEqual(after.redo.filter((r) => !r.closed), [], "the request has been answered, so nothing is owed");
    assert.deepEqual(after.redo.map((r) => [r.id, r.closed?.outcome]), [["R-1.3", "met"]], "and the entry stays on file with its closure");
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("a criterion sent back to derive-tests more often than policy allows is escalated with its re-derivation", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-redo-limit-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    await runStage(dir, "calibrate", { target: "old" });
    await passToProductOwner(dir, ["R-1.2"]);
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

    // Two earlier sends of the same criterion, each answered by a re-derivation that did not
    // settle it.
    const earlier = [1, 2].map((n) => ({ id: "R-1.3", version: 1, why: `earlier send ${n}`, closed: { outcome: "met", why: "derived again", at: `2026-01-0${n}T00:00:00.000Z` } }));
    writeFileSync(join(dir, "tests/acceptance/redo.yaml"), stringifyYaml({ redo: [...earlier, ...asked.redo] }));
    git(["add", "-A"], dir);
    git([...COMMIT, "two earlier sends (test)"], dir);

    // Two criteria go back through the blind stage for two different reasons: R-1.1
    // because `spec-wrong` moved it to v2 and left its test behind, R-1.3 because
    // `test-wrong` put it on redo.yaml. The agent rewrites R-1.1's test and leaves R-1.3
    // not-testable, the surface still exposing no fee amount.
    const staleMock = mkdtempSync(join(tmpdir(), "sdlc-calibrate-redo-limit-mock-"));
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

    // Escalated by the runner to G3's escalation target, with every reason it was sent back.
    assert.equal(derived.proposal.escalatedTo, "tech-lead");
    const gate = parseYaml(git(["show", `${derived.proposal.branch}:.sdlc/gates/${derived.proposal.name}.yaml`], dir));
    assert.deepEqual([gate.verdict, gate.by, gate.held_by, gate.escalate_to], ["escalated", "runner:derive-tests", "runner", "tech-lead"]);
    assert.match(gate.rationale, /R-1\.3: sent to derive-tests 3 times, past the limit of 2 that policy\.loops\.redo sets/);
    assert.match(gate.rationale, /the test asserts a fee amount the fee page never shows/);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

// --- the sandbox password a sandbox-idp target signs in with ---

test("sdlc run calibrate: a sandbox-idp target with no sandbox password is refused before the suite runs", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-nopw-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  const prevPw = process.env.SDLC_SANDBOX_PASSWORD;
  delete process.env.SDLC_SANDBOX_PASSWORD;
  calibrateEnv(MOCK_DIR);
  try {
    const r = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m === "export SDLC_SANDBOX_PASSWORD before calibrating old"), r.messages.join(" | "));
    assert.ok(!existsSync(join(dir, "tests/results/old/latest.json")), "no suite ran, so no result set");
  } finally {
    process.env.SDLC_SANDBOX_PASSWORD = prevPw;
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

// --- a suite run that throws after the rulings have been applied ---

test("sdlc run calibrate: a suite that throws after a ruling was applied leaves a clean tree, with the rulings committed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-throw-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    const first = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(first.ok, true, JSON.stringify(first.messages));

    await passToProductOwner(dir, ["R-1.2"]);
    const rulingMock = mkdtempSync(join(tmpdir(), "sdlc-calibrate-throw-ruling-"));
    writeFileSync(join(rulingMock, "rule.json"), JSON.stringify({
      text: '```json\n' + JSON.stringify({
        verdict: "approve",
        rationale: "the criterion overstates what the old system does",
        conditions: ["spec-wrong R-1.1: The system shall reject a permit application from an applicant under 19 years old."],
      }) + '\n```',
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = rulingMock;
    await ruleByAgent(dir, "calibrate-old-1", { persona: "product-owner" });
    delete process.env.SDLC_EXECUTOR;

    // A runner that fails the way a real one can — no browser, no registry, the target
    // gone mid-suite — after the ruling above has already rewritten the spec.
    const throwing = mkdtempSync(join(tmpdir(), "sdlc-calibrate-throw-runner-"));
    writeFileSync(join(throwing, "calibrate.json"), JSON.stringify({ throw: "playwright produced no report" }));
    process.env.SDLC_MOCK_DIR = throwing;

    await assert.rejects(() => runStage(dir, "calibrate", { target: "old" }), /playwright produced no report/);

    // Nothing is left dirty for the next run to trip over, and the applied ruling is on
    // main under its own commit rather than lost.
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.equal(git(["log", "-1", "--pretty=%s"], dir), "stage(calibrate): apply rulings calibrate-old-1");
    const committed = git(["show", "--name-only", "--pretty=format:", "HEAD"], dir).split("\n").filter(Boolean).sort();
    assert.deepEqual(committed, ["spec/criteria-index.json", "spec/domains/applications.md", "spec/spec.md", "tests/results/old/applied.yaml"]);
    assert.match(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), /### R-1\.1 · v2 · /);

    // The next run reads applied.yaml and applies nothing a second time.
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    const after = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(after.ok, true, JSON.stringify(after.messages));
    assert.equal(readFileSync(join(dir, "spec/domains/applications.md"), "utf8").match(/### R-1\.1 · v2 · /g).length, 1);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

// --- how many failures one proposal page carries ---

test("sdlc run calibrate: a page of failures is capped at 40, and says how many more there are", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-cap-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  // 45 failing rows: the three the fixture's own criteria account for, plus enough
  // synthetic ones to run past the cap. A calibration against an application nobody has
  // rebuilt yet fails on this scale.
  const many = [PASSING_ROW, FAILING_ROW];
  for (let i = 1; i <= 44; i++) {
    many.push({
      id: `R-2.${i}`, version: 1, domain: "applications", file: `tests/acceptance/applications/R-2.${i}.spec.ts`,
      result: "fail",
      tests: [{ title: `criterion R-2.${i}`, status: "failed", error: "expect(received).toBe(expected)" }],
    });
  }
  calibrateEnv(mockRunnerDir("cap", many));
  try {
    const r = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.equal(r.proposal.name, "calibrate-triage-old-1");
    const page = git(["show", `${r.proposal.branch}:.sdlc/proposals/calibrate-triage-old-1.md`], dir);
    assert.match(page, /^45 criterion\(s\) failed against the \*\*old\*\* target at .*, and nobody has sorted them yet\.$/m);
    assert.match(page, /^The 40 below are the ones to sort now; the remaining 5 come back on the next run\.$/m);
    assert.equal((page.match(/^### /gm) ?? []).length, 40, "exactly 40 criteria are laid out");
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

// --- a test-wrong ruling stops answering once the test has been written again ---

test("after derive-tests --stale answers a test-wrong ruling, the same failure opens a fresh question", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-testwrong-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    const first = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(first.ok, true, JSON.stringify(first.messages));
    assert.equal(first.proposal.name, "calibrate-triage-old-1");
    await passToProductOwner(dir, ["R-1.2"]);

    // The product owner says the criterion is right and the test is not.
    const rulingMock = mkdtempSync(join(tmpdir(), "sdlc-calibrate-testwrong-ruling-"));
    writeFileSync(join(rulingMock, "rule.json"), JSON.stringify({
      text: '```json\n' + JSON.stringify({
        verdict: "approve",
        rationale: "the status wording the test asserts is not what the criterion states",
        conditions: ["test-wrong R-1.2: the test asserts a status string the criterion never names"],
      }) + '\n```',
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = rulingMock;
    await ruleByAgent(dir, "calibrate-old-1", { persona: "product-owner" });
    delete process.env.SDLC_EXECUTOR;
    process.env.SDLC_MOCK_DIR = MOCK_DIR;

    // The ruling is applied: the id goes on the redo list and the row reads as answered.
    const second = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(second.ok, true, JSON.stringify(second.messages));
    assert.equal(rowFor(latest(dir), "R-1.2").ruled, "test-wrong");
    assert.deepEqual(parseYaml(readFileSync(join(dir, "tests/acceptance/redo.yaml"), "utf8")).redo.map((e) => e.id), ["R-1.2"]);
    assert.ok(!second.proposal, "the failure carries a ruling, so nothing further is asked");

    // derive-tests writes that test again, which answers the request.
    process.env.SDLC_EXECUTOR = "mock";
    const derived = await runStage(dir, "derive-tests", { domain: "applications", stale: true });
    assert.equal(derived.ok, true, JSON.stringify(derived.messages));
    delete process.env.SDLC_EXECUTOR;
    rule(dir, derived.proposal.name, "approve", { by: "tech-lead" });

    const applied = parseYaml(readFileSync(join(dir, "tests/results/old/applied.yaml"), "utf8"));
    // The gate stays recorded, so the ruling is never applied to the spec twice…
    assert.deepEqual(applied.applied, ["calibrate-triage-old-1", "calibrate-old-1"]);
    // …but the per-criterion record is gone, so the row can be asked about again.
    assert.deepEqual(applied.rulings.filter((x) => x.id === "R-1.2"), []);
    assert.deepEqual(parseYaml(readFileSync(join(dir, "tests/acceptance/redo.yaml"), "utf8")).redo.filter((e) => !e.closed), []);

    // The freshly written test still fails against the old target, and that is a new
    // question rather than one already answered. It is sorted afresh, not sent straight to
    // the product owner: a test written again can fail for a reason the adapter owns.
    const third = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(third.ok, true, JSON.stringify(third.messages));
    assert.equal(rowFor(latest(dir), "R-1.2").ruled, undefined);
    assert.equal(rowFor(latest(dir), "R-1.2").triage, undefined);
    assert.ok(third.proposal, "the same failure is asked about again");
    assert.equal(third.proposal.name, "calibrate-triage-old-2");
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

// A criterion the spec has corrected — accepted, but superseded by a later one — carries no
// test on purpose: derive-tests excludes it, because a test for it could only ever
// contradict its replacement. Calibration read "accepted" without that exclusion and
// demanded a row for each, which failed every calibration of a spec that had ever corrected
// itself. On the first project to reach this stage that was 38 criteria.
test("calibrate expects no row for a criterion another has superseded", async (t) => {
  const { calibrateExpectedIds } = await import("../src/stages/calibrate.mjs");
  const dir = mkdtempSync(join(tmpdir(), "sdlc-calibrate-superseded-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "spec"), { recursive: true });
  mkdirSync(join(dir, "tests", "acceptance", "billing"), { recursive: true });
  writeFileSync(join(dir, "tests", "acceptance", "billing", "R-1.1.spec.ts"), "// a test\n");
  writeFileSync(join(dir, "spec", "criteria-index.json"), JSON.stringify({
    generated_from: "abc123",
    criteria: [
      { id: "R-1.1", domain: "billing", state: "accepted" },
      { id: "R-1.2", domain: "billing", state: "accepted", supersededBy: "R-1.3" },
      { id: "R-1.3", domain: "billing", state: "accepted" },
      { id: "R-1.4", domain: "billing", state: "proposed" },
    ],
  }));
  assert.deepEqual(calibrateExpectedIds(dir), ["R-1.1", "R-1.3"]);
});

// A whole-suite calibration takes hours on a real project, which makes checking one fix an
// afternoon. Scoped to a domain it is minutes — but only if the rows it produces are laid
// over the ones already on file, or the result set would account for one domain and
// silently omit the rest.
test("a scoped calibration lays its rows over the full set rather than replacing it", async (t) => {
  const { sortRows } = await import("../src/testrun/playwright.mjs");
  const previous = [
    { id: "R-1.1", domain: "billing", result: "fail" },
    { id: "R-2.1", domain: "users", result: "pass" },
    { id: "R-2.2", domain: "users", result: "fail" },
  ];
  const fresh = [{ id: "R-2.2", domain: "users", result: "pass" }];
  const byId = new Map(previous.map((r) => [r.id, r]));
  for (const row of fresh) byId.set(row.id, row);
  const merged = sortRows([...byId.values()]);
  assert.equal(merged.length, 3, "no row is lost");
  assert.equal(merged.find((r) => r.id === "R-2.2").result, "pass", "the re-run row is replaced");
  assert.equal(merged.find((r) => r.id === "R-1.1").result, "fail", "another domain is untouched");
});

test("the suite filter names one domain's directory, anchored so a prefix cannot drag another in", async () => {
  const calls = [];
  const { runSuite } = await import("../src/testrun/playwright.mjs");
  const dir = mkdtempSync(join(tmpdir(), "sdlc-scoped-"));
  mkdirSync(join(dir, "tests", "acceptance"), { recursive: true });
  // The target has an adapter: a target with none is answered without a run at all, and
  // this test is about the arguments a real run is given.
  mkdirSync(join(dir, "tests", "adapters", "old"), { recursive: true });
  writeFileSync(join(dir, "tests", "adapters", "old", "index.ts"), "export const surface = {};\n");
  try {
    runSuite({
      projectDir: dir, target: "old", baseUrl: "http://x", mailApi: "",
      domain: "users",
      exec: (cmd, args) => { calls.push(args); return { stdout: "", stderr: "" }; },
    });
  } catch {
    // The run throws for want of a report; the arguments it was called with are the point.
  }
  const testArgs = calls.find((a) => a.includes("test")) ?? [];
  assert.ok(testArgs.includes("acceptance/users/"), JSON.stringify(testArgs));
});

// --- a failure the adapter caused never reaches the product owner ---

test("a failure the reviewer blames on the adapter never reaches the product owner, and is sorted afresh once the adapter changes", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-adapter-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    const first = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(first.proposal.name, "calibrate-triage-old-1");

    const mock = mkdtempSync(join(tmpdir(), "sdlc-calibrate-adapter-ruling-"));
    writeFileSync(join(mock, "rule.json"), JSON.stringify({
      text: '```json\n' + JSON.stringify({
        verdict: "approve",
        rationale: "the adapter reads the status off the page title",
        conditions: ["adapter-wrong R-1.2: reads the status from the page title rather than the status field"],
      }) + '\n```',
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mock;
    await ruleByAgent(dir, "calibrate-triage-old-1", { persona: "reviewer" });
    delete process.env.SDLC_EXECUTOR;
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    git(["checkout", "-q", "main"], dir);

    const sorted = await runStage(dir, "calibrate", { target: "old", skipSuite: true });
    assert.equal(sorted.ok, true, JSON.stringify(sorted.messages));
    assert.ok(!sorted.proposal, "nothing is put to the product owner");
    assert.ok(!existsSync(join(dir, ".sdlc/proposals/calibrate-old-1.md")));
    assert.equal(rowFor(latest(dir), "R-1.2").ruled, "adapter-wrong");
    const rebind = parseYaml(readFileSync(join(dir, "tests/adapters/rebind.yaml"), "utf8")).rebind;
    assert.deepEqual(rebind.map((e) => `${e.target} ${e.id}`), ["old R-1.2"]);

    // The binding is rewritten. A verdict about the old adapter says nothing about the new
    // one, so the row is a question again and the rebind entry is closed.
    const adapterPath = join(dir, "tests/adapters/old/index.ts");
    writeFileSync(adapterPath, `${readFileSync(adapterPath, "utf8")}\n// rebound\n`);
    git(["add", "-A"], dir);
    git([...COMMIT, "rebind the old adapter (test)"], dir);

    const again = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(again.ok, true, JSON.stringify(again.messages));
    assert.equal(rowFor(latest(dir), "R-1.2").ruled, undefined, "the verdict lapsed with the adapter it was about");
    assert.equal(again.proposal?.name, "calibrate-triage-old-2", "the same failure is sorted afresh");
    const closed = parseYaml(readFileSync(join(dir, "tests/adapters/rebind.yaml"), "utf8")).rebind;
    assert.deepEqual(closed.filter((e) => !e.closed), []);
    assert.match(closed[0].closed.why, /tests\/adapters\/old has changed/);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("calibrate --skip-suite refuses to run before there are results to rule over", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-skip-none-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    const r = await runStage(dir, "calibrate", { target: "old", skipSuite: true });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /no results on file/.test(m)), r.messages.join(" | "));
    assert.ok(!existsSync(join(dir, "tests/results/old/latest.json")));
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

// --- a target that was not usable (spec §7.1, env-defect) ---

const ELSEWHERE = `/${"home"}/someone`;

// What a test's own reset reports when the target could not be put back to its seed, the way
// the harness's fixture words it — carrying a local path, as the real message does.
function resetFailedRow(base) {
  return {
    ...base,
    result: "fail",
    tests: [{
      title: base.tests[0].title,
      status: "failed",
      error: `Error: could not reset the target to its seed before this test: Command failed: node ${ELSEWHERE}/agentic-sdlc/bin/sdlc.mjs oracle reseed --target old --instance 1\npsql: error: FATAL:  sorry, too many clients already`,
    }],
  };
}

function runBranches(dir, prefix) {
  return git(["for-each-ref", "--format=%(refname:short)", `refs/heads/proposal/${prefix}*`], dir).split("\n").filter(Boolean);
}

test("a calibration whose target could not be reset halts as an environment fault: no results, no question, the evidence reported", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-env-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(mockRunnerDir("env", [resetFailedRow(PASSING_ROW), resetFailedRow(FAILING_ROW)]));
  try {
    await assert.rejects(() => runStage(dir, "calibrate", { target: "old" }), (e) => {
      assert.match(e.message, /environment/);
      assert.match(e.message, /2 of 2/);
      assert.match(e.message, /could not reset the target to its seed/);
      assert.match(e.message, /R-1\.1/);
      assert.ok(!e.message.includes(ELSEWHERE), "a local path is not quoted");
      return true;
    });
    // Nothing is recorded against a criterion: the rows say what the machine did, not the
    // application, and a result file carrying them would be read as the application's.
    assert.ok(!existsSync(join(dir, "tests/results/old/latest.json")));
    assert.deepEqual(runBranches(dir, "calibrate"), [], "no one is asked to sort failures that are the machine's");
    // The halt is on the record, committed, and the tree is left clean for the next run.
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /^run\(calibrate\): halted/);
    const day = new Date().toISOString().slice(0, 10);
    const runs = readFileSync(join(dir, `.sdlc/runs/${day}.md`), "utf8");
    assert.match(runs, /calibrate old: halted, environment fault/);
    assert.ok(!runs.includes(ELSEWHERE));
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("calibrate --skip-suite over results from a run whose target was not usable halts rather than asking about them", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-env-skip-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(mockRunnerDir("env-skip", [PASSING_ROW, FAILING_ROW]));
  try {
    const first = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(first.ok, true, JSON.stringify(first.messages));
    // Rows on file of the kind a run made before this check existed would have written.
    const results = latest(dir);
    results.rows = results.rows.map((r) => (r.id === "R-1.1" || r.id === "R-1.2" ? resetFailedRow(r) : r));
    writeFileSync(join(dir, "tests/results/old/latest.json"), `${JSON.stringify(results, null, 2)}\n`);
    git(["add", "-A"], dir);
    git([...COMMIT, "results from an unusable target (test)"], dir);
    const before = runBranches(dir, "calibrate");

    await assert.rejects(() => runStage(dir, "calibrate", { target: "old", skipSuite: true }), /environment[\s\S]*without --skip-suite/);
    assert.deepEqual(runBranches(dir, "calibrate"), before, "no further question is opened over them");
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("policy.calibrate.environment_faults lets a project tolerate that many rows the machine failed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-env-policy-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  const cfgPath = join(dir, ".sdlc", "config.yaml");
  writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace(/^policy:\n/m, "policy:\n  calibrate: { environment_faults: 1 }\n"));
  git(["add", "-A"], dir);
  git([...COMMIT, "tolerate one environment fault (test)"], dir);
  calibrateEnv(mockRunnerDir("env-policy", [resetFailedRow(PASSING_ROW), FAILING_ROW]));
  try {
    const r = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.equal(rowFor(latest(dir), "R-1.2").result, "fail");
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

// A row the machine failed but that stayed under the policy limit is not a halt — it is
// written into the result set like any other row, error text and all. That text is a
// reset command's own failure and carries this machine's path the same way the halted
// case does, and the result file is committed to the project, so rule E-2 applies to it
// exactly as it applies to the run record (docs/decisions/0020).
test("a row's error is redacted in the written result file, the same as the halted case", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-redact-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  const cfgPath = join(dir, ".sdlc", "config.yaml");
  writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace(/^policy:\n/m, "policy:\n  calibrate: { environment_faults: 1 }\n"));
  git(["add", "-A"], dir);
  git([...COMMIT, "tolerate one environment fault (test)"], dir);
  calibrateEnv(mockRunnerDir("redact", [resetFailedRow(PASSING_ROW), FAILING_ROW]));
  try {
    const r = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    const raw = readFileSync(join(dir, "tests/results/old/latest.json"), "utf8");
    assert.ok(!raw.includes(ELSEWHERE), "a local path is not written into the result file");
    const row = rowFor(latest(dir), "R-1.1");
    assert.match(row.tests[0].error, /~\/agentic-sdlc\/bin\/sdlc\.mjs/);
    // The dated file this run writes alongside latest.json is the same text, so it is
    // clean too.
    const today = new Date().toISOString().slice(0, 10);
    const dated = readFileSync(join(dir, `tests/results/old/${today}.json`), "utf8");
    assert.ok(!dated.includes(ELSEWHERE));
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

// ── unbound rows that bind-adapter cannot close (`docs/decisions/0068`) ──────────────────

const UNREACHABLE = 'Error: unbound: application.status — the status is shown only behind a link the application emails';
const unboundR12 = (error = UNREACHABLE) => ({ ...FAILING_ROW, result: "unbound", tests: [{ title: "status", status: "failed", error }] });

// Two sends of R-1.2's binding already made and closed, so a calibration finding it unbound
// again finds bind-adapter's attempts spent (`policy.loops.rebind`, two by default).
function spendRebinds(dir) {
  const sent = (adapter) => ({ id: "R-1.2", target: "old", why: "unbound: application.status — gone", found: "unbound", adapter,
    closed: { outcome: "met", why: "tests/adapters/old has changed since this was found", by: "runner:calibrate", at: "2026-01-02T00:00:00.000Z" } });
  writeFileSync(join(dir, "tests/adapters/rebind.yaml"), stringifyYaml({ rebind: [sent("a1"), sent("a2")] }));
  git(["add", "-A"], dir);
  git([...COMMIT, "two binding runs have looked for R-1.2 (test)"], dir);
}

// Rules the open triage proposal as the reviewer persona with exactly these conditions, then
// applies the ruling with `--skip-suite`. Leaves the repository on `main`.
async function triageAs(dir, name, conditions) {
  const mock = mkdtempSync(join(tmpdir(), "sdlc-calibrate-triage-verbs-"));
  writeFileSync(join(mock, "rule.json"), JSON.stringify({
    text: '```json\n' + JSON.stringify({ verdict: "approve", rationale: "sorted", conditions }) + '\n```',
  }));
  const prevMockDir = process.env.SDLC_MOCK_DIR;
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mock;
  try {
    const ruled = await ruleByAgent(dir, name, { persona: "reviewer" });
    if (ruled.verdict !== "approve") throw new Error(`triage was not approved: ${JSON.stringify(ruled)}`);
  } finally {
    delete process.env.SDLC_EXECUTOR;
    if (prevMockDir === undefined) delete process.env.SDLC_MOCK_DIR;
    else process.env.SDLC_MOCK_DIR = prevMockDir;
  }
  git(["checkout", "-q", "main"], dir);
  const applied = await runStage(dir, "calibrate", { target: "old", skipSuite: true });
  if (!applied.ok) throw new Error(`calibrate --skip-suite failed: ${JSON.stringify(applied.messages)}`);
  return applied;
}

const rebindList = (dir) => (existsSync(join(dir, "tests/adapters/rebind.yaml"))
  ? parseYaml(readFileSync(join(dir, "tests/adapters/rebind.yaml"), "utf8")).rebind : []);

test("an unbound row bind-adapter has had its sends for goes to the reviewer's triage, and oracle-cannot closes it without touching the criterion", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-oracle-cannot-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  spendRebinds(dir);
  calibrateEnv(mockRunnerDir("unreachable", [PASSING_ROW, unboundR12()]));
  try {
    const first = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(first.ok, true, JSON.stringify(first.messages));
    assert.equal(first.proposal?.name, "calibrate-triage-old-1", "the reviewer is asked about it");
    assert.equal(first.proposal.gate, "G3");
    assert.deepEqual(rebindList(dir).filter((e) => !e.closed), [], "not sent to bind-adapter a third time");
    const page = git(["show", `${first.proposal.branch}:.sdlc/proposals/calibrate-triage-old-1.md`], dir);
    assert.match(page, /R-1\.2/);
    assert.match(page, /unbound: application\.status — the status is shown only behind a link the application emails/, "the adapter's own reason");
    assert.match(page, /bind-adapter was sent (it|each) 2 times without binding it/);
    assert.match(page, /oracle-cannot <ID>: <why>/);
    assert.match(page, /never a way to skip binding work/);

    const domainBefore = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    const applied = await triageAs(dir, "calibrate-triage-old-1", ["oracle-cannot R-1.2: the status is reached only through a link the application emails to an address outside the test"]);
    assert.ok(!applied.proposal, "nothing is put to the product owner");
    const row = rowFor(latest(dir), "R-1.2");
    assert.equal(row.result, "unbound");
    assert.equal(row.ruled, "oracle-cannot");
    const rulings = parseYaml(readFileSync(join(dir, "tests/results/old/applied.yaml"), "utf8")).rulings;
    const ruling = rulings.find((x) => x.verb === "oracle-cannot");
    assert.deepEqual([ruling.id, ruling.version, ruling.gate], ["R-1.2", 1, "calibrate-triage-old-1"]);
    assert.match(ruling.why, /emails to an address outside the test/);
    assert.equal(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), domainBefore, "no criterion changes");

    // A ruling about what the oracle can reach is not about the adapter, so a new adapter
    // leaves it standing.
    const adapterPath = join(dir, "tests/adapters/old/index.ts");
    writeFileSync(adapterPath, `${readFileSync(adapterPath, "utf8")}\n// rebound\n`);
    git(["add", "-A"], dir);
    git([...COMMIT, "rebind the old adapter (test)"], dir);
    const again = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(again.ok, true, JSON.stringify(again.messages));
    assert.equal(rowFor(latest(dir), "R-1.2").ruled, "oracle-cannot");
    assert.ok(!again.proposal);
    assert.deepEqual(rebindList(dir).filter((e) => !e.closed), [], "and it is not sent to bind-adapter under the new adapter");

    // A criterion that moves on to a version nobody has ruled on is asked about afresh.
    const index = JSON.parse(readFileSync(join(dir, "spec/criteria-index.json"), "utf8"));
    for (const c of index.criteria) if (c.id === "R-1.2") c.version = 2;
    writeFileSync(join(dir, "spec/criteria-index.json"), `${JSON.stringify(index, null, 2)}\n`);
    git(["add", "-A"], dir);
    git([...COMMIT, "R-1.2 moves on (test)"], dir);
    await runStage(dir, "calibrate", { target: "old", skipSuite: true });
    assert.equal(rowFor(latest(dir), "R-1.2").ruled, undefined, "the ruling lapsed with the version it was about");
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("adapter-wrong on a spent unbound row sends it to bind-adapter again past the limit", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-unbound-adapter-wrong-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  spendRebinds(dir);
  calibrateEnv(mockRunnerDir("unreachable", [PASSING_ROW, unboundR12()]));
  try {
    const first = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(first.proposal?.name, "calibrate-triage-old-1");
    const applied = await triageAs(dir, "calibrate-triage-old-1", ["adapter-wrong R-1.2: the status field is on the application's own summary page, one step past the list"]);
    assert.ok(!applied.proposal);
    assert.equal(rowFor(latest(dir), "R-1.2").ruled, "adapter-wrong");
    const open = rebindList(dir).filter((e) => !e.closed);
    assert.deepEqual(open.map((e) => [e.id, e.target, e.found]), [["R-1.2", "old", undefined]], "the reviewer's finding, filed past the limit");
    assert.match(open[0].why, /one step past the list/);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("product-question on a spent unbound row puts it to the product owner", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-unbound-product-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  spendRebinds(dir);
  calibrateEnv(mockRunnerDir("unreachable", [PASSING_ROW, unboundR12()]));
  try {
    const first = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(first.proposal?.name, "calibrate-triage-old-1");
    const applied = await triageAs(dir, "calibrate-triage-old-1", ["product-question R-1.2"]);
    assert.equal(applied.proposal?.name, "calibrate-old-1");
    assert.equal(applied.proposal.gate, "G1");
    const page = git(["show", `${applied.proposal.branch}:.sdlc/proposals/calibrate-old-1.md`], dir);
    assert.match(page, /R-1\.2/);
    assert.match(page, /the status is shown only behind a link/);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("oracle-cannot is applied only to an unbound row: on a failing row it is reported and the row is sorted again", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-oracle-cannot-fail-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  calibrateEnv(MOCK_DIR);
  try {
    const first = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(first.proposal?.name, "calibrate-triage-old-1");
    const applied = await triageAs(dir, "calibrate-triage-old-1", ["oracle-cannot R-1.2: the oracle cannot reach it"]);
    assert.equal(rowFor(latest(dir), "R-1.2").ruled, undefined);
    assert.match(lastCalibrateText(dir), /oracle-cannot R-1\.2 not applied: .*fail, not unbound/);
    assert.equal(applied.proposal?.name, "calibrate-triage-old-2", "the failure is sorted again");
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

// A persona the approved contract marks unavailable on the target is a fact about the target,
// so a row whose tests stopped at signing in as one is closed by calibration itself.
function markPersona(dir, signIn) {
  const p = join(dir, "spec/contract/personas.yaml");
  const doc = parseYaml(readFileSync(p, "utf8"));
  doc.personas = doc.personas.filter((x) => x.id !== "second-applicant");
  doc.personas.push({ id: "second-applicant", can: ["submit a permit application"], sign_in: { "sandbox-idp": signIn } });
  writeFileSync(p, stringifyYaml(doc));
  git(["add", "-A"], dir);
  git([...COMMIT, "contract: second-applicant (test)"], dir);
}

test("an unbound row needing a persona the approved contract marks unavailable is closed as persona-unavailable, and re-opens when the persona is offered", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-persona-unavailable-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  markPersona(dir, { unavailable: "the target has one applicant account" });
  calibrateEnv(mockRunnerDir("persona", [PASSING_ROW, unboundR12("Error: unbound: signIn.second-applicant — the target has one applicant account")]));
  try {
    const r = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.ok(!r.proposal, "asked of nobody");
    const row = rowFor(latest(dir), "R-1.2");
    assert.equal(row.result, "unbound");
    assert.equal(row.ruled, "persona-unavailable");
    assert.deepEqual(row.unavailable, { personas: ["second-applicant"], contract: "contract-v1" });
    assert.deepEqual(rebindList(dir).filter((e) => !e.closed), [], "sent to no binding run");
    assert.match(lastCalibrateText(dir), /Closed as persona-unavailable \(contract-v1\): R-1\.2/);
    assert.ok(!existsSync(join(dir, "tests/results/old/applied.yaml")) || !readFileSync(join(dir, "tests/results/old/applied.yaml"), "utf8").includes("persona-unavailable"),
      "worked out from the contract on every run, not recorded as a ruling");

    markPersona(dir, { username: "applicant-2" });
    const reopened = await runStage(dir, "calibrate", { target: "old", skipSuite: true });
    assert.equal(reopened.ok, true, JSON.stringify(reopened.messages));
    const again = rowFor(latest(dir), "R-1.2");
    assert.equal(again.ruled, undefined);
    assert.equal(again.unavailable, undefined);
    assert.deepEqual(rebindList(dir).filter((e) => !e.closed).map((e) => [e.id, e.found]), [["R-1.2", "unbound"]], "owed to bind-adapter now the persona exists");
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

// --- a configuration the target reads at start-up ---

// The contract names a configuration by the variable the oracle override reads for it and the
// tag its tests carry; R-1.2's test is written for it. Committed the way each part would reach
// `main`: the contract and override through a contract approval, the tag through derive-tests.
function addConfiguration(dir, { override = 'services:\n  app:\n    environment: !override\n      MAINTENANCE: "${SDLC_ORACLE_MAINTENANCE:-0}"\n', tag = "@maintenance_mode" } = {}) {
  const obs = join(dir, "spec", "contract", "observables.yaml");
  writeFileSync(obs, `${readFileSync(obs, "utf8")}configurations:
  maintenance_mode:
    for: [R-1.2]
    select: SDLC_ORACLE_MAINTENANCE=1
    tag: "@maintenance_mode"
`);
  mkdirSync(join(dir, ".sdlc", "oracle"), { recursive: true });
  writeFileSync(join(dir, ".sdlc", "oracle", "compose.yml"), override);
  mkdirSync(join(dir, "sources", "old"), { recursive: true });
  writeFileSync(join(dir, "sources", "old", "docker-compose.yml"), "services: {}\n");
  git(["add", "-f", "spec/contract/observables.yaml", ".sdlc/oracle/compose.yml", "sources/old/docker-compose.yml"], dir);
  git([...COMMIT, "a configuration read at start-up (test)"], dir);
  const spec = join(dir, "tests", "acceptance", "applications", "R-1.2.spec.ts");
  writeFileSync(spec, `${readFileSync(spec, "utf8")}\n// selected by ${tag}\n`);
  git(["add", "-A"], dir);
  git([...COMMIT, "stage(derive-tests): R-1.2 is written for maintenance_mode (test)"], dir);
}

function oracleCalls(mockDir) {
  const p = join(mockDir, "oracle-calls.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
}

test("sdlc run calibrate: a configuration's tests run against a copy of the oracle started in it, and the copy is taken down after", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-configuration-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  addConfiguration(dir);
  const mockDir = mockRunnerDir("configuration", [PASSING_ROW, FAILING_ROW]);
  calibrateEnv(mockDir);
  try {
    const r = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    // Every row is in the one result set: R-1.1 from the ordinary run, R-1.2 from the run
    // against the configured copy, R-1.3 read off not-testable.yaml.
    const results = latest(dir);
    assert.deepEqual(results.rows.map((row) => [row.id, row.result]), [["R-1.1", "pass"], ["R-1.2", "fail"], ["R-1.3", "not-testable"]]);
    // Once: the ordinary run left it out. Run in both, its row would carry its test twice.
    assert.equal(rowFor(results, "R-1.2").tests.length, 1);

    const project = "sdlc-permit-intake-old-maintenance_mode";
    const calls = oracleCalls(mockDir).filter((c) => c.args[1] === project);
    const shapes = calls.map((c) => c.args.slice(6).join(" "));
    assert.ok(shapes.some((s) => s.startsWith("up -d --build")), shapes.join(" | "));
    assert.ok(calls.filter((c) => c.args.includes("up")).every((c) => c.env.SDLC_ORACLE_MAINTENANCE === "1"),
      "the copy is started with the configuration's variable");
    assert.equal(shapes[shapes.length - 1], "down -v", "and taken down once its tests have run");
    assert.ok(oracleCalls(mockDir).every((c) => c.args[1] === project || c.env.SDLC_ORACLE_MAINTENANCE === undefined),
      "nothing else is started with it");

    // The default copy's record is as it was, and no configured copy is left recorded.
    const local = parseYaml(readFileSync(join(dir, ".sdlc", "oracle-old.local.yaml"), "utf8"));
    assert.equal(local.compose_project, "sdlc-permit-intake-old");
    assert.equal(local.configurations, undefined);

    assert.match(lastCalibrateText(dir), /R-1\.2 ran against a copy of the oracle started in configuration maintenance_mode/);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

// Either mistake leaves a configuration's tests with nowhere right to run: a variable the
// override never reads starts the default oracle under another name, and a tag no test carries
// selects nothing. The run is refused before any suite starts, rather than recording the
// results of the wrong instance.
test("sdlc run calibrate: a configuration the override does not read, or whose tag no test carries, is refused before anything runs", async () => {
  for (const [label, opts, said] of [
    ["unread", { override: "services:\n  app:\n    environment:\n      OTHER: \"${SDLC_OTHER:-0}\"\n" }, /SDLC_ORACLE_MAINTENANCE.*does not read/],
    ["untagged", { tag: "@maintenance_mod" }, /no test under tests\/acceptance\/ carries its tag @maintenance_mode/],
  ]) {
    const tmp = mkdtempSync(join(tmpdir(), `sdlc-calibrate-configuration-${label}-`));
    const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
    addConfiguration(dir, opts);
    const mockDir = mockRunnerDir(label, [PASSING_ROW, FAILING_ROW]);
    calibrateEnv(mockDir);
    try {
      const r = await runStage(dir, "calibrate", { target: "old" });
      assert.equal(r.ok, false, label);
      assert.ok(r.messages.some((m) => said.test(m)), `${label}: ${r.messages.join(" | ")}`);
      assert.ok(!existsSync(join(dir, "tests/results/old/latest.json")), `${label}: no suite ran`);
      assert.deepEqual(oracleCalls(mockDir), [], `${label}: nothing was started`);
    } finally {
      clearCalibrateEnv();
      restoreEgress(prevEgress);
    }
  }
});

// Only the oracle is started by this pipeline, so only the oracle can be started in a
// configuration. Against any other target the configuration's tests have no instance they are
// written for, and the run says so instead of running them against the one it has.
test("sdlc run calibrate: against a target other than the oracle, a configuration with tests is refused", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-configuration-other-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  addConfiguration(dir);
  const cfgPath = join(dir, ".sdlc", "config.yaml");
  const cfg = parseYaml(readFileSync(cfgPath, "utf8"));
  cfg.targets = { ...(cfg.targets ?? {}), staging: { base_url: "http://localhost:4100", identity: "sandbox-idp" } };
  writeFileSync(cfgPath, stringifyYaml(cfg));
  git(["add", "-A"], dir);
  git([...COMMIT, "a staging target (test)"], dir);
  const mockDir = mockRunnerDir("other", [PASSING_ROW, FAILING_ROW]);
  calibrateEnv(mockDir);
  try {
    const r = await runStage(dir, "calibrate", { target: "staging" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /maintenance_mode/.test(m) && /staging/.test(m)), r.messages.join(" | "));
    assert.ok(!existsSync(join(dir, "tests/results/staging/latest.json")));
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

// --- a calibration re-runs only the rows whose inputs changed (docs/decisions/0072) ---

function setCalibratePolicy(dir, value) {
  const cfg = join(dir, ".sdlc", "config.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace("  default_tier: STANDARD", `  default_tier: STANDARD\n  calibrate: ${value}`));
  git(["add", "-A"], dir);
  git([...COMMIT, "policy.calibrate (test)"], dir);
}

function touch(dir, rel, note = "edited") {
  const abs = join(dir, rel);
  writeFileSync(abs, `${readFileSync(abs, "utf8")}\n${rel.endsWith(".yaml") ? "#" : "//"} ${note}\n`);
  git(["add", "-A"], dir);
  // A spec file keeps its provenance only when the test writer's stage commits it.
  git([...COMMIT, rel.startsWith("tests/acceptance/") ? `stage(derive-tests): ${rel} written again (test)` : `${rel} changed (test)`], dir);
}

function dated(dir, id) {
  return JSON.parse(readFileSync(join(dir, `tests/results/old/${id}.json`), "utf8"));
}

test("under policy.calibrate.scope: changed, a calibration re-runs only the test that changed and carries the rest", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-scoped-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  setCalibratePolicy(dir, "{ scope: changed }");
  calibrateEnv(MOCK_DIR);
  const today = new Date().toISOString().slice(0, 10);
  try {
    const first = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(first.ok, true, JSON.stringify(first.messages));
    let results = latest(dir);
    assert.deepEqual([results.run, results.scope, results.full_run, results.since_full], [today, "full", today, 0]);
    const measured = rowFor(results, "R-1.2");
    assert.equal(measured.measured_in, today);
    for (const k of ["file_sha", "adapter", "contract_seed", "harness"]) assert.match(measured[k], /^[0-9a-f]{40}$/, k);
    assert.equal(typeof measured.override, "string");
    assert.equal(measured.carried, undefined);
    assert.match(lastCalibrateText(dir), /Full run: all 2 test file\(s\) re-run \(no results on file\)\./);

    touch(dir, "tests/acceptance/applications/R-1.1.spec.ts");
    const second = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(second.ok, true, JSON.stringify(second.messages));
    results = latest(dir);
    assert.deepEqual([results.run, results.scope, results.full_run, results.since_full], [`${today}-2`, "changed", today, 1]);
    assert.equal(rowFor(results, "R-1.1").measured_in, `${today}-2`);
    assert.equal(rowFor(results, "R-1.1").carried, undefined);
    assert.equal(rowFor(results, "R-1.2").measured_in, today, "a carried row keeps the run that measured it");
    assert.equal(rowFor(results, "R-1.2").carried, true);
    assert.equal(rowFor(results, "R-1.2").result, "fail");
    assert.equal(results.rows.length, 3, "latest.json still accounts for every criterion");
    // The dated file is the record of what this run measured, and nothing else.
    assert.deepEqual(dated(dir, `${today}-2`).rows.map((r) => r.id), ["R-1.1", "R-1.3"]);
    const text = lastCalibrateText(dir);
    assert.match(text, new RegExp(`1 of 2 re-run \\(1 test changed\\), 1 carried from ${today}\\.`));
    assert.match(text, /No full run is scheduled \(policy\.calibrate\.full_every is unset\)/);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("policy.calibrate.full_every makes every n-th calibration full, and --full forces one on the record", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-cadence-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  setCalibratePolicy(dir, "{ scope: changed, full_every: 2 }");
  calibrateEnv(MOCK_DIR);
  const today = new Date().toISOString().slice(0, 10);
  try {
    assert.equal((await runStage(dir, "calibrate", { target: "old" })).ok, true);
    assert.equal((await runStage(dir, "calibrate", { target: "old" })).ok, true);
    let results = latest(dir);
    assert.equal(results.scope, "changed");
    assert.ok(results.rows.filter((r) => r.file).every((r) => r.carried && r.measured_in === today));
    assert.deepEqual(dated(dir, `${today}-2`).rows.map((r) => r.id), ["R-1.3"], "nothing re-run; only the not-testable row is written again");
    assert.match(lastCalibrateText(dir), new RegExp(`0 of 2 re-run, 2 carried from ${today}\\.`));
    assert.match(lastCalibrateText(dir), /The next calibration is full \(policy\.calibrate\.full_every: 2\)\./);

    assert.equal((await runStage(dir, "calibrate", { target: "old" })).ok, true);
    results = latest(dir);
    assert.deepEqual([results.scope, results.full_run, results.since_full], ["full", `${today}-3`, 0]);
    assert.ok(results.rows.every((r) => !r.carried));
    assert.match(lastCalibrateText(dir), new RegExp(`Full run: all 2 test file\\(s\\) re-run \\(1 scoped calibration since the last full run \\(${today}\\); policy\\.calibrate\\.full_every is 2\\)\\.`));

    const forced = await runStage(dir, "calibrate", { target: "old", full: true });
    assert.equal(forced.ok, true, JSON.stringify(forced.messages));
    assert.deepEqual(latest(dir).full_because, ["--full"]);
    assert.match(lastCalibrateText(dir), /Full run: all 2 test file\(s\) re-run \(--full\)\./);
    const runRecord = git(["log", "-1", "-p", "--format=", "--", ".sdlc/runs"], dir);
    assert.match(runRecord, /calibrate old: a full run, forced with --full/);

    for (const extra of [{ skipSuite: true }, { domain: "applications" }]) {
      const refused = await runStage(dir, "calibrate", { target: "old", full: true, ...extra });
      assert.equal(refused.ok, false);
      assert.match(refused.messages.join("\n"), /--full/);
    }
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("a change to the contract makes a scoped calibration full", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-contract-full-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  setCalibratePolicy(dir, "{ scope: changed }");
  calibrateEnv(MOCK_DIR);
  try {
    assert.equal((await runStage(dir, "calibrate", { target: "old" })).ok, true);
    touch(dir, "spec/contract/observables.yaml", "a new observable");
    const second = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(second.ok, true, JSON.stringify(second.messages));
    assert.equal(latest(dir).scope, "full");
    assert.match(lastCalibrateText(dir), /Full run: all 2 test file\(s\) re-run \(spec\/contract\/ or the seed changed since rows on file were measured\)\./);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("calibrate --dry-run says which tests the next calibration would re-run and which rows it would carry, and writes nothing", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-plan-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  setCalibratePolicy(dir, "{ scope: changed, full_every: 4 }");
  calibrateEnv(MOCK_DIR);
  const today = new Date().toISOString().slice(0, 10);
  try {
    assert.equal((await runStage(dir, "calibrate", { target: "old" })).ok, true);
    touch(dir, "tests/acceptance/applications/R-1.2.spec.ts");
    const head = git(["rev-parse", "HEAD"], dir);
    const r = await runStage(dir, "calibrate", { target: "old", dryRun: true });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.match(r.text, new RegExp(`1 of 2 re-run \\(1 test changed\\), 1 carried from ${today}\\.`));
    assert.match(r.text, /tests\/acceptance\/applications\/R-1\.2\.spec\.ts \(R-1\.2\): test changed/);
    assert.match(r.text, /A full run is due after 3 more scoped calibrations/);
    assert.equal(git(["rev-parse", "HEAD"], dir), head);
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("a scoped calibration starts no copy of the oracle for a configuration none of whose tests changed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-calibrate-scoped-configuration-"));
  const { dir, prevEgress } = await makeReadyForCalibrate(tmp);
  addConfiguration(dir);
  setCalibratePolicy(dir, "{ scope: changed }");
  const mockDir = mockRunnerDir("scoped-configuration", [PASSING_ROW, FAILING_ROW]);
  calibrateEnv(mockDir);
  const copyStarts = () => oracleCalls(mockDir).filter((c) => c.args[1] === "sdlc-permit-intake-old-maintenance_mode" && c.args.includes("up")).length;
  try {
    assert.equal((await runStage(dir, "calibrate", { target: "old" })).ok, true);
    const started = copyStarts();
    assert.ok(started > 0);
    touch(dir, "tests/acceptance/applications/R-1.1.spec.ts");
    assert.equal((await runStage(dir, "calibrate", { target: "old" })).ok, true);
    assert.equal(copyStarts(), started, "R-1.2, the configuration's only test, is carried");
    assert.equal(rowFor(latest(dir), "R-1.2").carried, true);

    touch(dir, "tests/acceptance/applications/R-1.2.spec.ts");
    assert.equal((await runStage(dir, "calibrate", { target: "old" })).ok, true);
    assert.ok(copyStarts() > started, "a changed test of the configuration runs against its copy");
    assert.equal(rowFor(latest(dir), "R-1.2").carried, undefined);
  } finally {
    clearCalibrateEnv();
    restoreEgress(prevEgress);
  }
});

test("the reviewer's and the product owner's pages mark a failing row carried from an earlier run", async () => {
  const { calibratePage, triagePage } = await import("../src/stages/calibrate.mjs");
  const carried = { ...FAILING_ROW, carried: true, measured_in: "2026-01-01-2" };
  const fresh = { ...FAILING_ROW, id: "R-1.4", measured_in: "2026-01-03" };
  for (const page of [triagePage("old", "http://x", [carried, fresh], [], new Map()), calibratePage("old", "http://x", [carried, fresh], new Map())]) {
    assert.match(page, /### R-1\.2 · v1\n\n- carried from 2026-01-01-2: none of its inputs has changed since that run measured it/);
    assert.equal(page.match(/carried from/g).length, 1, "a row this run measured is not marked");
  }
});

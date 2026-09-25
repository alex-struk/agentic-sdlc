// test/test-stages.test.mjs — the `contract` stage.
//
// Builds its own minimal fixture project the way test/spec-stages.test.mjs does, rather
// than importing that file: each test file owns its own setup so a change to one never
// has to reckon with what another file's helpers happen to assume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { git, gitOk } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { rule, settleApproved } from "../src/commands/rule.mjs";
import { propose } from "../src/commands/propose.mjs";
import { writeLocal } from "../src/oracle/ports.mjs";
import { STAGES, PROFILES } from "../src/profiles.mjs";

// A gated stage's work is committed to its proposal branch and the checkout is left on
// `main`, so what the stage produced is read out of the branch rather than off disk.
const onBranch = (dir, branch, path) => git(["show", `${branch}:${path}`], dir);
const existsOnBranch = (dir, branch, path) => gitOk(["cat-file", "-e", `${branch}:${path}`], dir);

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;
const MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;

// Both `bind-adapter` and `calibrate` refuse a `sandbox-idp` target with nothing in
// `SDLC_SANDBOX_PASSWORD`, and this fixture's oracle uses that identity. Only the
// presence of the variable is checked here — the mock executor spawns no session and the
// mock test runner opens no browser, so the value itself never reaches anything.
process.env.SDLC_SANDBOX_PASSWORD = "set-for-tests";

// Isolates the egress name list the same way test/spec-stages.test.mjs does: `init` (run
// as part of `newProject`) seeds the default list under the real home directory unless
// this is set first, and an existing-but-empty file wins the lookup outright.
async function makeProject(tmp, from = FROM) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  const dir = join(tmp, "permit-intake");
  await newProject({ dir, from });
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "fill constitution"], dir);
  return { dir, prevEgress };
}

function restoreEgress(prev) {
  if (prev === undefined) delete process.env.SDLC_EGRESS_NAMES;
  else process.env.SDLC_EGRESS_NAMES = prev;
}

test("contract sits in STAGES after ratify, and in every profile that has derive-tests", () => {
  assert.ok(STAGES.includes("contract"));
  assert.ok(STAGES.indexOf("contract") > STAGES.indexOf("ratify"));
  for (const [name, stages] of Object.entries(PROFILES)) {
    if (stages.includes("derive-tests")) assert.ok(stages.includes("contract"), `${name} has derive-tests but not contract`);
  }
});

test("sdlc run contract: the mock run opens proposal/contract-v1 at G1 carrying the contract, seed and manifest", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-ok-"));
  const { dir, prevEgress } = await makeProject(tmp);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  try {
    const r = await runStage(dir, "contract");
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.ok(r.proposal);
    assert.equal(r.proposal.name, "contract-v1");
    assert.equal(r.proposal.gate, "G1");
    assert.equal(r.proposal.branch, "proposal/contract-v1");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");

    const branch = r.proposal.branch;
    const proposalText = onBranch(dir, branch, ".sdlc/proposals/contract-v1.md");
    assert.match(proposalText, /gate: G1/);
    assert.match(proposalText, /"Is this the contract the tests will act through\?"/);

    const surfaceText = onBranch(dir, branch, "spec/contract/surface.yaml");
    assert.match(surfaceText, /applications-new/);
    assert.match(surfaceText, /fees-quote/);

    const personasText = onBranch(dir, branch, "spec/contract/personas.yaml");
    assert.match(personasText, /applicant/);
    assert.match(personasText, /anonymous-visitor/);

    assert.ok(existsOnBranch(dir, branch, "tests/seed/001-users.sql"));
    const manifestText = onBranch(dir, branch, "tests/seed/manifest.yaml");
    assert.match(manifestText, /applicantOne/);

    assert.ok(existsOnBranch(dir, branch, ".sdlc/journal/001-contract.md"));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

// The stage that owes a missing test is handed it when it runs, and may say it is another
// stage's; the move is recorded on main against the proposal the run opened.
test("sdlc run contract: the missing tests contract owes are in its prompt, and a re-address line moves one", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-owed-"));
  const { dir, prevEgress } = await makeProject(tmp);
  writeFileSync(join(dir, "tests/acceptance/not-testable.yaml"),
    "criteria:\n  - { id: R-1.3, version: 1, reason: \"blocked: no observation of the fee\" }\n  - { id: R-1.4, version: 1, reason: \"blocked: two states at once\", missing: \"a criterion that asks for one state\", owner: contract }\n");
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "records (test)"], dir);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-contract-owed-mock-"));
  const mock = JSON.parse(readFileSync(join(MOCK_DIR, "contract.json"), "utf8"));
  mock.text = `${mock.text}\n\nre-address missing-test/R-1.4 to ratify: the criterion asks for two states at once`;
  writeFileSync(join(mockDir, "contract.json"), JSON.stringify(mock));
  const logs = [];
  const origLog = console.log;
  try {
    console.log = (...a) => logs.push(a.join(" "));
    const dry = await runStage(dir, "contract", { dryRun: true });
    console.log = origLog;
    assert.equal(dry.ok, true, JSON.stringify(dry.messages));
    const printed = logs.join("\n");
    assert.match(printed, /missing-test\/R-1\.3 — "blocked: no observation of the fee"/);
    assert.match(printed, /re-address missing-test\/<id> to <stage>: <why>/);

    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDir;
    const r = await runStage(dir, "contract");
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.equal(git(["status", "--porcelain"], dir), "");
    const owed = parseYaml(git(["show", "main:.sdlc/owed.yaml"], dir)).owed;
    const moved = owed.find((e) => e.item === "R-1.4");
    assert.equal(moved.stage, "ratify");
    assert.deepEqual([moved.readdressed[0].from, moved.readdressed[0].by], ["contract", "contract-v1"]);
    assert.equal(owed.find((e) => e.item === "R-1.3").stage, "contract");
    assert.match(git(["log", "-1", "--format=%s", "main"], dir), /record\(contract\): missing-test\/R-1\.4 re-addressed to ratify by contract-v1/);
  } finally {
    console.log = origLog;
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

// What the owing stage supplied reaches `main` with its approval, and so does the hand-on to
// the test writer that rests on it; what it was handed and did not hand on it kept.
test("sdlc rule contract-v1 approve: the items contract supplied go to derive-tests with the ruling, and the rest are kept", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-handoff-"));
  const { dir, prevEgress } = await makeProject(tmp);
  writeFileSync(join(dir, "tests/acceptance/not-testable.yaml"), [
    "criteria:",
    "  - { id: R-1.3, version: 1, reason: \"blocked: no observation of the fee\" }",
    "  - { id: R-1.4, version: 1, reason: \"blocked: two states at once\", missing: \"a criterion that asks for one state\", owner: contract }",
    "  - { id: R-1.5, version: 1, reason: \"blocked: a second administrator\", missing: \"a way to sign in as a second administrator\", owner: contract }",
    "",
  ].join("\n"));
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "records (test)"], dir);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-contract-handoff-mock-"));
  const mock = JSON.parse(readFileSync(join(MOCK_DIR, "contract.json"), "utf8"));
  mock.text = `${mock.text}\n\nre-address missing-test/R-1.3 to derive-tests: fees-quote.amount\nre-address missing-test/R-1.4 to ratify: the criterion asks for two states at once`;
  writeFileSync(join(mockDir, "contract.json"), JSON.stringify(mock));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "contract");
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    const stageOf = (id) => parseYaml(git(["show", "main:.sdlc/owed.yaml"], dir)).owed.find((e) => e.item === id);
    assert.equal(stageOf("R-1.4").stage, "ratify", "a move to the stage whose it is is made when the run finishes");
    assert.equal(stageOf("R-1.3").stage, "contract", "a hand-on to the writer waits for the contract it rests on");

    rule(dir, "contract-v1", "approve", { by: "tech-lead" });
    assert.equal(git(["status", "--porcelain"], dir), "");
    const handed = stageOf("R-1.3");
    assert.equal(handed.stage, "derive-tests");
    assert.equal(handed.closed, undefined, "it stays open until a test runs");
    assert.deepEqual([handed.readdressed.at(-1).by, handed.readdressed.at(-1).gate, handed.readdressed.at(-1).approved_by, handed.readdressed.at(-1).why],
      ["contract-v1", "G1", "tech-lead", "fees-quote.amount"]);
    assert.equal(stageOf("R-1.4").stage, "ratify");
    const kept = stageOf("R-1.5");
    assert.equal(kept.stage, "contract");
    assert.deepEqual([kept.kept.by, kept.kept.gate, kept.kept.approved_by], ["contract-v1", "G1", "tech-lead"]);
    assert.match(git(["log", "-1", "--format=%an %s", "main"], dir), /^sdlc merge: contract-v1 approved/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

// A proposal approved before its hand-on was applied is settled by the pipeline, in a commit
// of its own, and settling it again changes nothing.
test("sdlc rule <name> --settle: an approved proposal's unapplied hand-on is applied as the pipeline, once", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-settle-"));
  const { dir, prevEgress } = await makeProject(tmp);
  writeFileSync(join(dir, "tests/acceptance/not-testable.yaml"), [
    "criteria:",
    "  - { id: R-1.3, version: 1, reason: \"blocked: no observation of the fee\" }",
    "  - { id: R-1.4, version: 1, reason: \"blocked: two states at once\", missing: \"a criterion that asks for one state\", owner: contract }",
    "  - { id: R-1.5, version: 1, reason: \"blocked: a second administrator\", missing: \"a second administrator\", owner: contract }",
    "",
  ].join("\n"));
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "records (test)"], dir);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-contract-settle-mock-"));
  const mock = JSON.parse(readFileSync(join(MOCK_DIR, "contract.json"), "utf8"));
  mock.text = `${mock.text}\n\nre-address missing-test/R-1.3 to derive-tests: fees-quote.amount\nre-address missing-test/R-1.4 to ratify: the criterion asks for two states at once`;
  writeFileSync(join(mockDir, "contract.json"), JSON.stringify(mock));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "contract");
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    rule(dir, "contract-v1", "approve", { by: "tech-lead" });
    // Put main back the way a pipeline that never applied either move left it.
    const owed = parseYaml(git(["show", "main:.sdlc/owed.yaml"], dir));
    for (const e of owed.owed) { e.stage = "contract"; delete e.readdressed; delete e.kept; }
    writeFileSync(join(dir, ".sdlc/owed.yaml"), stringifyYaml(owed));
    git(["add", "-A"], dir);
    git(["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost", "commit", "-q", "-m", "as an earlier pipeline left it (test)"], dir);
    // A criterion superseded since: no test is derived for it, so its item is withdrawn.
    mkdirSync(join(dir, "spec"), { recursive: true });
    writeFileSync(join(dir, "spec/criteria-index.json"), JSON.stringify({ criteria: [
      { id: "R-1.5", domain: "applications", version: 1, state: "accepted", supersededBy: "R-1.1" },
    ] }));
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "ratified (test)"], dir);

    assert.throws(() => settleApproved(dir, "contract-v9"), /contract-v9 has no approval on main/);
    const s = settleApproved(dir, "contract-v1");
    assert.deepEqual(s.readdressed.map((m) => [m.id, m.to]), [["R-1.3", "derive-tests"], ["R-1.4", "ratify"]]);
    const after = parseYaml(git(["show", "main:.sdlc/owed.yaml"], dir)).owed;
    assert.equal(after.find((e) => e.item === "R-1.3").stage, "derive-tests");
    assert.equal(after.find((e) => e.item === "R-1.3").readdressed.at(-1).approved_by, "tech-lead");
    assert.equal(after.find((e) => e.item === "R-1.4").stage, "ratify");
    assert.equal(git(["log", "-1", "--format=%an|%s", "main"], dir), "sdlc|record(G1): contract-v1 settles 3 missing tests: 1 to derive-tests, 1 to ratify, 1 withdrawn with its criterion");
    assert.equal(after.find((e) => e.item === "R-1.5").closed.outcome, "withdrawn");
    assert.match(git(["log", "-1", "--format=%b", "main"], dir), /re-addressed to derive-tests: missing-test\/R-1\.3\nre-addressed to ratify: missing-test\/R-1\.4/);
    assert.equal(git(["status", "--porcelain"], dir), "");
    const head = git(["rev-parse", "HEAD"], dir);
    assert.equal(settleApproved(dir, "contract-v1").path, null);
    assert.equal(git(["rev-parse", "HEAD"], dir), head, "settling twice commits nothing");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run contract: a mock whose applicant persona has no sign_in for the configured identity fails the post-check", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-nosignin-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-contract-nosignin-mock-"));
  writeFileSync(join(mockDir, "contract.json"), JSON.stringify({
    text: "wrote the contract but forgot the applicant's sign-in",
    files: {
      "spec/contract/surface.yaml":
        "pages:\n  - id: applications-new\n    domain: applications\n    route: /applications\n    title: \"New permit application\"\n"
        + "    actions: { submit: { test_id: null } }\n    observations: { status: { test_id: null } }\n"
        + "  - id: fees-quote\n    domain: fees\n    route: /fees/quote\n    title: \"Fee quote\"\n"
        + "    actions: { calculate: { test_id: null } }\n    observations: { amount: { test_id: null } }\n",
      "spec/contract/personas.yaml":
        "personas:\n  - id: applicant\n    can: [submit a permit application]\n    sign_in: {}\n"
        + "  - id: anonymous-visitor\n    can: [view a fee quote]\n    sign_in: null\n",
      "spec/contract/observables.yaml": "email: { via: mail-catcher, api: \"${SDLC_MAIL_API}\" }\n",
      "tests/seed/001-users.sql": "INSERT INTO users (id, email) VALUES ('1', 'applicant-1@example.test');\n",
      "tests/seed/manifest.yaml": "users:\n  applicantOne: { id: \"1\", email: \"applicant-1@example.test\" }\n",
    },
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "contract");
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m.includes("applicant") && m.includes("sandbox-idp")), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(contract\): post-checks failed/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run contract: a persona may mark an identity unavailable with a reason, and the post-check accepts it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-unavailable-ok-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-contract-unavailable-ok-mock-"));
  writeFileSync(join(mockDir, "contract.json"), JSON.stringify({
    text: "wrote the contract; the sandbox seeds only one applicant account, so a second reviewer role has no way to sign in",
    files: {
      "spec/contract/surface.yaml":
        "pages:\n  - id: applications-new\n    domain: applications\n    route: /applications\n    title: \"New permit application\"\n"
        + "    actions: { submit: { test_id: null } }\n    observations: { status: { test_id: null } }\n"
        + "  - id: fees-quote\n    domain: fees\n    route: /fees/quote\n    title: \"Fee quote\"\n"
        + "    actions: { calculate: { test_id: null } }\n    observations: { amount: { test_id: null } }\n",
      "spec/contract/personas.yaml":
        "personas:\n  - id: applicant\n    can: [submit a permit application]\n    sign_in: { sandbox-idp: { username: applicant-1 } }\n"
        + "  - id: second-reviewer\n    can: [countersign an application]\n"
        + "    sign_in: { sandbox-idp: { unavailable: \"the sandbox seeds only one applicant account\" } }\n"
        + "  - id: anonymous-visitor\n    can: [view a fee quote]\n    sign_in: null\n",
      "spec/contract/observables.yaml": "email: { via: mail-catcher, api: \"${SDLC_MAIL_API}\" }\n",
      "tests/seed/001-users.sql": "INSERT INTO users (id, email) VALUES ('1', 'applicant-1@example.test');\n",
      "tests/seed/manifest.yaml": "users:\n  applicantOne: { id: \"1\", email: \"applicant-1@example.test\" }\n",
    },
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "contract");
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.equal(r.proposal.name, "contract-v1");
    const personasText = onBranch(dir, r.proposal.branch, "spec/contract/personas.yaml");
    assert.match(personasText, /unavailable: "the sandbox seeds only one applicant account"/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run contract: a persona marking an identity unavailable with an empty reason fails the post-check", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-unavailable-empty-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-contract-unavailable-empty-mock-"));
  writeFileSync(join(mockDir, "contract.json"), JSON.stringify({
    text: "wrote the contract but left the unavailable reason blank",
    files: {
      "spec/contract/surface.yaml":
        "pages:\n  - id: applications-new\n    domain: applications\n    route: /applications\n    title: \"New permit application\"\n"
        + "    actions: { submit: { test_id: null } }\n    observations: { status: { test_id: null } }\n"
        + "  - id: fees-quote\n    domain: fees\n    route: /fees/quote\n    title: \"Fee quote\"\n"
        + "    actions: { calculate: { test_id: null } }\n    observations: { amount: { test_id: null } }\n",
      "spec/contract/personas.yaml":
        "personas:\n  - id: applicant\n    can: [submit a permit application]\n    sign_in: { sandbox-idp: { username: applicant-1 } }\n"
        + "  - id: second-reviewer\n    can: [countersign an application]\n"
        + "    sign_in: { sandbox-idp: { unavailable: \"\" } }\n"
        + "  - id: anonymous-visitor\n    can: [view a fee quote]\n    sign_in: null\n",
      "spec/contract/observables.yaml": "email: { via: mail-catcher, api: \"${SDLC_MAIL_API}\" }\n",
      "tests/seed/001-users.sql": "INSERT INTO users (id, email) VALUES ('1', 'applicant-1@example.test');\n",
      "tests/seed/manifest.yaml": "users:\n  applicantOne: { id: \"1\", email: \"applicant-1@example.test\" }\n",
    },
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "contract");
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m.includes("second-reviewer") && m.includes("unavailable")), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(contract\): post-checks failed/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run contract: re-run after approving contract-v1 opens contract-v2", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-rerun-"));
  const { dir, prevEgress } = await makeProject(tmp);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  try {
    const first = await runStage(dir, "contract");
    assert.equal(first.ok, true, JSON.stringify(first.messages));
    assert.equal(first.proposal.branch, "proposal/contract-v1");

    // G1's holder in the fixture config is the human role tech-lead, the same as
    // archaeology's own ruling — this rules directly rather than through the mock executor.
    const ruled = rule(dir, "contract-v1", "approve", { by: "tech-lead" });
    assert.equal(ruled.verdict, "approve");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");

    const second = await runStage(dir, "contract");
    assert.equal(second.ok, true, JSON.stringify(second.messages));
    assert.equal(second.proposal.name, "contract-v2");
    assert.equal(second.proposal.branch, "proposal/contract-v2");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

// --- derive-tests ---
//
// Three permanent criteria, minted for a domain file this suite writes and ratifies
// directly (`ratifyApplicationsDirectly`) rather than through a real `sdlc run
// archaeology` turn: every criterion below is already `confirmed`, so a plain approval
// (no ratification conditions) mints all three in one pass, and derive-tests' own tests
// care only about the ratified result — three accepted criteria under known ids — not
// the path that produced it.
const DERIVE_TESTS_DOMAIN_TEXT = `# applications

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

async function ratifyApplicationsDirectly(dir) {
  writeFileSync(join(dir, "spec", "domains", "applications.md"), DERIVE_TESTS_DOMAIN_TEXT);
  propose(dir, "archaeology-applications", {
    gate: "G1",
    question: "Is this what the applications domain does, and which of it is the contract?",
    recommendation: "recovered three criteria from the fixture's old application",
    paths: ["spec/domains/applications.md"],
  });
  rule(dir, "archaeology-applications", "approve", { by: "tech-lead" });
  const r = await runStage(dir, "ratify", { domain: "applications" });
  if (!r.ok) throw new Error(`ratify failed: ${JSON.stringify(r.messages)}`);
}

// A project with the applications domain ratified (R-1.1, R-1.2, R-1.3, all accepted)
// and the contract completed and approved (contract-v1) — spec/contract is committed on
// main, which the `spec-only` workspace `derive-tests` runs in needs, since it archives
// only committed content.
async function makeReadyForDeriveTests(tmp) {
  const { dir, prevEgress } = await makeProject(tmp);
  await ratifyApplicationsDirectly(dir);

  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  const contractRun = await runStage(dir, "contract");
  if (!contractRun.ok) throw new Error(`contract failed: ${JSON.stringify(contractRun.messages)}`);
  delete process.env.SDLC_EXECUTOR;
  delete process.env.SDLC_MOCK_DIR;
  rule(dir, "contract-v1", "approve", { by: "tech-lead" });

  return { dir, prevEgress };
}

const DERIVE_TESTS_MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;

test("sdlc run derive-tests --domain fees: refused before any agent turn — fees has no accepted criteria yet", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-tests-unratified-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  try {
    const r = await runStage(dir, "derive-tests", { domain: "fees" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /derive-tests: domain fees has no accepted criteria; run ratify first/.test(m)), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    restoreEgress(prevEgress);
  }
});

test("sdlc run derive-tests --domain applications: the mock run opens proposal/derive-tests-applications at G3 with the two spec files, the not-testable entry and tests/generated", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-tests-ok-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = DERIVE_TESTS_MOCK_DIR;
  try {
    const r = await runStage(dir, "derive-tests", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.ok(r.proposal);
    assert.equal(r.proposal.name, "derive-tests-applications");
    assert.equal(r.proposal.gate, "G3");
    assert.equal(r.proposal.branch, "proposal/derive-tests-applications");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");

    const branch = r.proposal.branch;
    const proposalText = onBranch(dir, branch, ".sdlc/proposals/derive-tests-applications.md");
    assert.match(proposalText, /gate: G3/);
    assert.match(proposalText, /"Do these tests follow from the applications criteria and from nothing else\?"/);

    assert.ok(existsOnBranch(dir, branch, "tests/acceptance/applications/R-1.1.spec.ts"));
    assert.ok(existsOnBranch(dir, branch, "tests/acceptance/applications/R-1.2.spec.ts"));
    const notTestable = onBranch(dir, branch, "tests/acceptance/not-testable.yaml");
    assert.match(notTestable, /R-1\.3/);
    assert.ok(existsOnBranch(dir, branch, "tests/generated/surface.d.ts"));

    const committed = git(["show", "--name-only", "--format=", branch], dir);
    assert.match(committed, /tests\/acceptance\/applications\/R-1\.1\.spec\.ts/);
    assert.match(committed, /tests\/acceptance\/not-testable\.yaml/);
    assert.match(committed, /tests\/generated\/surface\.d\.ts/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run derive-tests --domain applications: a mock file that touches locator( fails separation", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-tests-locator-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-derive-tests-locator-mock-"));
  writeFileSync(join(mockDir, "derive-tests.json"), JSON.stringify({
    text: "wrote a test that reaches past the surface",
    files: {
      "tests/acceptance/applications/R-1.1.spec.ts":
        "// criterion: @R-1.1 v1\n// provenance: blind, spec@0000000000000000000000000000000000000a, derived 2026-09-06\n"
        + "import { test, expect, persona } from \"../../fixtures\";\n\n"
        + "test(\"age check\", async ({ surface, page }) => {\n  await surface.signIn(persona.applicant);\n"
        + "  await page.locator('#submit').click();\n  expect(await surface.applicationsNew.status()).toBe(\"rejected\");\n});\n",
      "tests/acceptance/applications/R-1.2.spec.ts":
        "// criterion: @R-1.2 v1\n// provenance: blind, spec@0000000000000000000000000000000000000a, derived 2026-09-06\n"
        + "import { test, expect, persona } from \"../../fixtures\";\n\n"
        + "test(\"acceptance status\", async ({ surface }) => {\n  await surface.signIn(persona.applicant);\n"
        + "  await surface.applicationsNew.submit({ age: 25 });\n  expect(await surface.applicationsNew.status()).toBe(\"accepted\");\n});\n",
      "tests/acceptance/not-testable.yaml": "criteria:\n  - { id: R-1.3, version: 1, reason: \"no observation exposes the recalculated fee amount\", missing: \"an observation of the recalculated fee amount\", owner: contract }\n",
    },
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "derive-tests", { domain: "applications" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m.includes("locator(")), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(derive-tests\): post-checks failed/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

// A record is an owed item the moment it is approved, so it has to say what is owed and by
// whom. The writer is told the form in its skill; the post-check is what holds it to it.
test("sdlc run derive-tests --domain applications: a record that names nothing missing and no owner fails the post-check", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-tests-record-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-derive-tests-record-mock-"));
  const mock = JSON.parse(readFileSync(join(DERIVE_TESTS_MOCK_DIR, "derive-tests.json"), "utf8"));
  mock.files["tests/acceptance/not-testable.yaml"] = "criteria:\n  - { id: R-1.3, version: 1, reason: \"no observation exposes the recalculated fee amount\", owner: derive-tests }\n";
  writeFileSync(join(mockDir, "derive-tests.json"), JSON.stringify(mock));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "derive-tests", { domain: "applications" });
    assert.equal(r.ok, false);
    const said = r.messages.join(" | ");
    assert.match(said, /not-testable\.yaml: R-1\.3 names nothing as missing/);
    assert.match(said, /R-1\.3 names derive-tests as its owner/);
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(derive-tests\): post-checks failed/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run derive-tests --domain applications: a mock omitting a criterion fails coverage, naming the id", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-tests-coverage-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-derive-tests-coverage-mock-"));
  writeFileSync(join(mockDir, "derive-tests.json"), JSON.stringify({
    text: "wrote only one test, forgot the acceptance-status criterion entirely",
    files: {
      "tests/acceptance/applications/R-1.1.spec.ts":
        "// criterion: @R-1.1 v1\n// provenance: blind, spec@0000000000000000000000000000000000000a, derived 2026-09-06\n"
        + "import { test, expect, persona } from \"../../fixtures\";\n\n"
        + "test(\"age check\", async ({ surface }) => {\n  await surface.signIn(persona.applicant);\n"
        + "  await surface.applicationsNew.submit({ age: 17 });\n  expect(await surface.applicationsNew.status()).toBe(\"rejected\");\n});\n",
      "tests/acceptance/not-testable.yaml": "criteria:\n  - { id: R-1.3, version: 1, reason: \"no observation exposes the recalculated fee amount\", missing: \"an observation of the recalculated fee amount\", owner: contract }\n",
    },
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "derive-tests", { domain: "applications" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m.includes("R-1.2")), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run derive-tests --domain applications --stale: after bumping one criterion's version in the index, --dry-run lists only that criterion", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-tests-stale-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = DERIVE_TESTS_MOCK_DIR;
  const logs = [];
  const origLog = console.log;
  try {
    const first = await runStage(dir, "derive-tests", { domain: "applications" });
    assert.equal(first.ok, true, JSON.stringify(first.messages));
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

    // `checkTests` compares a spec file's own header version against the index, so the
    // spec files this run wrote have to actually be on main (via a real ruling) before a
    // later version bump can show up as staleness — G3's holder is agent:reviewer, but
    // tech-lead is its escalate_to and a human may rule directly through it.
    rule(dir, "derive-tests-applications", "approve", { by: "tech-lead" });
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");

    const idxPath = join(dir, "spec/criteria-index.json");
    const index = JSON.parse(readFileSync(idxPath, "utf8"));
    index.criteria.find((c) => c.id === "R-1.2").version = 2;
    writeFileSync(idxPath, JSON.stringify(index, null, 2) + "\n");
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "bump R-1.2's version (test)"], dir);

    console.log = (...a) => logs.push(a.join(" "));
    const dry = await runStage(dir, "derive-tests", { domain: "applications", stale: true, dryRun: true });
    console.log = origLog;
    assert.equal(dry.ok, true, JSON.stringify(dry.messages));

    const printed = logs.join("\n");
    assert.match(printed, /R-1\.2/);
    assert.ok(!printed.includes("R-1.1"), printed);
    assert.ok(!printed.includes("R-1.3"), printed);
  } finally {
    console.log = origLog;
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

// A missing test re-addressed to derive-tests is what a --stale run of its domain derives, with
// what the stage that supplied the missing thing said about it.
test("sdlc run derive-tests --domain applications --stale: a missing test owed by derive-tests is derived, with what was supplied", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-tests-missing-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = DERIVE_TESTS_MOCK_DIR;
  const logs = [];
  const origLog = console.log;
  try {
    const first = await runStage(dir, "derive-tests", { domain: "applications" });
    assert.equal(first.ok, true, JSON.stringify(first.messages));
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    rule(dir, "derive-tests-applications", "approve", { by: "tech-lead" });
    const owed = parseYaml(readFileSync(join(dir, ".sdlc/owed.yaml"), "utf8"));
    const item = owed.owed.find((e) => e.kind === "missing-test" && e.item === "R-1.3");
    assert.equal(item.stage, "contract", "the approval opened the record's item for its owner");
    item.stage = "derive-tests";
    item.readdressed = [{ from: "contract", to: "derive-tests", why: "applications-new now observes the fee amount", by: "contract-v2", at: "2026-01-01T00:00:00.000Z" }];
    writeFileSync(join(dir, ".sdlc/owed.yaml"), stringifyYaml(owed));
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "re-address R-1.3 (test)"], dir);

    console.log = (...a) => logs.push(a.join(" "));
    const dry = await runStage(dir, "derive-tests", { domain: "applications", stale: true, dryRun: true });
    console.log = origLog;
    assert.equal(dry.ok, true, JSON.stringify(dry.messages));
    const printed = logs.join("\n");
    assert.match(printed, /R-1\.3/);
    assert.match(printed, /applications-new now observes the fee amount/);
    assert.ok(!printed.includes("R-1.1 ("), printed);
  } finally {
    console.log = origLog;
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run derive-tests --domain applications: a criterion carrying superseded-by is excluded from derivation, so coverage needs no test or not-testable entry for it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-tests-superseded-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  try {
    // Stands in for what a `defect` ratification condition would have produced: R-1.2 is
    // replaced by R-1.1, the same shape `applyConditions`/`mintIds` (src/spec/criteria.mjs)
    // leave on a domain file, written directly into the index here since these tests care
    // only about the ratified result.
    const idxPath = join(dir, "spec/criteria-index.json");
    const index = JSON.parse(readFileSync(idxPath, "utf8"));
    index.criteria.find((c) => c.id === "R-1.2").supersededBy = "R-1.1";
    writeFileSync(idxPath, JSON.stringify(index, null, 2) + "\n");
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "mark R-1.2 superseded (test)"], dir);

    const mockDir = mkdtempSync(join(tmpdir(), "sdlc-derive-tests-superseded-mock-"));
    writeFileSync(join(mockDir, "derive-tests.json"), JSON.stringify({
      text: "Wrote a test for R-1.1 only. R-1.2 is superseded and gets no test of its own; R-1.3 has no observable amount.",
      files: {
        "tests/acceptance/applications/R-1.1.spec.ts":
          "// criterion: @R-1.1 v1\n// provenance: blind, spec@0000000000000000000000000000000000000a, derived 2026-09-06\n"
          + "import { test, expect, persona } from \"../../fixtures\";\n\n"
          + "test(\"age check\", async ({ surface }) => {\n  await surface.signIn(persona.applicant);\n"
          + "  await surface.applicationsNew.submit({ age: 17 });\n  expect(await surface.applicationsNew.status()).toBe(\"rejected\");\n});\n",
        "tests/acceptance/not-testable.yaml": "criteria:\n  - { id: R-1.3, version: 1, reason: \"no observation exposes the recalculated fee amount\", missing: \"an observation of the recalculated fee amount\", owner: contract }\n",
      },
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDir;
    const r = await runStage(dir, "derive-tests", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    // No spec file and no not-testable entry exists for R-1.2 anywhere, yet coverage
    // still passed — the only way that happens is that R-1.2 was never on the "needs a
    // test" list to begin with.
    assert.ok(!existsSync(join(dir, "tests/acceptance/applications/R-1.2.spec.ts")));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

// --- bind-adapter ---
//
// `fixture.config.yaml` itself configures no oracle at all, only a `new` target, so
// `--target old` needs a fixture-variant config carrying an `oracle` block before
// bind-adapter's own pre-checks have anything to look for.
const ORACLE_BLOCK = `
oracle:
  target: old
  compose: sources/old/docker-compose.yml
  seed: tests/seed/
  base_url: http://localhost:3100
  identity: sandbox-idp
`;

function addOracleConfig(dir) {
  const cfgPath = join(dir, ".sdlc", "config.yaml");
  writeFileSync(cfgPath, readFileSync(cfgPath, "utf8") + ORACLE_BLOCK);
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "add oracle config (test)"], dir);
}

async function makeProjectWithOracle(tmp) {
  const { dir, prevEgress } = await makeProject(tmp);
  addOracleConfig(dir);
  return { dir, prevEgress };
}

// A project with `spec/contract` completed and approved (contract-v1, committed on
// main — the `blind-adapter` workspace bind-adapter runs in archives only committed
// content, the same reason `derive-tests`'s own `makeReadyForDeriveTests` needs it) and
// the oracle configured only *after* that ruling: `contract`'s own post-checks judge a
// project with `config.oracle` set on writing a compose override the fixture's canned
// response never produces, and bind-adapter's own tests have nothing to do with that
// check.
async function makeReadyForBindAdapter(tmp) {
  const { dir, prevEgress } = await makeProject(tmp);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  const contractRun = await runStage(dir, "contract");
  if (!contractRun.ok) throw new Error(`contract failed: ${JSON.stringify(contractRun.messages)}`);
  delete process.env.SDLC_EXECUTOR;
  delete process.env.SDLC_MOCK_DIR;
  rule(dir, "contract-v1", "approve", { by: "tech-lead" });
  addOracleConfig(dir);
  return { dir, prevEgress };
}

// `readLocal`/`writeLocal` round-trip exactly this shape (`src/oracle/ports.mjs`) —
// standing in for what a real `sdlc oracle up` would have written, without spinning up
// Docker for a stage test that only cares that the file is there.
function writeOldOracleLocal(dir) {
  writeLocal(dir, "old", {
    target: "old",
    base_url: "http://localhost:3100",
    mail_api: "http://localhost:8025",
    ports: { app: 3100, db: 5500, mail_api: 8025 },
    compose_project: "sdlc-permit-intake-old",
  });
}

const BIND_ADAPTER_MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;

test("sdlc run bind-adapter --target old: refused before any agent turn — the oracle has not been started", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-bind-adapter-notup-"));
  const { dir, prevEgress } = await makeProjectWithOracle(tmp);
  process.env.SDLC_ORACLE = "mock";
  try {
    const r = await runStage(dir, "bind-adapter", { target: "old" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /bind-adapter: the old target is not up; run sdlc oracle up first/.test(m)), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    delete process.env.SDLC_ORACLE;
    restoreEgress(prevEgress);
  }
});

test("sdlc run bind-adapter --target old: the mock run opens proposal/bind-adapter-old at G3 with the adapter and its bindings", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-bind-adapter-ok-"));
  const { dir, prevEgress } = await makeReadyForBindAdapter(tmp);
  writeOldOracleLocal(dir);
  process.env.SDLC_ORACLE = "mock";
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = BIND_ADAPTER_MOCK_DIR;
  try {
    const r = await runStage(dir, "bind-adapter", { target: "old" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.ok(r.proposal);
    assert.equal(r.proposal.name, "bind-adapter-old");
    assert.equal(r.proposal.gate, "G3");
    assert.equal(r.proposal.branch, "proposal/bind-adapter-old");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");

    const branch = r.proposal.branch;
    const proposalText = onBranch(dir, branch, ".sdlc/proposals/bind-adapter-old.md");
    assert.match(proposalText, /gate: G3/);
    assert.match(proposalText, /"Does this adapter bind every surface action and observation on old, and nothing else\?"/);

    assert.ok(existsOnBranch(dir, branch, "tests/adapters/old/index.ts"));
    const bindings = onBranch(dir, branch, "tests/adapters/old/bindings.yaml");
    assert.match(bindings, /applications-new/);
    assert.match(bindings, /fees-quote/);

    const committed = git(["show", "--name-only", "--format=", branch], dir);
    assert.match(committed, /tests\/adapters\/old\/index\.ts/);
    assert.match(committed, /tests\/adapters\/old\/bindings\.yaml/);
    // Derived from the contract already on main, not part of this stage's own collect
    // list, so it never lands in bind-adapter's own commit.
    assert.ok(!committed.includes("tests/generated/"), committed);
  } finally {
    delete process.env.SDLC_ORACLE; delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run bind-adapter --target old: a mock bindings file missing one observation fails naming it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-bind-adapter-missing-"));
  const { dir, prevEgress } = await makeReadyForBindAdapter(tmp);
  writeOldOracleLocal(dir);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-bind-adapter-missing-mock-"));
  writeFileSync(join(mockDir, "bind-adapter.json"), JSON.stringify({
    text: "bound everything but forgot the fee amount observation",
    files: {
      "tests/adapters/old/index.ts": "export default function create() { return {} as unknown; }\n",
      "tests/adapters/old/bindings.yaml":
        "target: old\npages:\n  applications-new:\n    actions: { submit: bound }\n    observations: { status: bound }\n"
        + "  fees-quote:\n    actions: { calculate: bound }\n    observations: {}\n",
    },
  }));
  process.env.SDLC_ORACLE = "mock";
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "bind-adapter", { target: "old" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m.includes("fees-quote.amount")), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(bind-adapter\): post-checks failed/);
  } finally {
    delete process.env.SDLC_ORACLE; delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

// The prompt carries the running address rather than only naming the variable that holds
// it. This session has no shell by design and so no way to read an environment variable at
// all; told only where the value lived, one run browsed an address out of the harness README
// instead. The variable is still passed, because the adapter's own code reads it at run
// time. A prompt is never written to disk or committed, so a machine-local port in one is
// not the thing decision 0006 keeps out of the repository.
test("sdlc run bind-adapter --target old --dry-run: names the mcp server, the env variables, and the address the target is actually running at", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-bind-adapter-dry-"));
  const { dir, prevEgress } = await makeReadyForBindAdapter(tmp);
  writeOldOracleLocal(dir);
  process.env.SDLC_ORACLE = "mock";
  const logs = [];
  const origLog = console.log;
  try {
    console.log = (...a) => logs.push(a.join(" "));
    const r = await runStage(dir, "bind-adapter", { target: "old", dryRun: true });
    console.log = origLog;
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    const printed = logs.join("\n");
    assert.match(printed, /^mcp: playwright$/m);
    assert.match(printed, /^env: SDLC_TARGET_URL, SDLC_MAIL_API, SDLC_SANDBOX_PASSWORD$/m);
    assert.ok(printed.includes("http://localhost:3100"), printed);
    assert.doesNotMatch(printed, /does not name/, "a first binding has no bindings file to be out of date");
  } finally {
    console.log = origLog;
    delete process.env.SDLC_ORACLE;
    restoreEgress(prevEgress);
  }
});

// An adapter on main that the contract has since outgrown is rebound by a run asked to bind
// exactly what the post-check will demand: every member the contract declares that the
// bindings file does not name, and every name it carries that the contract no longer declares.
test("sdlc run bind-adapter --target old --dry-run: an adapter the contract has outgrown is asked for the members it does not bind", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-bind-adapter-stale-"));
  const { dir, prevEgress } = await makeReadyForBindAdapter(tmp);
  writeOldOracleLocal(dir);
  mkdirSync(join(dir, "tests", "adapters", "old"), { recursive: true });
  writeFileSync(join(dir, "tests", "adapters", "old", "index.ts"), "export default 1;\n");
  writeFileSync(join(dir, "tests", "adapters", "old", "bindings.yaml"),
    "target: old\npages:\n  applications-new:\n    actions: { submit: bound, submit_proposal: bound }\n    observations: { status: bound }\n"
    + "  fees-quote:\n    actions: { calculate: bound, refund: bound }\n    observations: {}\n");
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "an adapter bound before the contract changed (test)"], dir);
  process.env.SDLC_ORACLE = "mock";
  const logs = [];
  const origLog = console.log;
  try {
    console.log = (...a) => logs.push(a.join(" "));
    const r = await runStage(dir, "bind-adapter", { target: "old", dryRun: true });
    console.log = origLog;
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    const printed = logs.join("\n");
    assert.match(printed, /The contract declares 1 action or observation that tests\/adapters\/old\/bindings\.yaml does not name/);
    assert.match(printed, /^- fees-quote: amount \(observation\)$/m);
    assert.match(printed, /^- fees-quote: refund \(action\)$/m);
    assert.match(printed, /The bindings already there stand/);
  } finally {
    console.log = origLog;
    delete process.env.SDLC_ORACLE;
    restoreEgress(prevEgress);
  }
});

test("sdlc run bind-adapter --target old: probe fails promptly when no server listens on the configured port", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-bind-adapter-probe-timeout-"));
  const { dir, prevEgress } = await makeReadyForBindAdapter(tmp);

  // Obtain an unused port by creating and immediately closing a server.
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const unusedPort = server.address().port;
  server.close();

  const baseUrlWithPort = `http://127.0.0.1:${unusedPort}`;

  // Override both the oracle config and local oracle state to point to the unused port.
  const cfgPath = join(dir, ".sdlc", "config.yaml");
  const cfg = readFileSync(cfgPath, "utf8");
  const updatedCfg = cfg.replace(/base_url: http:\/\/localhost:\d+/, `base_url: ${baseUrlWithPort}`);
  writeFileSync(cfgPath, updatedCfg);

  // Update the local oracle state with the same port.
  writeLocal(dir, "old", {
    target: "old",
    base_url: baseUrlWithPort,
    mail_api: `http://127.0.0.1:${unusedPort + 100}`,
    ports: { app: unusedPort, db: unusedPort + 100, mail_api: unusedPort + 200 },
    compose_project: "sdlc-permit-intake-old",
  });

  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "update oracle config with unused port (test)"], dir);

  // Do NOT set SDLC_ORACLE=mock so the probe actually runs.
  try {
    const startTime = Date.now();
    const r = await runStage(dir, "bind-adapter", { target: "old" });
    const duration = Date.now() - startTime;

    // Probe should fail because no server listens on the port.
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /did not answer/.test(m)), r.messages.join(" | "));

    // Probe should complete within a reasonable time: 5s in-script timeout +
    // 6s OS-level timeout, plus a small overhead, should resolve in ~6-7s max.
    assert.ok(duration < 10000, `probe took ${duration}ms, expected < 10000ms`);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    restoreEgress(prevEgress);
  }
});

test("sdlc run bind-adapter --target old: a sandbox-idp target with no sandbox password is refused before any agent turn", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-bind-adapter-nopw-"));
  const { dir, prevEgress } = await makeProjectWithOracle(tmp);
  writeOldOracleLocal(dir);
  const prevPw = process.env.SDLC_SANDBOX_PASSWORD;
  delete process.env.SDLC_SANDBOX_PASSWORD;
  process.env.SDLC_ORACLE = "mock";
  try {
    const r = await runStage(dir, "bind-adapter", { target: "old" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m === "export SDLC_SANDBOX_PASSWORD before binding against old"), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    process.env.SDLC_SANDBOX_PASSWORD = prevPw;
    delete process.env.SDLC_ORACLE;
    restoreEgress(prevEgress);
  }
});

test("sdlc run bind-adapter: a session-route target needs no sandbox password", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-bind-adapter-sessionroute-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const cfgPath = join(dir, ".sdlc", "config.yaml");
  writeFileSync(cfgPath, readFileSync(cfgPath, "utf8") + ORACLE_BLOCK.replace("identity: sandbox-idp", "identity: session-route"));
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "session-route oracle (test)"], dir);
  const prevPw = process.env.SDLC_SANDBOX_PASSWORD;
  delete process.env.SDLC_SANDBOX_PASSWORD;
  process.env.SDLC_ORACLE = "mock";
  try {
    // The oracle is deliberately not up, so this stops at the target-up check — the
    // sandbox-password check has nothing to say about a session-route target.
    const r = await runStage(dir, "bind-adapter", { target: "old" });
    assert.equal(r.ok, false);
    assert.ok(!r.messages.some((m) => m.includes("SDLC_SANDBOX_PASSWORD")), r.messages.join(" | "));
  } finally {
    process.env.SDLC_SANDBOX_PASSWORD = prevPw;
    delete process.env.SDLC_ORACLE;
    restoreEgress(prevEgress);
  }
});

// --- the contract post-checks that only fire on a configured project ---
//
// `fixture.config.yaml` configures neither `sources.old` nor an oracle, so three of
// `contract`'s post-checks pass trivially in every test above. Each needs a fixture
// variant, and each is judged on a mock contract response that leaves out exactly the
// one thing that check is about.

// A local git repo standing in for the old application, so the `with-sources` workspace
// `contract` runs in when `sources.old` is configured has something `git clone` reaches.
function makeOldRepo(tmp) {
  const dir = join(tmp, "old-repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# the old application\n");
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.org"], dir);
  git(["config", "user.name", "t"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "old app"], dir);
  return { dir, commit: git(["rev-parse", "HEAD"], dir) };
}

function configWith(tmp, name, extra) {
  const path = join(tmp, `${name}.config.yaml`);
  writeFileSync(path, readFileSync(FROM, "utf8") + extra);
  return path;
}

// The contract a mock writes when nothing is wrong with it: both fixture pages carrying
// their domains, both personas signing in the way the fixture's identity needs, the
// observables, and a seed with a manifest.
const GOOD_CONTRACT_FILES = {
  "spec/contract/surface.yaml":
    "pages:\n  - id: applications-new\n    domain: applications\n    route: /applications\n    title: \"New permit application\"\n"
    + "    actions: { submit: { test_id: null } }\n    observations: { status: { test_id: null } }\n"
    + "  - id: fees-quote\n    domain: fees\n    route: /fees/quote\n    title: \"Fee quote\"\n"
    + "    actions: { calculate: { test_id: null } }\n    observations: { amount: { test_id: null } }\n",
  "spec/contract/personas.yaml":
    "personas:\n  - id: applicant\n    can: [submit a permit application]\n    sign_in: { sandbox-idp: { username: applicant-1 } }\n"
    + "  - id: anonymous-visitor\n    can: [view a fee quote]\n    sign_in: null\n",
  "spec/contract/observables.yaml": "email: { via: mail-catcher, api: \"${SDLC_MAIL_API}\" }\n",
  "tests/seed/001-users.sql": "INSERT INTO users (id, email) VALUES ('1', 'applicant-1@example.test');\n",
  "tests/seed/manifest.yaml": "users:\n  applicantOne: { id: \"1\", email: \"applicant-1@example.test\" }\n",
};

function mockContract(tmp, name, files) {
  const mockDir = mkdtempSync(join(tmpdir(), `sdlc-${name}-mock-`));
  writeFileSync(join(mockDir, "contract.json"), JSON.stringify({ text: `mock contract for ${name}`, files }));
  return mockDir;
}

async function runContractWithMock(dir, mockDir) {
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try { return await runStage(dir, "contract"); }
  finally { delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR; }
}

test("sdlc run contract: a project with sources.old and no openapi.yaml fails contract-openapi", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-openapi-"));
  const old = makeOldRepo(tmp);
  const from = configWith(tmp, "with-sources", `sources:\n  old: { repo: ${old.dir}, commit: ${old.commit} }\n`);
  const { dir, prevEgress } = await makeProject(tmp, from);
  // `sdlc new` lays down an empty `openapi.yaml` stub for the stage to fill in; this run
  // is about the file not being there at all.
  rmSync(join(dir, "spec", "contract", "openapi.yaml"));
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "no openapi stub (test)"], dir);
  try {
    const r = await runContractWithMock(dir, mockContract(tmp, "openapi", GOOD_CONTRACT_FILES));
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m === "spec/contract/openapi.yaml is missing"), r.messages.join(" | "));
  } finally { restoreEgress(prevEgress); }
});

test("sdlc run contract: a project with sources.old and an openapi.yaml with no paths fails contract-openapi", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-openapi-empty-"));
  const old = makeOldRepo(tmp);
  const from = configWith(tmp, "with-sources", `sources:\n  old: { repo: ${old.dir}, commit: ${old.commit} }\n`);
  const { dir, prevEgress } = await makeProject(tmp, from);
  try {
    const r = await runContractWithMock(dir, mockContract(tmp, "openapi-empty", {
      ...GOOD_CONTRACT_FILES,
      "spec/contract/openapi.yaml": "openapi: 3.1.0\ninfo: { title: nothing, version: \"0.0.0\" }\n",
    }));
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m === "spec/contract/openapi.yaml has no paths"), r.messages.join(" | "));
  } finally { restoreEgress(prevEgress); }
});

test("sdlc run contract: an accepted domain no surface page claims fails contract-domain-pages", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-domainpages-"));
  const { dir, prevEgress } = await makeProject(tmp);
  // One accepted criterion in `applications`, the state ratify leaves behind.
  writeFileSync(join(dir, "spec", "criteria-index.json"), JSON.stringify({
    generated_from: "",
    criteria: [{ id: "R-1.1", version: 1, statement: "A criterion.", state: "accepted", domain: "applications", file: "spec/domains/applications.md" }],
  }, null, 2) + "\n");
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "an accepted applications criterion (test)"], dir);
  try {
    const r = await runContractWithMock(dir, mockContract(tmp, "domainpages", {
      ...GOOD_CONTRACT_FILES,
      // Both pages carry `domain: fees`, so nothing on the surface reaches applications.
      "spec/contract/surface.yaml": GOOD_CONTRACT_FILES["spec/contract/surface.yaml"].replace("domain: applications", "domain: fees"),
    }));
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m === "no page in spec/contract/surface.yaml carries domain: for accepted domain(s): applications"), r.messages.join(" | "));
  } finally { restoreEgress(prevEgress); }
});

test("sdlc run contract: an oracle-configured project whose run writes no compose override fails contract-oracle-override", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-override-"));
  const { dir, prevEgress } = await makeProject(tmp);
  addOracleConfig(dir);
  try {
    const r = await runContractWithMock(dir, mockContract(tmp, "override", GOOD_CONTRACT_FILES));
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m === ".sdlc/oracle/compose.yml is missing"), r.messages.join(" | "));
  } finally { restoreEgress(prevEgress); }
});

test("sdlc run contract: a compose override using !override and !reset passes contract-oracle-override with no YAMLWarning", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-override-tags-"));
  const { dir, prevEgress } = await makeProject(tmp);
  addOracleConfig(dir);
  const warnings = [];
  const onWarning = (w) => warnings.push(w);
  process.on("warning", onWarning);
  try {
    const r = await runContractWithMock(dir, mockContract(tmp, "override-tags", {
      ...GOOD_CONTRACT_FILES,
      ".sdlc/oracle/compose.yml":
        "services:\n  app:\n    environment: !override\n      NODE_ENV: test\n    command: !reset []\n",
    }));
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.ok(!warnings.some((w) => /Unresolved tag/.test(w.message ?? String(w))), warnings.map((w) => w.message).join(" | "));
  } finally {
    process.off("warning", onWarning);
    restoreEgress(prevEgress);
  }
});

test("sdlc run contract: a genuinely malformed compose override still fails contract-oracle-override", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-override-malformed-"));
  const { dir, prevEgress } = await makeProject(tmp);
  addOracleConfig(dir);
  try {
    const r = await runContractWithMock(dir, mockContract(tmp, "override-malformed", {
      ...GOOD_CONTRACT_FILES,
      ".sdlc/oracle/compose.yml": "services:\n  app: [unterminated\n",
    }));
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m.includes(".sdlc/oracle/compose.yml is not valid YAML")), r.messages.join(" | "));
  } finally { restoreEgress(prevEgress); }
});

test("sdlc run contract: a seed row carrying a local home path fails the stage's own egress check, naming the file", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-egress-"));
  const { dir, prevEgress } = await makeProject(tmp);
  // Assembled from pieces so this file does not itself carry the pattern it is testing.
  const homePath = "/ho" + "me/someone/exports/users.csv";
  try {
    const r = await runContractWithMock(dir, mockContract(tmp, "egress", {
      ...GOOD_CONTRACT_FILES,
      "tests/seed/001-users.sql":
        `-- copied from ${homePath}\nINSERT INTO users (id, email) VALUES ('1', 'applicant-1@example.test');\n`,
    }));
    assert.equal(r.ok, false);
    // The file is uncommitted at post-check time — the whole reason the scan reaches
    // untracked files — and the message names it and the line.
    assert.ok(r.messages.some((m) => m.startsWith("tests/seed/001-users.sql:1:") && m.includes("local home path")), r.messages.join(" | "));
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(contract\): post-checks failed/);
  } finally { restoreEgress(prevEgress); }
});

// `contract` proves its override by bringing the oracle up and down from inside its own
// session, as its prompt tells it to. A real session is stood in for by a binary that does
// exactly that through the CLI, so the commands see the environment a session gives them.
// The pipeline's own lines about those calls are not the agent's change: the stage passes
// its scope check, nothing is committed to `main` while it runs, and the lines reach the
// run record the proposal carries.
test("sdlc run contract: the oracle brought up and down inside the session is not counted against the stage's scope", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-contract-oracle-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const cfgPath = join(dir, ".sdlc", "config.yaml");
  writeFileSync(cfgPath, `${readFileSync(cfgPath, "utf8")}
oracle:
  target: old
  compose: sources/old/docker-compose.yml
  base_url: http://localhost:3100
  identity: sandbox-idp
`);
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "the old target is the oracle (test)"], dir);
  mkdirSync(join(dir, "sources", "old"), { recursive: true });
  writeFileSync(join(dir, "sources", "old", "docker-compose.yml"), "");
  const head = git(["rev-parse", "HEAD"], dir);

  const root = mkdtempSync(join(tmpdir(), "sdlc-contract-oracle-claude-"));
  const bin = join(root, "fake-claude");
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    'import { execFileSync } from "node:child_process";',
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { dirname } from "node:path";',
    'const reply = (text) => process.stdout.write(JSON.stringify({ is_error: false, result: text, num_turns: 1, session_id: "s1" }));',
    'if (process.env.SDLC_STAGE !== "contract") { reply("ok"); process.exit(0); }',
    `const mock = JSON.parse(readFileSync(${JSON.stringify(join(MOCK_DIR, "contract.json"))}, "utf8"));`,
    'const files = { ...mock.files, ".sdlc/oracle/compose.yml": "services: {}\\n" };',
    "for (const [rel, content] of Object.entries(files)) { mkdirSync(dirname(rel), { recursive: true }); writeFileSync(rel, content); }",
    'for (const sub of ["up", "down"]) execFileSync(process.execPath, [process.env.SDLC_BIN, "oracle", sub], { stdio: "ignore" });',
    "reply(mock.text);",
  ].join("\n"));
  chmodSync(bin, 0o755);
  process.env.SDLC_CLAUDE_BIN = bin;
  process.env.SDLC_CLAUDE_HOME = join(root, "claude-home");
  process.env.SDLC_CREDENTIALS = join(root, "no-such-credentials.json");
  process.env.SDLC_ORACLE = "mock";
  process.env.SDLC_MOCK_DIR = mkdtempSync(join(tmpdir(), "sdlc-contract-oracle-calls-"));
  try {
    const r = await runStage(dir, "contract");
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.equal(r.proposal.branch, "proposal/contract-v1");
    // The oracle really was driven: the mock recorded its compose calls.
    assert.ok(existsSync(join(process.env.SDLC_MOCK_DIR, "oracle-calls.json")));
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.equal(git(["log", "--format=%s", `${head}..main`], dir).split("\n").filter((l) => /oracle/.test(l)).length, 0,
      "no oracle commit landed on main while the stage ran");
    const day = new Date().toISOString().slice(0, 10);
    const runs = onBranch(dir, r.proposal.branch, `.sdlc/runs/${day}.md`);
    assert.match(runs, /oracle up old[^\n]*\n- [^\n]*oracle down old\n- [^\n]*run contract: ok/);
  } finally {
    for (const k of ["SDLC_CLAUDE_BIN", "SDLC_CLAUDE_HOME", "SDLC_CREDENTIALS", "SDLC_ORACLE", "SDLC_MOCK_DIR"]) delete process.env[k];
    restoreEgress(prevEgress);
  }
});

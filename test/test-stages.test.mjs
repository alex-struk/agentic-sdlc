// test/test-stages.test.mjs — the `contract` stage.
//
// Builds its own minimal fixture project the way test/spec-stages.test.mjs does, rather
// than importing that file: each test file owns its own setup so a change to one never
// has to reckon with what another file's helpers happen to assume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { rule } from "../src/commands/rule.mjs";
import { propose } from "../src/commands/propose.mjs";
import { writeLocal } from "../src/oracle/ports.mjs";
import { STAGES, PROFILES } from "../src/profiles.mjs";

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
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/contract-v1");
    assert.equal(git(["status", "--porcelain"], dir), "");

    const proposalText = readFileSync(join(dir, ".sdlc/proposals/contract-v1.md"), "utf8");
    assert.match(proposalText, /gate: G1/);
    assert.match(proposalText, /"Is this the contract the tests will act through\?"/);

    const surfaceText = readFileSync(join(dir, "spec/contract/surface.yaml"), "utf8");
    assert.match(surfaceText, /applications-new/);
    assert.match(surfaceText, /fees-quote/);

    const personasText = readFileSync(join(dir, "spec/contract/personas.yaml"), "utf8");
    assert.match(personasText, /applicant/);
    assert.match(personasText, /anonymous-visitor/);

    assert.ok(existsSync(join(dir, "tests/seed/001-users.sql")));
    const manifestText = readFileSync(join(dir, "tests/seed/manifest.yaml"), "utf8");
    assert.match(manifestText, /applicantOne/);

    assert.ok(existsSync(join(dir, ".sdlc/journal/001-contract.md")));
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
    const personasText = readFileSync(join(dir, "spec/contract/personas.yaml"), "utf8");
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
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/derive-tests-applications");
    assert.equal(git(["status", "--porcelain"], dir), "");

    const proposalText = readFileSync(join(dir, ".sdlc/proposals/derive-tests-applications.md"), "utf8");
    assert.match(proposalText, /gate: G3/);
    assert.match(proposalText, /"Do these tests follow from the applications criteria and from nothing else\?"/);

    assert.ok(existsSync(join(dir, "tests/acceptance/applications/R-1.1.spec.ts")));
    assert.ok(existsSync(join(dir, "tests/acceptance/applications/R-1.2.spec.ts")));
    const notTestable = readFileSync(join(dir, "tests/acceptance/not-testable.yaml"), "utf8");
    assert.match(notTestable, /R-1\.3/);
    assert.ok(existsSync(join(dir, "tests/generated/surface.d.ts")));

    const committed = git(["show", "--name-only", "--format=", "HEAD"], dir);
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
      "tests/acceptance/not-testable.yaml": "criteria:\n  - { id: R-1.3, version: 1, reason: \"no observation exposes the recalculated fee amount\" }\n",
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
      "tests/acceptance/not-testable.yaml": "criteria:\n  - { id: R-1.3, version: 1, reason: \"no observation exposes the recalculated fee amount\" }\n",
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
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/bind-adapter-old");
    assert.equal(git(["status", "--porcelain"], dir), "");

    const proposalText = readFileSync(join(dir, ".sdlc/proposals/bind-adapter-old.md"), "utf8");
    assert.match(proposalText, /gate: G3/);
    assert.match(proposalText, /"Does this adapter bind every surface action and observation on old, and nothing else\?"/);

    assert.ok(existsSync(join(dir, "tests/adapters/old/index.ts")));
    const bindings = readFileSync(join(dir, "tests/adapters/old/bindings.yaml"), "utf8");
    assert.match(bindings, /applications-new/);
    assert.match(bindings, /fees-quote/);

    const committed = git(["show", "--name-only", "--format=", "HEAD"], dir);
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

test("sdlc run bind-adapter --target old --dry-run: prints the mcp server and the env variable names, never the base URL value", async () => {
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
    assert.ok(!printed.includes("http://localhost:3100"), printed);
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

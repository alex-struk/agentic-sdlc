// test/derive-revise.test.mjs — `sdlc run derive-tests --domain <d> --revise`.
//
// Builds its own minimal fixture project the way test/test-stages.test.mjs and
// test/revise.test.mjs do, rather than importing either: each test file owns its own
// setup so a change to one never has to reckon with what another file's helpers assume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOk } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { rule, ruleByAgent } from "../src/commands/rule.mjs";
import { loadContract, generateTypes } from "../src/spec/surface.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;
const MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;

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
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "fill constitution"], dir);
  return { dir, prevEgress };
}

function restoreEgress(prev) {
  if (prev === undefined) delete process.env.SDLC_EGRESS_NAMES;
  else process.env.SDLC_EGRESS_NAMES = prev;
}

// Three permanent criteria, minted directly rather than through a real `sdlc run
// archaeology` turn — the same shortcut test/test-stages.test.mjs takes, since these
// tests care only about the ratified result, not the path that produced it.
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
  const { propose } = await import("../src/commands/propose.mjs");
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
// main, which the `spec-only` workspace `derive-tests` runs in needs.
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

// A canned reply for the reviewer persona (`sdlc rule <name> --by agent:reviewer`, which
// `ruleByAgent` drives): the whole reply text ending in the fenced JSON block
// `parseVerdict` reads. Conditions are only ever recorded this way — a human `rule --return
// --note "..."` writes a single free-text `note` and no structured `conditions` list at
// all — so a real, multi-condition return needs the agent path.
function mockReviewerVerdict(verdict, rationale, conditions) {
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-rule-derive-"));
  const block = JSON.stringify({ verdict, rationale, conditions });
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify({ text: `Reviewed the derive-tests proposal against its criteria.\n\n\`\`\`json\n${block}\n\`\`\`` }));
  return mockDir;
}

const RETURN_RATIONALE = "R-1.1's test asserts the exact wording of the rejection error, which the criterion never states, and R-1.3's not-testable reason does not say what is actually missing.";
const RETURN_CONDITIONS = [
  "R-1.1: drop the assertion on the error message text; the criterion only says the application is rejected with an error and no record created",
  "R-1.3: reword the not-testable reason to say no page on the surface observes the recalculated fee amount",
];

// The state every `--revise` test starts from: a domain with its tests derived
// (`derive-tests-applications`, R-1.1 and R-1.2 tested, R-1.3 not-testable) and that
// proposal returned by the reviewer persona rather than approved — exactly the situation
// `--revise` exists to act on. Ends back on `main`, the same way a person would be
// standing after ruling a return by hand.
async function buildReturnedDeriveTests(dir, { rationale = RETURN_RATIONALE, conditions = RETURN_CONDITIONS } = {}) {
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  const first = await runStage(dir, "derive-tests", { domain: "applications" });
  if (!first.ok) throw new Error(`derive-tests failed: ${JSON.stringify(first.messages)}`);
  delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

  const mockRuleDir = mockReviewerVerdict("return", rationale, conditions);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockRuleDir;
  const ruled = await ruleByAgent(dir, "derive-tests-applications", { persona: "reviewer" });
  if (ruled.verdict !== "return") throw new Error(`expected a return, got ${ruled.verdict}`);
  delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
  git(["checkout", "-q", "main"], dir);
}

// The agent turn every "real run" test below drives: drops R-1.1's error-message
// assertion per the first condition, rewords R-1.3's not-testable reason per the second,
// and leaves R-1.2 — named by neither condition — out of `files` entirely, so whatever
// the workspace already carries for it is what comes back untouched.
function standardReviseMockDir() {
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-derive-revise-mock-"));
  writeFileSync(join(mockDir, "derive-tests.json"), JSON.stringify({
    text: "Dropped the error-message assertion from R-1.1 per the first condition, and reworded R-1.3's not-testable reason per the second. R-1.2 was not named by either condition and is untouched.",
    files: {
      "tests/acceptance/applications/R-1.1.spec.ts":
        "// criterion: @R-1.1 v1\n// provenance: blind, spec@0000000000000000000000000000000000000a, derived 2026-09-06\n"
        + "import { test, expect, persona } from \"../../fixtures\";\n\n"
        + "test(\"When an applicant submits a permit application, the system shall reject it unless the applicant is at least 19 years old.\", async ({ surface }) => {\n"
        + "  await surface.signIn(persona.applicant);\n  await surface.applicationsNew.submit({ age: 17 });\n"
        + "  expect(await surface.applicationsNew.status()).toBe(\"rejected\");\n});\n",
      "tests/acceptance/not-testable.yaml":
        "criteria:\n  - { id: R-1.3, version: 1, reason: \"no page on the surface observes the recalculated fee amount\" }\n",
    },
  }));
  return mockDir;
}

test("derive-tests --revise: with no returned ruling, fails the pre-check up front", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-revise-none-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  try {
    const r = await runStage(dir, "derive-tests", { domain: "applications", revise: true });
    assert.equal(r.ok, false);
    assert.deepEqual(r.messages, ["derive-tests --revise: no returned ruling for applications to revise from"]);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /run\(derive-tests\): pre-checks failed/);
  } finally {
    restoreEgress(prevEgress);
  }
});

test("derive-tests --revise --dry-run: prints the return's rationale and conditions, and leaves the branch and main untouched", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-revise-dryrun-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  const logs = [];
  const origLog = console.log;
  try {
    await buildReturnedDeriveTests(dir);
    const mainBefore = git(["rev-parse", "main"], dir);

    console.log = (...a) => logs.push(a.join(" "));
    const r = await runStage(dir, "derive-tests", { domain: "applications", revise: true, dryRun: true });
    console.log = origLog;

    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.equal(r.dryRun, true);
    const printed = logs.join("\n");
    assert.ok(printed.includes(RETURN_RATIONALE), "the printed prompt quotes the return's rationale");
    for (const c of RETURN_CONDITIONS) assert.ok(printed.includes(c), `the printed prompt quotes condition: ${c}`);

    // A dry run writes nothing at all: the returned ruling is only found and quoted,
    // never recorded — its gate file stays on the spent branch, `main` gains no commit,
    // and the branch is neither renamed nor deleted.
    assert.equal(existsSync(join(dir, ".sdlc/gates/derive-tests-applications.yaml")), false);
    assert.equal(gitOk(["rev-parse", "--verify", "proposal/derive-tests-applications"], dir), true);
    assert.equal(gitOk(["rev-parse", "--verify", "returned/derive-tests-applications"], dir), false);
    assert.equal(git(["rev-parse", "main"], dir), mainBefore, "main gained no commit");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    console.log = origLog;
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("derive-tests --revise: a real run records the return on main, renames the branch to returned/…, and opens proposal/derive-tests-applications-2", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-revise-real-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  try {
    await buildReturnedDeriveTests(dir);

    // The workspace this run builds overlays `tests/acceptance/applications/` and
    // `tests/acceptance/not-testable.yaml` from the returned branch's own commit onto an
    // otherwise ordinary `HEAD` archive, so the agent starts from exactly what was
    // proposed for this domain — R-1.1 and R-1.2 tested, R-1.3 not-testable — and this
    // mock changes only what the two conditions name: R-1.1's assertion, and R-1.3's
    // reason. R-1.2 is left out of `files` entirely, so whatever the workspace already
    // carries for it (the untouched original) is what comes back.
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = standardReviseMockDir();
    const r = await runStage(dir, "derive-tests", { domain: "applications", revise: true });
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    // The record commit landed on `main` before the agent turn even ran (it is part of
    // the pre-check), the spent branch is renamed rather than deleted (its tests live
    // nowhere else), and the fresh revision proposal is open.
    const log = git(["log", "--pretty=%s", "main"], dir).split("\n");
    assert.ok(log.some((l) => l === "record(G3): derive-tests-applications returned"), log.join(" | "));
    assert.equal(gitOk(["cat-file", "-e", "main:.sdlc/gates/derive-tests-applications.yaml"], dir), true);
    assert.equal(gitOk(["rev-parse", "--verify", "proposal/derive-tests-applications"], dir), false);
    assert.equal(gitOk(["rev-parse", "--verify", "returned/derive-tests-applications"], dir), true);

    assert.equal(r.proposal?.name, "derive-tests-applications-2");
    assert.equal(r.proposal?.gate, "G3");
    assert.equal(r.proposal?.branch, "proposal/derive-tests-applications-2");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/derive-tests-applications-2");

    const proposalText = readFileSync(join(dir, ".sdlc/proposals/derive-tests-applications-2.md"), "utf8");
    assert.match(proposalText, /"Do the revised applications tests now follow from their criteria and from nothing else\?"/);

    const r11 = readFileSync(join(dir, "tests/acceptance/applications/R-1.1.spec.ts"), "utf8");
    assert.ok(!r11.includes("toBe(\"rejected\")") || !r11.toLowerCase().includes("message"), "R-1.1 no longer asserts the error message text");
    const notTestable = readFileSync(join(dir, "tests/acceptance/not-testable.yaml"), "utf8");
    assert.match(notTestable, /no page on the surface observes/);
    // R-1.2's spec file — named by neither condition — survived the revision unchanged.
    assert.ok(existsSync(join(dir, "tests/acceptance/applications/R-1.2.spec.ts")));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("derive-tests --revise: a mock that also changes the unnamed R-1.2 file fails the drift post-check, naming it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-revise-drift-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  try {
    await buildReturnedDeriveTests(dir);

    const mockDir = mkdtempSync(join(tmpdir(), "sdlc-derive-revise-drift-mock-"));
    writeFileSync(join(mockDir, "derive-tests.json"), JSON.stringify({
      text: "Fixed R-1.1 per its condition, and also tidied up R-1.2's test while in there.",
      files: {
        "tests/acceptance/applications/R-1.1.spec.ts":
          "// criterion: @R-1.1 v1\n// provenance: blind, spec@0000000000000000000000000000000000000a, derived 2026-09-06\n"
          + "import { test, expect, persona } from \"../../fixtures\";\n\n"
          + "test(\"When an applicant submits a permit application, the system shall reject it unless the applicant is at least 19 years old.\", async ({ surface }) => {\n"
          + "  await surface.signIn(persona.applicant);\n  await surface.applicationsNew.submit({ age: 17 });\n"
          + "  expect(await surface.applicationsNew.status()).toBe(\"rejected\");\n});\n",
        "tests/acceptance/not-testable.yaml":
          "criteria:\n  - { id: R-1.3, version: 1, reason: \"no page on the surface observes the recalculated fee amount\" }\n",
        // Not named by either condition — this drifts and must be caught.
        "tests/acceptance/applications/R-1.2.spec.ts":
          "// criterion: @R-1.2 v1\n// provenance: blind, spec@0000000000000000000000000000000000000a, derived 2026-09-07\n"
          + "import { test, expect, persona } from \"../../fixtures\";\n\n"
          + "test(\"tidied up\", async ({ surface }) => {\n  await surface.signIn(persona.applicant);\n"
          + "  await surface.applicationsNew.submit({ age: 25 });\n  expect(await surface.applicationsNew.status()).toBe(\"accepted\");\n});\n",
      },
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDir;
    const r = await runStage(dir, "derive-tests", { domain: "applications", revise: true });
    assert.equal(r.ok, false);
    assert.ok(
      r.messages.some((m) => m.includes("R-1.2.spec.ts") && m.includes("no condition named it")),
      r.messages.join(" | "),
    );
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(derive-tests\): post-checks failed/);

    // The return was still recorded (it is a pre-check, run before the agent turn), and
    // the branch is still renamed — only the fresh proposal failed to open.
    const log = git(["log", "--pretty=%s", "main"], dir).split("\n");
    assert.ok(log.some((l) => l === "record(G3): derive-tests-applications returned"), log.join(" | "));
    assert.equal(gitOk(["rev-parse", "--verify", "returned/derive-tests-applications"], dir), true);
    assert.equal(gitOk(["rev-parse", "--verify", "proposal/derive-tests-applications-2"], dir), false);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("derive-tests --revise: the shared attestations.yaml, changed on main after the return, is left untouched", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-revise-scope-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  try {
    // Present on `main` — and so on the returned branch's own snapshot too — before the
    // applications proposal is even opened. `attestations.yaml` sits directly under
    // `tests/acceptance/`, next to every domain's own folder, exactly like `redo.yaml` —
    // shared bookkeeping no domain's own revision has any business touching.
    writeFileSync(join(dir, "tests/acceptance/attestations.yaml"), "attestations: []\n");
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "attestations: none yet"], dir);

    await buildReturnedDeriveTests(dir);

    // `main` moves the file on after the return — the case the returned branch's snapshot
    // never saw and must never overwrite.
    writeFileSync(
      join(dir, "tests/acceptance/attestations.yaml"),
      "attestations:\n  - { file: \"tests/acceptance/applications/R-1.2.spec.ts\", by: \"tech-lead\" }\n",
    );
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "attestations: add one"], dir);

    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = standardReviseMockDir();
    const r = await runStage(dir, "derive-tests", { domain: "applications", revise: true });
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    assert.equal(
      readFileSync(join(dir, "tests/acceptance/attestations.yaml"), "utf8"),
      "attestations:\n  - { file: \"tests/acceptance/applications/R-1.2.spec.ts\", by: \"tech-lead\" }\n",
    );
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("derive-tests --revise: tests/generated reflects HEAD's own contract, not the returned branch's stale one", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-revise-generated-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  try {
    await buildReturnedDeriveTests(dir);

    // The contract moves on after the branch was cut — a persona no returned proposal
    // ever saw, added straight to `main`.
    const personasPath = join(dir, "spec/contract/personas.yaml");
    writeFileSync(
      personasPath,
      `${readFileSync(personasPath, "utf8")}  - id: fee-clerk\n    can: [review a fee quote]\n    sign_in: { sandbox-idp: { username: fee-clerk-1 } }\n`,
    );
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "contract: add fee-clerk persona"], dir);

    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = standardReviseMockDir();
    const r = await runStage(dir, "derive-tests", { domain: "applications", revise: true });
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    // `prepare` regenerates `tests/generated/*` inside the workspace from `spec/contract`
    // — always archived from `HEAD`, never from the returned branch's own commit — so
    // what lands back in the project matches a fresh `generateTypes(loadContract(...))`
    // read off the commit this run just made, fee-clerk included.
    const expected = generateTypes(loadContract(dir));
    for (const [relPath, text] of Object.entries(expected)) {
      assert.equal(readFileSync(join(dir, relPath), "utf8"), text, relPath);
    }
    assert.match(readFileSync(join(dir, "tests/generated/personas.ts"), "utf8"), /fee-clerk/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("derive-tests --revise: a domain whose criteria are all superseded fails before the return is recorded", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-derive-revise-superseded-"));
  const { dir, prevEgress } = await makeReadyForDeriveTests(tmp);
  try {
    await buildReturnedDeriveTests(dir);

    // Every criterion the applications domain has is superseded after the return —
    // `ratify`'s own defect handling would normally do this by rewriting the domain file
    // and re-running `ratify`; written straight to the index here since only its effect
    // on `derive-tests`'s own pre-check ordering is under test.
    const idxPath = join(dir, "spec/criteria-index.json");
    const index = JSON.parse(readFileSync(idxPath, "utf8"));
    for (const c of index.criteria) if (c.domain === "applications") c.supersededBy = `${c.id}-replacement`;
    writeFileSync(idxPath, `${JSON.stringify(index, null, 2)}\n`);
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "supersede every applications criterion"], dir);

    const r = await runStage(dir, "derive-tests", { domain: "applications", revise: true });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m.includes("has no accepted criteria")), r.messages.join(" | "));

    // Nothing about the return was recorded: the branch is still open under its original
    // name, and no `record(G3)` commit landed on `main`.
    assert.equal(gitOk(["rev-parse", "--verify", "proposal/derive-tests-applications"], dir), true);
    assert.equal(gitOk(["rev-parse", "--verify", "returned/derive-tests-applications"], dir), false);
    const log = git(["log", "--pretty=%s", "main"], dir).split("\n");
    assert.ok(!log.some((l) => l.startsWith("record(G3):")), log.join(" | "));
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /run\(derive-tests\): pre-checks failed/);
  } finally {
    restoreEgress(prevEgress);
  }
});

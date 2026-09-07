// test/test-stages.test.mjs — the `contract` stage.
//
// Builds its own minimal fixture project the way test/spec-stages.test.mjs does, rather
// than importing that file: each test file owns its own setup so a change to one never
// has to reckon with what another file's helpers happen to assume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { rule } from "../src/commands/rule.mjs";
import { STAGES, PROFILES } from "../src/profiles.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;
const MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;

// Isolates the egress name list the same way test/spec-stages.test.mjs does: `init` (run
// as part of `newProject`) seeds the default list under the real home directory unless
// this is set first, and an existing-but-empty file wins the lookup outright.
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

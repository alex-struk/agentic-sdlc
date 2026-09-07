import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { ruleByAgent } from "../src/commands/rule.mjs";
import { propose } from "../src/commands/propose.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;

// G1 rebound from the fixture's ordinary human holder to `agent:product-owner`, the same
// edit `test/ratify.test.mjs` and `test/rule-agent.test.mjs` make for their own G1
// exercises — needed so a mocked persona reply, not a human `--by`, is what rules
// `contract-v1` below. Unlike `test/ratify.test.mjs`'s own helper, this carries no
// `sources.old`: nothing here runs the real `archaeology` or `contract` stage, so there is
// no old application for either one to read.
function configWithAgentG1(tmp) {
  const base = readFileSync(FROM, "utf8").replace(
    'G1: { holder: tech-lead }',
    'G1: { holder: "agent:product-owner", escalate_to: tech-lead }',
  );
  const path = join(tmp, "fixture-agent-g1.config.yaml");
  writeFileSync(path, base);
  return path;
}

async function makeProject(tmp) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  const dir = join(tmp, "permit-intake-contract-conditions");
  await newProject({ dir, from: configWithAgentG1(tmp) });
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

// Stands in for what a real `archaeology --domain <d>` pass, ruled and ratified once
// already, would have left behind: the domain file and an approved `archaeology-<d>`
// gate, committed on `main`. Built directly rather than run through the real stage
// (`test/rule-agent.test.mjs` uses the same shortcut for its own G1 exercises) because
// this test is about `ratify`'s reading of a *contract* ruling, not about archaeology or
// a domain's first ratify pass, and going through mocked agent turns for both would only
// add fixture weight nothing here depends on.
function seedDomain(dir, domain, domainText) {
  mkdirSync(join(dir, "spec", "domains"), { recursive: true });
  writeFileSync(join(dir, `spec/domains/${domain}.md`), domainText);
  mkdirSync(join(dir, ".sdlc", "gates"), { recursive: true });
  writeFileSync(join(dir, `.sdlc/gates/archaeology-${domain}.yaml`), "gate: G1\nverdict: approve\nconditions: []\n");
}

test("a contract-v1 ruling's conditions are applied by each named id's own domain, ignoring ids that belong to another domain", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-contract-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    // `applications` (ordinal 1 in `project.domains: [applications, fees]`) already
    // ratified to R-1.1; `fees` (ordinal 2) still holds a recovered, unconfirmed
    // criterion.
    seedDomain(dir, "applications",
      "# applications\n\n### R-1.1 · v1 · confirmed · recovered\n"
      + "When an applicant submits a permit application, the system rejects it unless the applicant is at least 19 years old.\n"
      + "- cites: src/routes.js:4\n- reconciliation: aligned\n- state: accepted\n");
    seedDomain(dir, "fees",
      "# fees\n\n### D-fees-2 · v1 · inferred · authored\n"
      + "The system waives the intake fee when the applicant already holds an active permit in the same category.\n");
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "fixture: applications ratified to R-1.1, fees recovered to D-fees-2"], dir);

    // `contract-v1`'s ruling names one id from each domain in a single pass, exactly as
    // the product-owner persona rules the real `contract` stage's one G1 proposal: an
    // `edit` on the permanent `applications` id, and a `confirm` on the provisional
    // `fees` one.
    propose(dir, "contract-v1", {
      gate: "G1",
      question: "Is this the contract the tests will act through?",
      recommendation: "fixture contract ruling for the readRulings/contract-conditions test",
    });
    process.env.SDLC_EXECUTOR = "mock";
    const ownerMockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-owner-contract-"));
    writeFileSync(join(ownerMockDir, "rule.json"), JSON.stringify({
      text: '```json\n' + JSON.stringify({
        verdict: "approve",
        rationale: "tightened the age wording while writing the contract; the fee waiver is confirmed by the intake flow",
        conditions: [
          "edit R-1.1: When an applicant submits a permit application, the system rejects it outright unless the applicant is at least 19 years old on the date of submission.",
          "confirm D-fees-2",
        ],
      }) + '\n```',
    }));
    process.env.SDLC_MOCK_DIR = ownerMockDir;
    const ruling = await ruleByAgent(dir, "contract-v1", { persona: "product-owner" });
    assert.equal(ruling.verdict, "approve");
    delete process.env.SDLC_EXECUTOR;
    delete process.env.SDLC_MOCK_DIR;
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");

    // `ratify --domain applications` applies the edit — statement replaced, version 2 —
    // and never touches fees: the `confirm D-fees-2` condition belongs to a different
    // domain's ordinal/id and is filtered out before `applyConditions` ever sees it.
    const appRun = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(appRun.ok, true, JSON.stringify(appRun.messages));
    const appsText = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(appsText, /### R-1\.1 · v2 · confirmed · recovered/);
    assert.match(appsText, /rejects it outright unless the applicant is at least 19 years old on the date of submission\./);
    assert.match(readFileSync(appRun.journal, "utf8"), /contract-v1/, "the journal names the contract gate that contributed the edit");

    const feesTextBefore = readFileSync(join(dir, "spec/domains/fees.md"), "utf8");
    assert.match(feesTextBefore, /### D-fees-2 · v1 · inferred · authored/, "fees is untouched by the applications ratify run");

    // `ratify --domain fees` applies the confirm — and, being the only D-fees-2
    // condition left `confirmed` and not `obsolete`, it mints: R-2.1, ordinal 2 for the
    // second domain in project.domains. The `edit R-1.1` condition never reaches this
    // domain's `applyConditions` call at all, the same filtering in the other direction.
    const feesRun = await runStage(dir, "ratify", { domain: "fees" });
    assert.equal(feesRun.ok, true, JSON.stringify(feesRun.messages));
    const feesText = readFileSync(join(dir, "spec/domains/fees.md"), "utf8");
    assert.match(feesText, /### R-2\.1 · v1 · confirmed · authored/);
    assert.match(feesText, /- state: accepted/);
    assert.ok(!feesText.includes("D-fees-"), "the confirmed criterion was minted, no provisional id remains");
    assert.match(readFileSync(feesRun.journal, "utf8"), /contract-v1/, "the journal names the contract gate here too");

    // A second `ratify --domain applications` changes nothing: the edit's statement is
    // already the ruled text, so `applyConditions`' own idempotence (a real content
    // comparison, not "was a condition present") leaves the version where it is.
    const headBefore = git(["rev-parse", "HEAD"], dir);
    const secondAppRun = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(secondAppRun.ok, true, JSON.stringify(secondAppRun.messages));
    assert.deepEqual(secondAppRun.changed, []);
    assert.equal(git(["rev-parse", "HEAD"], dir), headBefore, "no new commit — the edit was already applied");
    assert.match(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), /### R-1\.1 · v2 · confirmed · recovered/, "still v2, not bumped again");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

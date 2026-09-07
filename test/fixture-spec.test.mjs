// test/fixture-spec.test.mjs — the fixture project end to end through the three spec-side
// stages (intent, archaeology, ratify), on the mock executor. Task 8, Part A.
//
// This complements test/fixture.test.mjs (which proves the runner itself through the
// gate-less `probe` stage) by proving the spec-side stages actually chain: a plain
// commit standing in for the tech lead's brief, `runStage intent` opening a G0
// proposal the product-owner persona rules through `rulePending`, `runStage
// archaeology` opening a G1 proposal the same persona rules with the product owner's
// own ratification-condition vocabulary (`confirm`, `defect`), and `runStage ratify`
// turning those conditions into permanent `R-` ids, a regenerated index, and the
// coverage site — the same chain a live run exercises for real, on one domain, against a
// project outside this repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { rulePending, ruleByAgent } from "../src/commands/rule.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;
const MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;
const OLD_DIR = new URL("../fixture-project/old", import.meta.url).pathname;

// Same shape as test/spec-stages.test.mjs and test/ratify.test.mjs: a local git repo
// standing in for the old application, built from the fixture's own plain files so
// `ensureSources` (the `with-sources` workspace) has something `git clone` can reach.
function makeOldRepo(tmp) {
  const dir = join(tmp, "old-repo");
  cpSync(OLD_DIR, dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.org"], dir);
  git(["config", "user.name", "t"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "old app"], dir);
  return { dir, commit: git(["rev-parse", "HEAD"], dir) };
}

// G0 is already agent:product-owner in the checked-in fixture config, so `rulePending`
// reaches it with no rebinding. G1 (archaeology's gate) defaults to the human role
// tech-lead there; this test needs the persona's own condition vocabulary
// (`confirm`/`defect`), which only the agent ruling path parses, so G1 is rebound the
// same way test/ratify.test.mjs's `sourcesConfigWithAgentG1` does.
function sourcesConfigWithAgentG1(tmp, repoDir, commit) {
  const base = readFileSync(FROM, "utf8").replace(
    'G1: { holder: tech-lead }',
    'G1: { holder: "agent:product-owner", escalate_to: tech-lead }',
  );
  const path = join(tmp, "fixture-with-sources-agent-g1.config.yaml");
  writeFileSync(path, `${base}sources:\n  old: { repo: ${repoDir}, commit: ${commit}, exclude: [tests/] }\n`);
  return path;
}

async function makeProject(tmp, { from = FROM, name = "permit-intake" } = {}) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  const dir = join(tmp, name);
  await newProject({ dir, from });
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "fill constitution"], dir);
  return { dir, prevEgress };
}

async function makeRatifiableProject(tmp) {
  const { dir: repoDir, commit } = makeOldRepo(tmp);
  const from = sourcesConfigWithAgentG1(tmp, repoDir, commit);
  return makeProject(tmp, { from, name: "permit-intake-fixture-spec" });
}

function restoreEgress(prev) {
  if (prev === undefined) delete process.env.SDLC_EGRESS_NAMES;
  else process.env.SDLC_EGRESS_NAMES = prev;
}

// A plain commit standing in for the tech lead handing over the brief — not `propose` +
// a ruling, since the brief is the human's own input document, not something the
// pipeline itself proposes. Two paragraphs, with the `# Permit intake` heading `intent`
// derives its output filename and G0 proposal name from (`intent-permit-intake`).
function commitBrief(dir) {
  writeFileSync(join(dir, "intent", "brief.md"),
    "# Permit intake\n\n"
    + "Applicants submit permit applications on paper today; a clerk re-keys each one into the "
    + "case system by hand, which is slow and introduces transcription errors. We want applicants "
    + "to submit and track permit applications online instead, without a clerk re-entering anything.\n\n"
    + "The office does not track how many applications it handles today, and \"track\" beyond initial "
    + "submission is not yet defined — both are open questions for whoever picks this up next.\n");
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "intent: the tech lead's brief for permit intake"], dir);
}

// The product owner's own reply, ratifying the applications domain: the same
// vocabulary line (`confirm`/`defect`) test/ratify.test.mjs's `mockOwnerApprove` uses,
// and the exact conditions Task 8's brief specifies.
function mockOwnerApproveArchaeology() {
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-fixture-spec-mock-owner-"));
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify({
    text: [
      "The age minimum is well evidenced and the fee basis is now confirmed by the applicant's own submission history.",
      "",
      '```json',
      JSON.stringify({
        verdict: "approve",
        rationale: "age minimum is aligned with two sources; the fee basis is confirmed by re-reading the intake flow",
        conditions: [
          "confirm D-applications-2",
          "defect D-applications-1: the fee is recalculated when an application is edited",
        ],
      }),
      '```',
    ].join("\n"),
  }));
  return mockDir;
}

test("fixture project: intent, archaeology and ratify chain end to end on the mock executor", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-fixture-spec-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  const prevExecutor = process.env.SDLC_EXECUTOR;
  const prevMockDir = process.env.SDLC_MOCK_DIR;
  try {
    // --- intent: a plain commit of the brief, then a mock agent turn, then the
    // product-owner persona ruling G0 through `rulePending` rather than a named
    // `ruleByAgent` call, proving the pending-queue path reaches an intent proposal
    // the same way it will for the real project in Part B.
    commitBrief(dir);
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;

    const intentRun = await runStage(dir, "intent");
    assert.equal(intentRun.ok, true, JSON.stringify(intentRun.messages));
    assert.equal(intentRun.proposal.name, "intent-permit-intake");
    assert.equal(intentRun.proposal.gate, "G0");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/intent-permit-intake");

    const intentRulings = await rulePending(dir);
    assert.equal(intentRulings.length, 1, JSON.stringify(intentRulings));
    assert.equal(intentRulings[0].name, "intent-permit-intake");
    assert.equal(intentRulings[0].verdict, "approve");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.ok(existsSync(join(dir, "intent/permit-intake.md")));

    // --- archaeology: a mock agent turn recovers the applications domain (D-applications-1,
    // D-applications-2), opening a G1 proposal the product-owner persona then rules with
    // an explicit condition set: confirm the inferred fee criterion, and flag the age-check
    // criterion as a defect with a corrected statement.
    const archRun = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(archRun.ok, true, JSON.stringify(archRun.messages));
    assert.equal(archRun.proposal.name, "archaeology-applications");
    assert.equal(archRun.proposal.gate, "G1");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/archaeology-applications");

    const ownerMockDir = mockOwnerApproveArchaeology();
    process.env.SDLC_MOCK_DIR = ownerMockDir;
    const archRuling = await ruleByAgent(dir, "archaeology-applications", { persona: "product-owner" });
    assert.equal(archRuling.verdict, "approve");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");

    // --- ratify: no agent turn (agent: false) — deterministic, so the mock executor env
    // is cleared first, matching how test/ratify.test.mjs exercises it.
    delete process.env.SDLC_EXECUTOR;
    delete process.env.SDLC_MOCK_DIR;

    const ratifyRun = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(ratifyRun.ok, true, JSON.stringify(ratifyRun.messages));
    assert.equal(ratifyRun.proposal, null, "ratify holds no gate and never opens a proposal");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");

    const domainText = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    // D-applications-1 (age check, confirmed/recovered) was named `defect`: it keeps its
    // row, marked `reconciliation: defect`, and a new authored replacement is appended.
    assert.match(domainText, /### R-1\.1 · v1 · confirmed · recovered/);
    assert.match(domainText, /- reconciliation: defect/);
    // D-applications-2 (fee calculation, inferred/recovered) was `confirm`ed.
    assert.match(domainText, /### R-1\.2 · v1 · confirmed · recovered/);
    // The defect's replacement: authored, confirmed, replacing R-1.1.
    assert.match(domainText, /### R-1\.3 · v1 · confirmed · authored/);
    assert.match(domainText, /the fee is recalculated when an application is edited/);
    assert.match(domainText, /- replaces: R-1\.1/);
    assert.ok(!domainText.includes("D-applications-"), "no provisional ids remain once every criterion has been ruled on");

    const index = JSON.parse(readFileSync(join(dir, "spec/criteria-index.json"), "utf8"));
    assert.equal(index.criteria.length, 3);
    const byId = Object.fromEntries(index.criteria.map((c) => [c.id, c]));
    // All three permanent criteria land in state `accepted`: `defect` reclassifies R-1.1's
    // reconciliation but not its state, so the domain's coverage row below counts 3
    // accepted, not 2 — reconciliation `defect` is a note on how the criterion was
    // corrected, not evidence it was rejected.
    assert.equal(byId["R-1.1"].state, "accepted");
    assert.equal(byId["R-1.2"].state, "accepted");
    assert.equal(byId["R-1.3"].state, "accepted");
    assert.equal(byId["R-1.3"].replaces, "R-1.1");

    assert.ok(existsSync(join(dir, "spec/spec.md")));

    // --- site: the coverage board and per-domain criteria page `sdlc rule`'s own
    // `commitSite` call already folded into the ratify commit — rebuilt here only to
    // read the numbers back, not to produce a new commit (buildSite is a pure function
    // of what is already on disk).
    const { buildSite } = await import("../src/commands/status.mjs");
    const { pages } = buildSite(dir);
    assert.equal(git(["status", "--porcelain"], dir), "", "a rebuild of an unchanged site is a no-op");
    assert.ok(existsSync(join(dir, "site/criteria/applications.md")));
    const specIndexText = readFileSync(join(dir, "site/index.md"), "utf8");
    assert.match(specIndexText, /## Coverage/);
    // The coverage row for `applications`: STATES order is
    // [proposed, accepted, implemented, verified, monitored, obsolete], so the second
    // number column is `accepted` — 3 here, as established above, not 2.
    assert.match(specIndexText, /\| applications \| 0 \| 3 \| 0 \| 0 \| 0 \| 0 \| 0 \| 3 \|/);
    assert.ok(pages.includes("site/criteria/applications.md"));

    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    if (prevExecutor === undefined) delete process.env.SDLC_EXECUTOR;
    else process.env.SDLC_EXECUTOR = prevExecutor;
    if (prevMockDir === undefined) delete process.env.SDLC_MOCK_DIR;
    else process.env.SDLC_MOCK_DIR = prevMockDir;
    restoreEgress(prevEgress);
  }
});

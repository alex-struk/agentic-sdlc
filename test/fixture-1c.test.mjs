// test/fixture-1c.test.mjs — the fixture project end to end through the test-side stages,
// on the mock executor, the mock oracle and the mock test runner.
//
// One run of the whole chain from a fresh `sdlc new`: archaeology recovers the
// applications domain, the product-owner persona rules it, ratify mints the permanent
// ids, contract completes the surface, derive-tests writes the blind acceptance suite,
// bind-adapter binds it to the old target, and calibrate runs that suite and turns the
// one failing criterion into a ruling the product owner has to make. Nothing here needs
// Docker, a browser or a network.
//
// The setup helpers are this file's own copies of what test/test-stages.test.mjs and
// test/calibrate.test.mjs build for themselves: each test file owns its fixture so a
// change to one never has to reckon with what another file's helpers assume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { rule, ruleByAgent } from "../src/commands/rule.mjs";
import { writeLocal } from "../src/oracle/ports.mjs";
import { buildSite } from "../src/commands/status.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;
const MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;
const OLD_DIR = new URL("../fixture-project/old", import.meta.url).pathname;

const COMMIT = ["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m"];

// A local git repo standing in for the old application, built from the fixture's own
// plain files so `ensureSources` (the `with-sources` workspace `archaeology` and
// `contract` run in) has something `git clone` can reach.
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

// G1 defaults to the human role tech-lead in the checked-in fixture config. This chain
// needs the product owner's own ratification vocabulary (`confirm`/`defect`), which only
// the agent ruling path parses, so G1 is bound to the persona with tech-lead as its
// escalation target — which also leaves tech-lead able to rule the later G1 proposal
// (`contract-v1`) directly as a human.
function fixtureConfigWithSources(tmp, repoDir, commit) {
  const base = readFileSync(FROM, "utf8").replace(
    "G1: { holder: tech-lead }",
    'G1: { holder: "agent:product-owner", escalate_to: tech-lead }',
  );
  const path = join(tmp, "fixture-1c.config.yaml");
  writeFileSync(path, `${base}sources:\n  old: { repo: ${repoDir}, commit: ${commit}, exclude: [tests/] }\n`);
  return path;
}

// Isolates the egress name list: `init` (run as part of `newProject`) seeds the default
// list under the real home directory unless this is set first, and an existing-but-empty
// file wins the lookup outright.
async function makeProject(tmp, from) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  const dir = join(tmp, "permit-intake");
  await newProject({ dir, from });
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

// The old target, configured only after the contract has been ruled: `contract`'s own
// post-checks judge a project with `config.oracle` set on writing a Compose override the
// fixture's canned contract response never produces.
const ORACLE_BLOCK = `
oracle:
  target: old
  compose: sources/old/docker-compose.yml
  seed: tests/seed/
  base_url: http://localhost:3100
  identity: sandbox-idp
`;

// `readLocal`/`writeLocal` round-trip exactly this shape (`src/oracle/ports.mjs`),
// standing in for what a real `sdlc oracle up` would have written. The ports are
// deliberately not the ones `ORACLE_BLOCK` configures: `oracle up` takes whatever was
// free on the machine it ran on, so the live URL and the configured URL genuinely differ.
function writeOldOracleLocal(dir) {
  writeLocal(dir, "old", {
    target: "old",
    base_url: "http://localhost:3187",
    mail_api: "http://localhost:8031",
    ports: { app: 3187, db: 5507, mail_api: 8031 },
    compose_project: "sdlc-permit-intake-old",
  });
}

// The product owner's reply to the archaeology proposal: the age-check criterion is
// recovered evidence that is wrong in one respect (the fee is recalculated on edit, which
// the old application's code shows and its README does not), and the inferred fee
// criterion is confirmed. `defect` keeps the original row and appends an authored
// replacement, so the domain ratifies to three accepted criteria.
function mockOwnerApprovesArchaeology() {
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-1c-owner-"));
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify({
    text: [
      "The age minimum is well evidenced. The fee basis is confirmed by re-reading the intake flow, and the age criterion misses that an edit recalculates the fee.",
      "",
      "```json",
      JSON.stringify({
        verdict: "approve",
        rationale: "age minimum is aligned with two sources; the fee basis is confirmed by re-reading the intake flow",
        conditions: [
          "confirm D-applications-2",
          "defect D-applications-1: the fee is recalculated when an application is edited",
        ],
      }),
      "```",
    ].join("\n"),
  }));
  return mockDir;
}

function acceptedIds(dir) {
  const index = JSON.parse(readFileSync(join(dir, "spec/criteria-index.json"), "utf8"));
  return index.criteria.filter((c) => c.state === "accepted").map((c) => c.id).sort();
}

test("fixture project: archaeology through calibrate on the mock executor, oracle and test runner", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-1c-"));
  const { dir: repoDir, commit } = makeOldRepo(tmp);
  const { dir, prevEgress } = await makeProject(tmp, fixtureConfigWithSources(tmp, repoDir, commit));
  try {
    // --- archaeology: recovers the applications domain into provisional D- ids and opens
    // the G1 proposal the product-owner persona then rules.
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    const arch = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(arch.ok, true, JSON.stringify(arch.messages));
    assert.equal(arch.proposal.name, "archaeology-applications");
    assert.equal(arch.proposal.gate, "G1");

    process.env.SDLC_MOCK_DIR = mockOwnerApprovesArchaeology();
    const archRuling = await ruleByAgent(dir, "archaeology-applications", { persona: "product-owner" });
    assert.equal(archRuling.verdict, "approve");
    assert.deepEqual(archRuling.unparsed, [], "every ratification verb parses");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");

    // --- ratify: no agent turn (`agent: false`), so the executor env is cleared first.
    delete process.env.SDLC_EXECUTOR;
    delete process.env.SDLC_MOCK_DIR;
    const ratified = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(ratified.ok, true, JSON.stringify(ratified.messages));
    assert.deepEqual(acceptedIds(dir), ["R-1.1", "R-1.2", "R-1.3"]);

    // --- contract: the pages, personas, observables and seed the tests act through.
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    const contract = await runStage(dir, "contract");
    assert.equal(contract.ok, true, JSON.stringify(contract.messages));
    assert.equal(contract.proposal.name, "contract-v1");
    delete process.env.SDLC_EXECUTOR;
    delete process.env.SDLC_MOCK_DIR;
    // tech-lead is G1's escalation target, so a human may rule it directly.
    rule(dir, "contract-v1", "approve", { by: "tech-lead" });

    const cfgPath = join(dir, ".sdlc", "config.yaml");
    writeFileSync(cfgPath, readFileSync(cfgPath, "utf8") + ORACLE_BLOCK);
    git(["add", "-A"], dir);
    git([...COMMIT, "the old target is the oracle (test)"], dir);

    // --- derive-tests: the blind acceptance suite, written from the criteria and the
    // contract alone. R-1.3 has no observation that could exercise it and is recorded in
    // not-testable.yaml instead of a spec file.
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    const derived = await runStage(dir, "derive-tests", { domain: "applications" });
    assert.equal(derived.ok, true, JSON.stringify(derived.messages));
    assert.equal(derived.proposal.name, "derive-tests-applications");
    delete process.env.SDLC_EXECUTOR;
    delete process.env.SDLC_MOCK_DIR;
    // G3's holder is the reviewer persona; tech-lead is its escalation target.
    rule(dir, "derive-tests-applications", "approve", { by: "tech-lead" });

    // --- bind-adapter: what `sdlc oracle up` would have written, then the adapter that
    // binds the surface to the running old target.
    writeOldOracleLocal(dir);
    process.env.SDLC_ORACLE = "mock";
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    const bound = await runStage(dir, "bind-adapter", { target: "old" });
    assert.equal(bound.ok, true, JSON.stringify(bound.messages));
    assert.equal(bound.proposal.name, "bind-adapter-old");
    delete process.env.SDLC_ORACLE;
    delete process.env.SDLC_EXECUTOR;
    delete process.env.SDLC_MOCK_DIR;
    rule(dir, "bind-adapter-old", "approve", { by: "tech-lead" });

    // --- calibrate: run the merged suite against the old target and ask about what fails.
    process.env.SDLC_ORACLE = "mock";
    process.env.SDLC_TEST_RUNNER = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    const calibrated = await runStage(dir, "calibrate", { target: "old" });
    assert.equal(calibrated.ok, true, JSON.stringify(calibrated.messages));

    // 1. One row per accepted criterion, whether or not it has a test file of its own.
    const results = JSON.parse(readFileSync(join(dir, "tests/results/old/latest.json"), "utf8"));
    assert.equal(results.target, "old");
    assert.deepEqual(results.rows.map((r) => r.id).sort(), acceptedIds(dir));
    const rowFor = (id) => results.rows.find((r) => r.id === id);
    assert.equal(rowFor("R-1.1").result, "pass");
    assert.equal(rowFor("R-1.2").result, "fail");
    assert.equal(rowFor("R-1.3").result, "not-testable");

    // 2. The failing row, and only it, becomes a product-owner ruling.
    assert.ok(calibrated.proposal, "a failing row with no ruling opens a proposal");
    assert.equal(calibrated.proposal.name, "calibrate-old-1");
    assert.equal(calibrated.proposal.gate, "G1");
    assert.equal(calibrated.proposal.branch, "proposal/calibrate-old-1");
    const proposalPage = readFileSync(join(dir, ".sdlc/proposals/calibrate-old-1.md"), "utf8");
    assert.match(proposalPage, /R-1\.2/);
    assert.ok(!proposalPage.includes("R-1.1"), "a passing criterion is not asked about");
    assert.match(proposalPage, /Received: "submitted"/);

    // 3. The site reports the run and names the ruling it is waiting on. `site/results.md`
    // is per target and per results file — the failing criterion itself is named on its
    // domain page and on the proposal page, which are generated from the same run.
    const { pages } = buildSite(dir);
    assert.ok(pages.includes("site/results.md"));
    const resultsMd = readFileSync(join(dir, "site/results.md"), "utf8");
    const today = new Date().toISOString().slice(0, 10);
    assert.match(resultsMd, /^## old$/m);
    // The columns are pass · fail · unbound · stale · not-testable, in that fixed order.
    assert.match(resultsMd, new RegExp(`^\\| ${today}\\.json \\| [^|]+ \\| 1 \\| 1 \\| 0 \\| 0 \\| 1 \\|$`, "m"));
    assert.match(resultsMd, /^Open calibration proposal: calibrate-old-1\.$/m);

    const domainPage = readFileSync(join(dir, "site/criteria/applications.md"), "utf8");
    assert.match(domainPage, /^\| R-1\.2 \| .* \| fail \|$/m);
    assert.match(readFileSync(join(dir, "site/proposals/calibrate-old-1.md"), "utf8"), /R-1\.2/);
  } finally {
    delete process.env.SDLC_ORACLE;
    delete process.env.SDLC_TEST_RUNNER;
    delete process.env.SDLC_EXECUTOR;
    delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { ruleByAgent } from "../src/commands/rule.mjs";
import { COMMANDS } from "../src/cli.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;
const MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;
const OLD_DIR = new URL("../fixture-project/old", import.meta.url).pathname;

// Same shape as `test/spec-stages.test.mjs`'s own helpers: a project whose config
// carries `sources.old`, needed for `archaeology` to run at all. This one additionally
// rebinds G1 (archaeology's gate) from the fixture's ordinary human holder to
// `agent:product-owner`, since ratify's own tests need to exercise the persona's
// condition vocabulary through `ruleByAgent`, not a human `--by`.
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
  return makeProject(tmp, { from, name: "permit-intake-ratify" });
}

function restoreEgress(prev) {
  if (prev === undefined) delete process.env.SDLC_EGRESS_NAMES;
  else process.env.SDLC_EGRESS_NAMES = prev;
}

// The product owner's own reply: the vocabulary line straight from the persona's
// "Ruling format" — `confirm` upgrades D-applications-2 out of `inferred`, and `defect`
// keeps D-applications-1 as the record of current (correct) behaviour while filing the
// missing recalculation as a new, authored criterion.
function mockOwnerApprove() {
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-owner-"));
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

async function ratifyApplications(dir) {
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  const archaeologyRun = await runStage(dir, "archaeology", { domain: "applications" });
  assert.equal(archaeologyRun.ok, true, JSON.stringify(archaeologyRun.messages));

  const ownerMockDir = mockOwnerApprove();
  process.env.SDLC_MOCK_DIR = ownerMockDir;
  const ruling = await ruleByAgent(dir, "archaeology-applications", { persona: "product-owner" });
  assert.equal(ruling.verdict, "approve");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");

  delete process.env.SDLC_EXECUTOR;
  delete process.env.SDLC_MOCK_DIR;
  return runStage(dir, "ratify", { domain: "applications" });
}

test("sdlc run ratify --domain applications: mints permanent ids from the product owner's conditions, commits on main, no proposal", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-ok-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  try {
    const r = await ratifyApplications(dir);
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.equal(r.proposal, null, "ratify holds no gate and never opens a proposal");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");

    const domainText = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    // D-applications-1 (confirmed, recovered) was marked defect and minted first;
    // D-applications-2 (inferred) was confirmed by the ruling and minted second; the
    // defect's replacement is minted third, in the same pass, so its `replaces`
    // reference points at the permanent id its target ended up with, not the
    // provisional one.
    assert.match(domainText, /### R-1\.1 · v1 · confirmed · recovered/);
    assert.match(domainText, /- reconciliation: defect/);
    assert.match(domainText, /### R-1\.2 · v1 · confirmed · recovered/);
    assert.match(domainText, /### R-1\.3 · v1 · confirmed · authored/);
    assert.match(domainText, /the fee is recalculated when an application is edited/);
    assert.match(domainText, /- replaces: R-1\.1/);
    assert.ok(!domainText.includes("D-applications-"), "no provisional ids remain once every criterion has been ruled on");

    const index = JSON.parse(readFileSync(join(dir, "spec/criteria-index.json"), "utf8"));
    assert.equal(index.criteria.length, 3);
    const byId = Object.fromEntries(index.criteria.map((c) => [c.id, c]));
    assert.equal(byId["R-1.1"].state, "accepted");
    assert.equal(byId["R-1.2"].state, "accepted");
    assert.equal(byId["R-1.3"].state, "accepted");
    assert.equal(byId["R-1.3"].replaces, "R-1.1");

    const specMd = readFileSync(join(dir, "spec/spec.md"), "utf8");
    assert.match(specMd, /\| ID \| Version \| Confidence \| State \| Statement \|/);
    assert.match(specMd, /R-1\.1/);
    assert.match(specMd, /\| accepted \| 3 \|/);

    const journalFiles = ["001-archaeology.md", "002-ratify.md"];
    for (const f of journalFiles) assert.ok(existsSync(join(dir, `.sdlc/journal/${f}`)), `${f} is missing`);
    const journal = readFileSync(join(dir, ".sdlc/journal/002-ratify.md"), "utf8");
    assert.match(journal, /3 accepted/);
    assert.match(journal, /0 still open/);
    assert.match(journal, /0 obsolete/);
    assert.match(journal, /1 replacement/);

    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(ratify\): ratify applications/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run ratify --domain applications: a second run on an already-ratified domain is a no-op", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-noop-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  try {
    const first = await ratifyApplications(dir);
    assert.equal(first.ok, true, JSON.stringify(first.messages));
    const headBefore = git(["rev-parse", "HEAD"], dir);

    const second = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(second.ok, true, JSON.stringify(second.messages));
    assert.deepEqual(second.changed, []);
    assert.equal(git(["rev-parse", "HEAD"], dir), headBefore, "no new commit was made");
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run ratify --domain applications: three consecutive runs with edit and spike conditions are idempotent — one version bump, one commit, then true no-ops", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-idempotent-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  try {
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    const archaeologyRun = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(archaeologyRun.ok, true, JSON.stringify(archaeologyRun.messages));

    // D-applications-1 is already `confirmed` (recovered): `edit` changes its wording,
    // and it mints on this same pass regardless, so the edit itself is only ever applied
    // once no matter how it is exercised. D-applications-2 is `inferred`: `spike` moves
    // it to `open`, which `mintIds` never promotes — it stays `D-applications-2` forever,
    // which is exactly the "a `D-` row survives" case the idempotency fix targets.
    const ownerMockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-owner-idempotent-"));
    writeFileSync(join(ownerMockDir, "rule.json"), JSON.stringify({
      text: '```json\n' + JSON.stringify({
        verdict: "approve",
        rationale: "the age check wording is corrected; the fee basis needs a real answer before it can be confirmed",
        conditions: [
          "edit D-applications-1: When an applicant submits a permit application, the system rejects it unless the applicant is at least 19 years old.",
          "spike D-applications-2: does this hold for renewals too?",
        ],
      }) + '\n```',
    }));
    process.env.SDLC_MOCK_DIR = ownerMockDir;
    const ruling = await ruleByAgent(dir, "archaeology-applications", { persona: "product-owner" });
    assert.equal(ruling.verdict, "approve");

    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

    const first = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(first.ok, true, JSON.stringify(first.messages));
    const domainAfterFirst = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(domainAfterFirst, /### R-1\.1 · v2 · confirmed · recovered/, "edited exactly once, and minted since it was already confirmed");
    assert.match(domainAfterFirst, /### D-applications-2 · v1 · open · recovered/, "the spiked row stays provisional");
    const spikeNoteCount = [...domainAfterFirst.matchAll(/does this hold for renewals too\?/g)].length;
    assert.equal(spikeNoteCount, 1, "the spike note appears exactly once after the first run");
    // D-applications-2 is still open, so the closing loop opened a follow-up proposal —
    // which leaves the checkout on its branch, the same as any other opened proposal.
    assert.equal(first.proposal.name, "ratify-applications-1");
    git(["checkout", "-q", "main"], dir);
    const headAfterFirst = git(["rev-parse", "HEAD"], dir);

    for (let i = 1; i <= 2; i++) {
      const r = await runStage(dir, "ratify", { domain: "applications" });
      assert.equal(r.ok, true, JSON.stringify(r.messages));
      assert.deepEqual(r.changed, [], `rerun ${i} is a true no-op`);
      assert.equal(git(["rev-parse", "HEAD"], dir), headAfterFirst, `rerun ${i} made no new commit`);
      // The follow-up is still unruled, so no second one is opened alongside it.
      assert.equal(r.proposal ?? null, null, `rerun ${i} opened no second follow-up`);
      assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    }

    const domainFinal = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.equal(domainFinal, domainAfterFirst, "three passes leave the domain file exactly as the first run wrote it — no duplicated bump or note");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run ratify: existingMax for a domain's ordinal is computed project-wide, not just from the domain's own file", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-maxnumber-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  try {
    // A stray `R-1.5` in a domain file other than `applications` (ordinal 1), as if left
    // behind by an earlier `project.domains` reorder — `maxRNumber` must see it so a
    // freshly minted id under the same ordinal cannot collide with it.
    writeFileSync(join(dir, "spec/domains/stray.md"), "### R-1.5 · v1 · confirmed · authored\nMinted under ordinal 1, in a different file.\n");
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "seed a stray R-1 id"], dir);

    const r = await ratifyApplications(dir);
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    const domainText = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(domainText, /### R-1\.6 /, "numbering continues from the project-wide max (5), not from applications.md's own count (0)");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run ratify: a no-op rerun prints execute's own text, not just \"ok\"", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-noop-text-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  const logs = [];
  const origLog = console.log;
  const origCwd = process.cwd();
  try {
    const first = await ratifyApplications(dir);
    assert.equal(first.ok, true, JSON.stringify(first.messages));

    process.chdir(dir);
    console.log = (...a) => logs.push(a.join(" "));
    const code = await COMMANDS.run({ pos: ["ratify"], flags: { domain: "applications" } });
    assert.equal(code, 0);
    assert.ok(logs.some((l) => /nothing to do|already ratified/.test(l)), logs.join(" | "));
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run ratify: without --domain, fails pre-checks before touching the working tree", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-nodomain-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    const r = await runStage(dir, "ratify");
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /--domain/.test(m)), r.messages.join(" | "));
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    restoreEgress(prevEgress);
  }
});

test("sdlc run ratify: fails pre-checks when archaeology has not been approved yet", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-unapproved-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  try {
    const archaeologyRun = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(archaeologyRun.ok, true, JSON.stringify(archaeologyRun.messages));
    // Still on the open proposal branch: nothing has ruled it yet. A run starts on main,
    // so that is where a person would be standing when they tried this.
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/archaeology-applications");
    git(["checkout", "-q", "main"], dir);

    const r = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /archaeology-applications\.yaml is missing/.test(m)), r.messages.join(" | "));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run ratify: an unknown condition id is reported in the journal rather than silently dropped", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-unknown-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  try {
    const archaeologyRun = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(archaeologyRun.ok, true, JSON.stringify(archaeologyRun.messages));

    const ownerMockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-owner-unknown-"));
    writeFileSync(join(ownerMockDir, "rule.json"), JSON.stringify({
      text: '```json\n' + JSON.stringify({
        verdict: "approve",
        rationale: "confirming what evidence supports; the rest is left as the contract",
        conditions: ["confirm D-applications-2", "confirm D-applications-999"],
      }) + '\n```',
    }));
    process.env.SDLC_MOCK_DIR = ownerMockDir;
    const ruling = await ruleByAgent(dir, "archaeology-applications", { persona: "product-owner" });
    assert.equal(ruling.verdict, "approve");

    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    const r = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    const journal = readFileSync(join(dir, ".sdlc/journal/002-ratify.md"), "utf8");
    assert.match(journal, /confirm D-applications-999/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run ratify: a criterion the ruling never mentioned is left exactly as the contract (unminted, still D-)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-untouched-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  try {
    const archaeologyRun = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(archaeologyRun.ok, true, JSON.stringify(archaeologyRun.messages));

    // Only confirm D-applications-2, leaving D-applications-1 (already `confirmed`)
    // entirely unmentioned. Per the persona's own vocabulary, unmentioned means
    // "contract" — but nothing here says so explicitly, so D-applications-1 must still
    // mint, since it was already confirmed on its own.
    const ownerMockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-owner-untouched-"));
    writeFileSync(join(ownerMockDir, "rule.json"), JSON.stringify({
      text: '```json\n' + JSON.stringify({
        verdict: "approve",
        rationale: "the fee basis is now confirmed; the age minimum was already solid and needs no comment",
        conditions: ["confirm D-applications-2"],
      }) + '\n```',
    }));
    process.env.SDLC_MOCK_DIR = ownerMockDir;
    await ruleByAgent(dir, "archaeology-applications", { persona: "product-owner" });

    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    const r = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    const domainText = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(domainText, /### R-1\.1/);
    assert.match(domainText, /### R-1\.2/);
    assert.ok(!domainText.includes("D-applications-"));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run ratify: the preamble above the first criterion block survives the rewrite", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-preamble-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  try {
    const archaeologyRun = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(archaeologyRun.ok, true, JSON.stringify(archaeologyRun.messages));

    // Written onto the proposal branch, before the ruling, so it reaches main through
    // the same merge the domain file itself does: prose an agent (or a person) put above
    // the first `### ` block, which is not part of the criterion format and which
    // nothing in ratify has any business rewriting.
    const domainPath = join(dir, "spec/domains/applications.md");
    const preamble = [
      "# applications",
      "",
      "> Recovered from the intake service. The fee table lives in a spreadsheet nobody",
      "> could find, so every fee criterion below is graded against the code alone.",
      "",
      "| source | read |",
      "| --- | --- |",
      "| src/routes.js | yes |",
      "",
    ].join("\n");
    const body = readFileSync(domainPath, "utf8");
    writeFileSync(domainPath, preamble + body.slice(body.indexOf("### ")));
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "add a preamble"], dir);

    const ownerMockDir = mockOwnerApprove();
    process.env.SDLC_MOCK_DIR = ownerMockDir;
    await ruleByAgent(dir, "archaeology-applications", { persona: "product-owner" });

    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    const r = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    const after = readFileSync(domainPath, "utf8");
    assert.ok(after.startsWith(preamble), `preamble was dropped:\n${after.slice(0, 400)}`);
    assert.match(after, /### R-1\.1/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run ratify: a malformed criterion block fails the pre-checks and nothing is written", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-malformed-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  try {
    const archaeologyRun = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(archaeologyRun.ok, true, JSON.stringify(archaeologyRun.messages));
    const ownerMockDir = mockOwnerApprove();
    process.env.SDLC_MOCK_DIR = ownerMockDir;
    await ruleByAgent(dir, "archaeology-applications", { persona: "product-owner" });
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

    // A heading the grammar does not accept — the separator's spacing is wrong. The
    // parser reports it and keeps going, so before this check existed `execute` would
    // rewrite the file from the blocks it *did* understand and the malformed one would
    // be gone.
    const domainPath = join(dir, "spec/domains/applications.md");
    const before = readFileSync(domainPath, "utf8");
    const broken = `${before}\n### D-applications-9 · v1-confirmed · recovered\nA block whose heading does not parse.\n- cites: src/routes.js\n`;
    writeFileSync(domainPath, broken);
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "a malformed block"], dir);

    const r = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /spec\/domains\/applications\.md:\d+: malformed heading/.test(m)),
      r.messages.join("\n"));
    // Nothing was rewritten: the malformed block is still there, byte for byte.
    assert.equal(readFileSync(domainPath, "utf8"), broken);
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run ratify: a no-op run regenerates a stale index and commits it, with no journal entry", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-stale-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  try {
    const first = await ratifyApplications(dir);
    assert.equal(first.ok, true, JSON.stringify(first.messages));
    const journalsAfterFirst = readdirSync(join(dir, ".sdlc/journal")).length;
    const idxPath = join(dir, "spec/criteria-index.json");

    // The index drifts from the domain files — a hand edit, a checkout of one file, a
    // half-finished merge. Nothing about this domain's own criteria has changed, so the
    // run has no work of its own to do; the index is still wrong and has to be fixed.
    const index = JSON.parse(readFileSync(idxPath, "utf8"));
    index.criteria = index.criteria.slice(1);
    writeFileSync(idxPath, JSON.stringify(index, null, 2) + "\n");
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "a stale index"], dir);

    const r = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.match(r.text, /already ratified/);
    assert.deepEqual(r.changed, ["spec/criteria-index.json"]);
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.match(git(["log", "-1", "--format=%s"], dir), /stage\(ratify\): ratify applications \(regenerated\)/);
    // No turn ran, so there is no turn to journal.
    assert.equal(readdirSync(join(dir, ".sdlc/journal")).length, journalsAfterFirst);
    // And the index is back in step with the domain files.
    assert.equal(JSON.parse(readFileSync(idxPath, "utf8")).criteria.length, index.criteria.length + 1);

    // A second no-op run now has genuinely nothing to do: no commit, nothing dirty.
    const head = git(["rev-parse", "HEAD"], dir);
    const r2 = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.changed, []);
    assert.equal(git(["rev-parse", "HEAD"], dir), head);
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("the closing loop: ratify opens a follow-up over what it could not mint, and one pass resolves both", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-loop-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  try {
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    const archaeologyRun = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(archaeologyRun.ok, true, JSON.stringify(archaeologyRun.messages));

    // The ruling spikes one criterion and says nothing about the other, which is
    // `inferred` as recovered. Neither can mint, so ratify comes out of its first pass
    // with two criteria short of the contract and nothing that would ever ask again.
    const first = mkdtempSync(join(tmpdir(), "sdlc-mock-owner-loop1-"));
    writeFileSync(join(first, "rule.json"), JSON.stringify({
      text: '```json\n' + JSON.stringify({
        verdict: "approve",
        rationale: "the age minimum needs a decision on renewals; the fee basis is still only implied by the code",
        conditions: ["spike D-applications-1: does the age minimum hold for renewals too?"],
      }) + '\n```',
    }));
    process.env.SDLC_MOCK_DIR = first;
    assert.equal((await ruleByAgent(dir, "archaeology-applications", { persona: "product-owner" })).verdict, "approve");
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

    const pass1 = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(pass1.ok, true, JSON.stringify(pass1.messages));
    assert.equal(pass1.proposal.name, "ratify-applications-1");
    assert.equal(pass1.proposal.gate, "G1");
    assert.equal(pass1.proposal.unresolved, 2);

    // The page carries what the persona needs to rule without opening the domain file,
    // says which criterion has already been answered once, and restates the grammar.
    const page = readFileSync(join(dir, ".sdlc/proposals/ratify-applications-1.md"), "utf8");
    assert.match(page, /### D-applications-1 · v1 · open · recovered/);
    assert.match(page, /### D-applications-2 · v1 · inferred · recovered/);
    assert.match(page, /already answered once/);
    assert.match(page, /does the age minimum hold for renewals too\?/);
    assert.match(page, /- `confirm <ID>`/);
    assert.match(page, /- `obsolete <ID>: <why>`/);

    // The persona closes both out: one confirmed, one dropped.
    process.env.SDLC_EXECUTOR = "mock";
    const second = mkdtempSync(join(tmpdir(), "sdlc-mock-owner-loop2-"));
    writeFileSync(join(second, "rule.json"), JSON.stringify({
      text: '```json\n' + JSON.stringify({
        verdict: "approve",
        rationale: "renewals are out of scope for this domain, and the intake flow pins the fee basis down",
        conditions: [
          "confirm D-applications-2",
          "obsolete D-applications-1: renewals are handled by a separate service, so this rule is not carried forward",
        ],
      }) + '\n```',
    }));
    process.env.SDLC_MOCK_DIR = second;
    assert.equal((await ruleByAgent(dir, "ratify-applications-1", { persona: "product-owner" })).verdict, "approve");
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");

    // The next pass reads both approved rulings, in order, and applies the second's
    // conditions on top of the first's.
    const pass2 = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(pass2.ok, true, JSON.stringify(pass2.messages));
    const domainText = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(domainText, /### R-1\.1 · v1 · confirmed · recovered/, "the confirmed criterion minted");
    assert.match(domainText, /### D-applications-1 · v1 · open · recovered/, "the dropped criterion keeps its provisional id");
    assert.match(domainText, /- state: obsolete/);
    assert.match(domainText, /renewals are handled by a separate service/);

    // Nothing is left short of the contract, so the loop closes: no second follow-up.
    assert.equal(pass2.proposal ?? null, null);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.ok(!existsSync(join(dir, ".sdlc/proposals/ratify-applications-2.md")));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

function mockRuling(verdict, rationale, conditions) {
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-owner-loopbound-"));
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify({
    text: '```json\n' + JSON.stringify({ verdict, rationale, conditions }) + '\n```',
  }));
  return mockDir;
}

async function rule(dir, name) {
  process.env.SDLC_EXECUTOR = "mock";
  const verdict = (await ruleByAgent(dir, name, { persona: "product-owner" })).verdict;
  delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
  return verdict;
}

test("the closing loop's bound: a criterion answered `contract` twice on follow-ups becomes obsolete on the third ratify, and the loop closes", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-loopbound-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  try {
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    const archaeologyRun = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(archaeologyRun.ok, true, JSON.stringify(archaeologyRun.messages));

    // D-applications-2 (the fee basis) is confirmed straight away and mints on the first
    // pass; D-applications-1 (the age minimum) is spiked, so it is the one still short of
    // the contract for the rest of this test.
    process.env.SDLC_MOCK_DIR = mockRuling("approve",
      "the fee basis is confirmed by the intake flow; the age minimum needs a decision on renewals",
      ["spike D-applications-1: does the age minimum hold for renewals too?", "confirm D-applications-2"]);
    assert.equal((await ruleByAgent(dir, "archaeology-applications", { persona: "product-owner" })).verdict, "approve");
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

    const pass1 = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(pass1.ok, true, JSON.stringify(pass1.messages));
    assert.equal(pass1.proposal.name, "ratify-applications-1");
    assert.match(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), /### R-1\.1/, "the fee basis minted");

    // First `contract` answer: a non-answer that leaves the criterion exactly where it
    // is, per the reworded grammar (`contract` never promotes).
    process.env.SDLC_MOCK_DIR = mockRuling("approve", "leaving the age minimum exactly as recovered for now", ["contract D-applications-1"]);
    assert.equal(await rule(dir, "ratify-applications-1"), "approve");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");

    const pass2 = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(pass2.ok, true, JSON.stringify(pass2.messages));
    assert.match(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), /### D-applications-1 · v1 · open · recovered/,
      "one `contract` answer does not resolve it, and does not obsolete it either — only two do");
    assert.equal(pass2.proposal.name, "ratify-applications-2", "the loop keeps asking after only one non-answer");

    // Second `contract` answer, on the second follow-up: the same non-answer again.
    process.env.SDLC_MOCK_DIR = mockRuling("approve", "still leaving the age minimum exactly as recovered", ["contract D-applications-1"]);
    assert.equal(await rule(dir, "ratify-applications-2"), "approve");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");

    // The page for the second follow-up already warned that this criterion was answered
    // once before and would need a real decision.
    const page2 = readFileSync(join(dir, ".sdlc/proposals/ratify-applications-2.md"), "utf8");
    assert.match(page2, /already been answered once, with `contract` or `spike`/);

    const pass3 = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(pass3.ok, true, JSON.stringify(pass3.messages));
    const domainText = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    // Two follow-up rulings, neither resolving it, is the bound: `ratify` decides for the
    // criterion on the third pass rather than asking a third time.
    assert.match(domainText, /### D-applications-1 · v1 · open · recovered/, "still provisional — never minted");
    assert.match(domainText, /- state: obsolete/);
    assert.match(domainText, /unresolved after two rulings/);

    // Whichever journal entry this pass actually wrote (earlier passes may or may not
    // have journaled, depending on whether they changed anything), it names the reason.
    const journalFiles = readdirSync(join(dir, ".sdlc/journal")).filter((f) => f.includes("ratify")).sort();
    const journal = readFileSync(join(dir, ".sdlc/journal", journalFiles[journalFiles.length - 1]), "utf8");
    assert.match(journal, /1 obsolete/);
    assert.match(journal, /D-applications-1.*unresolved after two rulings/);

    // Nothing is left short of the contract, so the loop closes: no third follow-up.
    assert.equal(pass3.proposal ?? null, null, "no further follow-up opens once the criterion is obsolete");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.ok(!existsSync(join(dir, ".sdlc/proposals/ratify-applications-3.md")));

    // And a further ratify run genuinely has nothing left to do.
    const pass4 = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(pass4.ok, true, JSON.stringify(pass4.messages));
    assert.deepEqual(pass4.changed, []);
    assert.equal(pass4.proposal ?? null, null);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run ratify: a ruling carrying unparsed_conditions fails the run, naming the lines", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-unparsed-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  try {
    const r = await ratifyApplications(dir);
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    git(["checkout", "-q", "main"], dir);

    // A ruling the persona could not restate in the grammar even after being asked
    // again. Nothing would be applied for these lines, so a run that proceeded would be
    // executing a ruling it had only partly read.
    const gatePath = join(dir, ".sdlc/gates/archaeology-applications.yaml");
    writeFileSync(gatePath, readFileSync(gatePath, "utf8")
      + 'unparsed_conditions:\n  - "please just drop the fee one"\n');
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "a ruling with unreadable lines"], dir);

    const failed = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(failed.ok, false);
    assert.ok(failed.messages.some((m) => /do not match the ratification grammar/.test(m)), failed.messages.join("\n"));
    assert.ok(failed.messages.some((m) => /archaeology-applications\.yaml: please just drop the fee one/.test(m)), failed.messages.join("\n"));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run ratify: unparsed_conditions on the first-ever ruling fails before mint or regenerate, tree clean", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-ratify-unparsed-first-"));
  const { dir, prevEgress } = await makeRatifiableProject(tmp);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  try {
    const archaeologyRun = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(archaeologyRun.ok, true, JSON.stringify(archaeologyRun.messages));

    // A ruling whose one condition line the grammar cannot read at all, even after being
    // asked to restate it (the mock replies with the same text on the retry) — it lands
    // on the gate file as `unparsed_conditions`, never having minted anything, since this
    // domain has never been ratified yet.
    const ownerMockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-owner-unparsed-first-"));
    writeFileSync(join(ownerMockDir, "rule.json"), JSON.stringify({
      text: '```json\n' + JSON.stringify({
        verdict: "approve",
        rationale: "approving, but this condition line is not written in the grammar",
        conditions: ["please just drop the fee one"],
      }) + '\n```',
    }));
    process.env.SDLC_MOCK_DIR = ownerMockDir;
    const ruling = await ruleByAgent(dir, "archaeology-applications", { persona: "product-owner" });
    assert.equal(ruling.verdict, "approve");
    assert.equal(ruling.unparsed.length, 1);

    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

    const domainPath = join(dir, "spec/domains/applications.md");
    const before = readFileSync(domainPath, "utf8");
    assert.match(before, /D-applications-1/, "still provisional: no ratify has run yet");

    const r = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /do not match the ratification grammar/.test(m)), r.messages.join("\n"));

    // Nothing was minted, regenerated, or committed: the pre-check failed before
    // `execute` ever ran.
    assert.equal(readFileSync(domainPath, "utf8"), before, "domain file untouched");
    assert.ok(!existsSync(join(dir, "spec/criteria-index.json")), "criteria-index.json was never written");
    // spec/spec.md is part of the project scaffold (a placeholder), so it exists from
    // project creation, but nothing here rewrites it: it does not yet know about
    // `applications` at all.
    assert.ok(!readFileSync(join(dir, "spec/spec.md"), "utf8").includes("applications"), "spec.md was never regenerated");
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

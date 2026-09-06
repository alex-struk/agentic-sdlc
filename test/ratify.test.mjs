import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
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
    const headAfterFirst = git(["rev-parse", "HEAD"], dir);
    const domainAfterFirst = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(domainAfterFirst, /### R-1\.1 · v2 · confirmed · recovered/, "edited exactly once, and minted since it was already confirmed");
    assert.match(domainAfterFirst, /### D-applications-2 · v1 · open · recovered/, "the spiked row stays provisional");
    const spikeNoteCount = [...domainAfterFirst.matchAll(/does this hold for renewals too\?/g)].length;
    assert.equal(spikeNoteCount, 1, "the spike note appears exactly once after the first run");

    for (let i = 1; i <= 2; i++) {
      const r = await runStage(dir, "ratify", { domain: "applications" });
      assert.equal(r.ok, true, JSON.stringify(r.messages));
      assert.deepEqual(r.changed, [], `rerun ${i} is a true no-op`);
      assert.equal(git(["rev-parse", "HEAD"], dir), headAfterFirst, `rerun ${i} made no new commit`);
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
    // Still on the open proposal branch: nothing has ruled it yet.
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/archaeology-applications");

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

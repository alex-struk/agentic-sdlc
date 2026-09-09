import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { git, gitOk } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { rule } from "../src/commands/rule.mjs";

const FROM = fileURLToPath(new URL("../fixture-project/fixture.config.yaml", import.meta.url));
const MOCK_DIR = fileURLToPath(new URL("../fixture-project/mock", import.meta.url));
const OLD_DIR = fileURLToPath(new URL("../fixture-project/old", import.meta.url));

// Same fixture-project setup `test/spec-stages.test.mjs` builds for archaeology: a
// project whose config carries `sources.old`, pointing at a local git repo built from
// the fixture's own `old` application files. `--revise` needs nothing beyond what an
// ordinary archaeology run does — the same mock, the same human G1 holder (`tech-lead`).
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

function sourcesConfigPath(tmp, repoDir, commit) {
  const base = readFileSync(FROM, "utf8");
  const path = join(tmp, "fixture-with-sources.config.yaml");
  writeFileSync(path, `${base}sources:\n  old: { repo: ${repoDir}, commit: ${commit}, exclude: [tests/] }\n`);
  return path;
}

// Isolates the egress name list the same way the other stage tests do: `init` seeds the
// default list under the real home directory unless this is set first.
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

async function makeSourcesProject(tmp) {
  const { dir: repoDir, commit } = makeOldRepo(tmp);
  const from = sourcesConfigPath(tmp, repoDir, commit);
  return makeProject(tmp, { from, name: "permit-intake-sources" });
}

function restoreEgress(prev) {
  if (prev === undefined) delete process.env.SDLC_EGRESS_NAMES;
  else process.env.SDLC_EGRESS_NAMES = prev;
}

const RETURN_NOTE = "the fee criterion's evidence is wrong; recheck the recalculation logic against the actual code";

// The state every `--revise` test starts from: a domain recovered and partly ratified —
// `spec-stages.test.mjs`'s mock leaves D-applications-1 confirmed (mints straight to
// R-1.1) and D-applications-2 inferred, so ratify's closing loop opens a follow-up — and
// that follow-up returned rather than approved, exactly the situation `--revise` exists
// to act on. Ends back on `main`, the same way a person would be standing after ruling
// a return by hand (`rule` leaves the checkout on the ruled proposal's own branch).
async function buildReturnedFollowUp(dir, note = RETURN_NOTE) {
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  const archaeologyRun = await runStage(dir, "archaeology", { domain: "applications" });
  assert.equal(archaeologyRun.ok, true, JSON.stringify(archaeologyRun.messages));
  delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

  const approved = rule(dir, "archaeology-applications", "approve", { by: "tech-lead" });
  assert.equal(approved.verdict, "approve");

  const ratifyRun = await runStage(dir, "ratify", { domain: "applications" });
  assert.equal(ratifyRun.ok, true, JSON.stringify(ratifyRun.messages));
  assert.equal(ratifyRun.proposal?.name, "ratify-applications-1", "the fee criterion stayed inferred, so a follow-up opened");

  const returned = rule(dir, "ratify-applications-1", "return", { by: "tech-lead", note });
  assert.equal(returned.verdict, "return");
  git(["checkout", "-q", "main"], dir);
}

test("archaeology --revise: with no returned ruling, fails the pre-check up front", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-revise-none-"));
  const { dir, prevEgress } = await makeSourcesProject(tmp);
  try {
    const r = await runStage(dir, "archaeology", { domain: "applications", revise: true });
    assert.equal(r.ok, false);
    assert.deepEqual(r.messages, ["archaeology --revise: no returned ruling for applications to revise from"]);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /run\(archaeology\): pre-checks failed/);
  } finally {
    restoreEgress(prevEgress);
  }
});

test("archaeology --revise --dry-run: prints the return's rationale, and leaves the branch and main untouched", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-revise-dryrun-"));
  const { dir, prevEgress } = await makeSourcesProject(tmp);
  const logs = [];
  const origLog = console.log;
  try {
    await buildReturnedFollowUp(dir);
    const mainBefore = git(["rev-parse", "main"], dir);

    console.log = (...a) => logs.push(a.join(" "));
    const r = await runStage(dir, "archaeology", { domain: "applications", revise: true, dryRun: true });
    console.log = origLog;

    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.equal(r.dryRun, true);
    assert.ok(logs.some((l) => l.includes(RETURN_NOTE)), "the printed prompt quotes the return's rationale");

    // A dry run writes nothing at all — the same promise every stage's dry run makes
    // (docs/stages/run.md). The returned ruling is only found and quoted, never recorded:
    // its gate file and proposal page stay on the spent branch, `main` gains no commit,
    // and the branch itself is not deleted.
    assert.equal(existsSync(join(dir, ".sdlc/gates/ratify-applications-1.yaml")), false);
    assert.equal(gitOk(["rev-parse", "--verify", "proposal/ratify-applications-1"], dir), true);
    assert.equal(git(["show", "proposal/ratify-applications-1:.sdlc/gates/ratify-applications-1.yaml"], dir).includes("verdict: return"), true);

    assert.equal(git(["rev-parse", "main"], dir), mainBefore, "main gained no commit");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    console.log = origLog;
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("archaeology --revise: a failing earlier pre-check (in the same batch as a real returned ruling) leaves the branch and main untouched", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-revise-precheck-order-"));
  const { dir, prevEgress } = await makeSourcesProject(tmp);
  try {
    await buildReturnedFollowUp(dir);

    // `--domain applications` is exactly the domain with a real returned ruling to act
    // on — the scenario the bug report described as the dangerous one, since
    // `checkDomainOption` alone (a bad domain name) can never trigger it: a domain
    // `checkDomainOption` rejects is never the domain `checkRevisionSource` would have
    // found anything for anyway. `checkSourcesConfigured` is broken instead, by dropping
    // `sources.old` from `.sdlc/config.yaml` and committing that — unrelated to whether a
    // returned ruling exists, exactly like a real misconfiguration would be.
    const configPath = join(dir, ".sdlc", "config.yaml");
    const config = readFileSync(configPath, "utf8");
    assert.match(config, /^sources:/m);
    writeFileSync(configPath, config.replace(/^sources:[\s\S]*$/m, ""));
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "break sources.old"], dir);

    // The two cheap checks ahead of `checkRevisionSource` in `archaeology.preChecks` are
    // batched, and the batch is short-circuited on the first failure — `checkSourcesConfigured`
    // fails here, so `checkRevisionSource` never runs at all, and the returned ruling for
    // "applications" must be left exactly where it was, not recorded onto `main` as a side
    // effect of a batch that failed for a different reason entirely. `runStage` still commits
    // the ordinary "pre-checks failed" run-record line either way — that commit is expected,
    // and is not the one this test is about.
    const r = await runStage(dir, "archaeology", { domain: "applications", revise: true });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /sources\.old is not configured/.test(m)), r.messages.join(" | "));

    assert.equal(existsSync(join(dir, ".sdlc/gates/ratify-applications-1.yaml")), false, "the returned ruling was not recorded");
    assert.equal(gitOk(["rev-parse", "--verify", "proposal/ratify-applications-1"], dir), true, "its branch still exists");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /run\(archaeology\): pre-checks failed/);
    assert.equal(git(["log", "--all", "--pretty=%s"], dir).includes("record(G1): ratify-applications-1 returned"), false, "the return was never recorded");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("archaeology --revise: a real run still records the return onto main and deletes the branch", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-revise-real-record-"));
  const { dir, prevEgress } = await makeSourcesProject(tmp);
  try {
    await buildReturnedFollowUp(dir);

    const mockDir = mkdtempSync(join(tmpdir(), "sdlc-revise-real-record-mock-"));
    const before = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    const revised = before.replace(
      /### D-applications-2 · v1 · inferred · recovered[\s\S]*$/,
      "### D-applications-2 · v1 · confirmed · recovered\nWhen a permit application is accepted, the system shall calculate an intake fee for it from the applicant's age, and recalculate it whenever the application is later edited.\n"
      + "- cites: src/routes.js:22\n- reconciliation: implemented-only\n- given: an accepted permit application that is later edited\n"
      + "- when: the application record is updated\n- then: the fee is recalculated from the current age and stored on the record\n"
      + "- note: confirmed against the edit handler, which the earlier pass missed\n",
    );
    writeFileSync(join(mockDir, "archaeology.json"), JSON.stringify({
      text: "revised the fee criterion per the return's rationale",
      files: { "spec/domains/applications.md": revised },
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDir;
    const r = await runStage(dir, "archaeology", { domain: "applications", revise: true });
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    // The record commit landed on `main` before the agent turn even ran (it is part of
    // the pre-check), and the spent branch is gone — the same outcome the prior
    // implementation always produced for a real run, unaffected by the dry-run fix.
    const log = git(["log", "--pretty=%s", "main"], dir).split("\n");
    assert.ok(log.some((l) => l === "record(G1): ratify-applications-1 returned"), log.join(" | "));
    assert.equal(gitOk(["cat-file", "-e", "main:.sdlc/gates/ratify-applications-1.yaml"], dir), true);
    assert.equal(gitOk(["rev-parse", "--verify", "proposal/ratify-applications-1"], dir), false);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("archaeology --revise: a branch with no proposal page still records the gate file, and says so in the commit", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-revise-nopage-"));
  const { dir, prevEgress } = await makeSourcesProject(tmp);
  try {
    await buildReturnedFollowUp(dir);

    // Simulates a returned ruling whose branch never carried a proposal page — a human
    // ruling made straight from the CLI, with no page ever opened for it. `git show` for
    // the page has nothing to read; `recordReturnOnMain` must not let that stop the gate
    // file (the part that actually matters for follow-up numbering) from landing on `main`.
    git(["checkout", "-q", "proposal/ratify-applications-1"], dir);
    git(["rm", "-q", ".sdlc/proposals/ratify-applications-1.md"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "remove the proposal page"], dir);
    git(["checkout", "-q", "main"], dir);

    const before = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    const revised = before.replace(
      /### D-applications-2 · v1 · inferred · recovered[\s\S]*$/,
      "### D-applications-2 · v1 · confirmed · recovered\nWhen a permit application is accepted, the system shall calculate an intake fee for it from the applicant's age, and recalculate it whenever the application is later edited.\n"
      + "- cites: src/routes.js:22\n- reconciliation: implemented-only\n- given: an accepted permit application that is later edited\n"
      + "- when: the application record is updated\n- then: the fee is recalculated from the current age and stored on the record\n"
      + "- note: confirmed against the edit handler, which the earlier pass missed\n",
    );
    const mockDir = mkdtempSync(join(tmpdir(), "sdlc-revise-nopage-mock-"));
    writeFileSync(join(mockDir, "archaeology.json"), JSON.stringify({
      text: "revised the fee criterion per the return's rationale",
      files: { "spec/domains/applications.md": revised },
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDir;
    const r = await runStage(dir, "archaeology", { domain: "applications", revise: true });
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    // The gate file — the part `readRulings`/`followUpState` actually depend on — landed
    // on `main` regardless, and the commit says there was no page to carry over rather
    // than silently dropping the fact.
    assert.equal(gitOk(["cat-file", "-e", "main:.sdlc/gates/ratify-applications-1.yaml"], dir), true);
    const log = git(["log", "--pretty=%s", "main"], dir).split("\n");
    assert.ok(log.some((l) => l.startsWith("record(G1): ratify-applications-1 returned") && l.includes("no proposal page found")), log.join(" | "));
    assert.equal(existsSync(join(dir, ".sdlc/proposals/ratify-applications-1.md")), false);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("archaeology --revise: a mock that also writes spec/contract/surface.yaml fails archaeology-revise-scope, naming the file", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-revise-scope-"));
  const { dir, prevEgress } = await makeSourcesProject(tmp);
  try {
    await buildReturnedFollowUp(dir);
    const before = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    const revised = before.replace(
      /### D-applications-2 · v1 · inferred · recovered[\s\S]*$/,
      "### D-applications-2 · v1 · confirmed · recovered\nWhen a permit application is accepted, the system shall calculate an intake fee for it from the applicant's age, and recalculate it whenever the application is later edited.\n"
      + "- cites: src/routes.js:22\n- reconciliation: implemented-only\n- given: an accepted permit application that is later edited\n"
      + "- when: the application record is updated\n- then: the fee is recalculated from the current age and stored on the record\n"
      + "- note: confirmed against the edit handler, which the earlier pass missed\n",
    );
    const surfaceBefore = readFileSync(join(dir, "spec/contract/surface.yaml"), "utf8");

    const mockDir = mkdtempSync(join(tmpdir(), "sdlc-revise-scope-mock-"));
    writeFileSync(join(mockDir, "archaeology.json"), JSON.stringify({
      text: "revised the fee criterion, and also appended to the contract surface by mistake",
      files: {
        "spec/domains/applications.md": revised,
        "spec/contract/surface.yaml": `${surfaceBefore}# a page this revise run should not have added\n`,
      },
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDir;
    const r = await runStage(dir, "archaeology", { domain: "applications", revise: true });
    assert.equal(r.ok, false);
    assert.ok(
      r.messages.some((m) => /archaeology --revise may only change spec\/domains\/applications\.md/.test(m) && m.includes("spec/contract/surface.yaml")),
      r.messages.join(" | "),
    );
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(archaeology\): post-checks failed/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("archaeology --revise: a mock that rewrites the named D- criterion opens proposal/archaeology-applications, R-1.1 untouched", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-revise-rewrite-"));
  const { dir, prevEgress } = await makeSourcesProject(tmp);
  try {
    await buildReturnedFollowUp(dir);
    const before = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(before, /### R-1\.1 · v1 · confirmed · recovered/);

    // Only the criterion the return named — D-applications-2, still provisional — is
    // rewritten; R-1.1 is carried through exactly as `HEAD` already had it.
    const revised = before.replace(
      /### D-applications-2 · v1 · inferred · recovered[\s\S]*$/,
      "### D-applications-2 · v1 · confirmed · recovered\nWhen a permit application is accepted, the system shall calculate an intake fee for it from the applicant's age, and recalculate it whenever the application is later edited.\n"
      + "- cites: src/routes.js:22\n- reconciliation: implemented-only\n- given: an accepted permit application that is later edited\n"
      + "- when: the application record is updated\n- then: the fee is recalculated from the current age and stored on the record\n"
      + "- note: confirmed against the edit handler, which the earlier pass missed\n",
    );
    const mockDir = mkdtempSync(join(tmpdir(), "sdlc-revise-rewrite-mock-"));
    writeFileSync(join(mockDir, "archaeology.json"), JSON.stringify({
      text: "revised the fee recalculation criterion per the return's rationale",
      files: { "spec/domains/applications.md": revised },
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDir;
    const r = await runStage(dir, "archaeology", { domain: "applications", revise: true });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.equal(r.proposal?.name, "archaeology-applications");
    assert.equal(r.proposal?.branch, "proposal/archaeology-applications");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/archaeology-applications");

    const proposalText = readFileSync(join(dir, ".sdlc/proposals/archaeology-applications.md"), "utf8");
    assert.match(proposalText, /Is the revised applications domain right where the return said it was wrong\?/);

    const domainText = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(domainText, /### R-1\.1 · v1 · confirmed · recovered/, "the already-minted criterion is untouched");
    assert.match(domainText, /recalculate it whenever the application is later edited/, "the named criterion was revised");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("archaeology --revise: a mock that alters R-1.1's statement fails archaeology-revise-keeps-minted", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-revise-tamper-"));
  const { dir, prevEgress } = await makeSourcesProject(tmp);
  try {
    await buildReturnedFollowUp(dir);
    const before = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    const tampered = before.replace("at least 19 years old.", "at least 21 years old.");
    assert.notEqual(tampered, before);

    const mockDir = mkdtempSync(join(tmpdir(), "sdlc-revise-tamper-mock-"));
    writeFileSync(join(mockDir, "archaeology.json"), JSON.stringify({
      text: "revised the domain, and changed the age minimum by mistake",
      files: { "spec/domains/applications.md": tampered },
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDir;
    const r = await runStage(dir, "archaeology", { domain: "applications", revise: true });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /R-1\.1 changed/.test(m) && /already-minted/.test(m)), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(archaeology\): post-checks failed/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("checkArchaeologyNoMintedIds: a pre-existing R- id survives a revise, a brand-new one still fails it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-revise-newid-"));
  const { dir, prevEgress } = await makeSourcesProject(tmp);
  try {
    await buildReturnedFollowUp(dir);
    const before = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");

    // R-1.1 already existed at `HEAD` (minted by the ratify pass before the return), so
    // carrying it through unmodified must not trip the no-minted-ids check — only a
    // freshly-minted id does. Appended here rather than replacing D-applications-2, so
    // this test is purely about the new id and not entangled with revising anything.
    const withNewId = `${before}\n### R-1.2 · v1 · confirmed · authored\nWhen a permit application is edited, the system shall recalculate its fee.\n`
      + "- cites: src/routes.js:22\n- reconciliation: implemented-only\n- given: an accepted permit application\n"
      + "- when: the application is edited\n- then: the fee is recalculated\n";
    const mockDir = mkdtempSync(join(tmpdir(), "sdlc-revise-newid-mock-"));
    writeFileSync(join(mockDir, "archaeology.json"), JSON.stringify({
      text: "minted a new permanent id, which is not archaeology's to mint",
      files: { "spec/domains/applications.md": withNewId },
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDir;
    const r = await runStage(dir, "archaeology", { domain: "applications", revise: true });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /mints a permanent id \(R-1\.2\)/.test(m) && /ratify's job/.test(m)), r.messages.join(" | "));
    // R-1.1 — already on the file at `HEAD` — is not named in the failure: only the new id is.
    assert.ok(!r.messages.some((m) => m.includes("R-1.1")), r.messages.join(" | "));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("after approving a revise proposal, the next ratify pass opens ratify-applications-2, not -1", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-revise-renumber-"));
  const { dir, prevEgress } = await makeSourcesProject(tmp);
  try {
    await buildReturnedFollowUp(dir);
    const before = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");

    // Revised per the return, but still short of confirmed — a second source is still
    // missing — so the criterion stays inferred and the closing loop has something left
    // to ask about, the same way it did the first time.
    const revised = before.replace(
      /### D-applications-2 · v1 · inferred · recovered[\s\S]*$/,
      "### D-applications-2 · v1 · inferred · recovered\nWhen a permit application is accepted, the system shall calculate an intake fee for it from the applicant's age; whether it is recalculated on edit is still unclear from the code alone.\n"
      + "- cites: src/routes.js:22\n- reconciliation: implemented-only\n- given: an accepted permit application\n"
      + "- when: the application record is created or edited\n- then: a fee is calculated or recalculated from the current age\n"
      + "- note: the return was right that the edit path needed a closer look; still not confirmed by a second source\n",
    );
    const mockDir = mkdtempSync(join(tmpdir(), "sdlc-revise-renumber-mock-"));
    writeFileSync(join(mockDir, "archaeology.json"), JSON.stringify({
      text: "revised the fee criterion per the return's rationale; still inferred pending a second source",
      files: { "spec/domains/applications.md": revised },
    }));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDir;
    const revise = await runStage(dir, "archaeology", { domain: "applications", revise: true });
    assert.equal(revise.ok, true, JSON.stringify(revise.messages));
    assert.equal(revise.proposal?.name, "archaeology-applications");
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

    const approvedRevise = rule(dir, "archaeology-applications", "approve", { by: "tech-lead" });
    assert.equal(approvedRevise.verdict, "approve");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");

    const nextRatify = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(nextRatify.ok, true, JSON.stringify(nextRatify.messages));
    assert.equal(nextRatify.proposal?.name, "ratify-applications-2", "numbering continues past the returned -1 rather than reusing it");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

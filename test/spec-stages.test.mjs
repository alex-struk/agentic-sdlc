import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { rule } from "../src/commands/rule.mjs";
import { propose } from "../src/commands/propose.mjs";
import { loadConfig } from "../src/config/load.mjs";
import { finishStage } from "../src/runner/finish-stage.mjs";
import { stageFor } from "../src/stages/registry.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;
const MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;
const OLD_DIR = new URL("../fixture-project/old", import.meta.url).pathname;

// Isolates the egress name list the same way test/run.test.mjs does: `init` (run as
// part of `newProject`) seeds the default list under the real home directory unless
// this is set first, and an existing-but-empty file wins the lookup outright. `from`
// and `name` default to the plain greenfield fixture; archaeology's own tests pass a
// one-off config carrying a `sources.old` block instead (see `makeSourcesProject`).
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

// A local git repo standing in for the old application, built from the fixture's own
// plain files: `fixture-project/old` is committed to this repo as ordinary files, never
// as a nested git repo, so the pipeline's own history never carries a repo inside a
// repo. `ensureSources` (the `with-sources` workspace) needs something `git clone` can
// actually reach, so this turns a fresh copy of it into one, once per test.
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

// The checked-in fixture.config.yaml stays greenfield (no `sources` block) so every
// other test in this file keeps creating a plain project. Archaeology's own tests need
// `sources.old` pointing at a real, committed repo, so this writes a one-off copy of the
// config with that block appended, pointing at the repo `makeOldRepo` just made.
function sourcesConfigPath(tmp, repoDir, commit) {
  const base = readFileSync(FROM, "utf8");
  const path = join(tmp, "fixture-with-sources.config.yaml");
  writeFileSync(path, `${base}sources:\n  old: { repo: ${repoDir}, commit: ${commit}, exclude: [tests/] }\n`);
  return path;
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

function commitBrief(dir) {
  writeFileSync(join(dir, "intent", "brief.md"),
    "# Permit intake\n\nApplicants submit permit applications on paper today; a clerk re-keys each one into the "
    + "case system by hand. We want applicants to submit and track permit applications online instead.\n");
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "add intent brief"], dir);
}

test("sdlc run intent: without a brief, fails pre-checks and commits only the run record", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-intent-nobrief-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    const r = await runStage(dir, "intent");
    assert.equal(r.ok, false);
    assert.deepEqual(r.messages, ["intent/brief.md is missing: the tech lead writes the brief"]);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /run\(intent\): pre-checks failed/);
    const day = new Date().toISOString().slice(0, 10);
    assert.match(readFileSync(join(dir, `.sdlc/runs/${day}.md`), "utf8"), /run intent: pre-checks failed/);
    // Nothing was ever committed under intent/ or .sdlc/journal.
    assert.ok(!existsSync(join(dir, ".sdlc/journal")));
  } finally {
    restoreEgress(prevEgress);
  }
});

test("sdlc run intent: with a brief, the mock run opens proposal/intent-permit-intake carrying the proposal, journal and intent file", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-intent-ok-"));
  const { dir, prevEgress } = await makeProject(tmp);
  commitBrief(dir);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  try {
    const r = await runStage(dir, "intent");
    assert.equal(r.ok, true);
    assert.ok(r.proposal);
    assert.equal(r.proposal.name, "intent-permit-intake");
    assert.equal(r.proposal.gate, "G0");
    assert.equal(r.proposal.branch, "proposal/intent-permit-intake");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/intent-permit-intake");
    assert.equal(git(["status", "--porcelain"], dir), "");

    const proposalPath = join(dir, ".sdlc/proposals/intent-permit-intake.md");
    assert.ok(existsSync(proposalPath));
    const proposalText = readFileSync(proposalPath, "utf8");
    assert.match(proposalText, /gate: G0/);
    assert.match(proposalText, /"Is this the right problem and outcome\?"/);
    // The recommendation is the agent's own first sentence, not a re-derivation of it.
    assert.match(proposalText, /Interviewed the stakeholder brief against the intent template, one section at a time, and answered only what the brief itself says\./);

    assert.ok(existsSync(join(dir, ".sdlc/journal/001-intent.md")));
    const journal = readFileSync(join(dir, ".sdlc/journal/001-intent.md"), "utf8");
    assert.match(journal, /Interviewed the stakeholder brief/);

    const intentPath = join(dir, "intent/permit-intake.md");
    assert.ok(existsSync(intentPath));
    const intentText = readFileSync(intentPath, "utf8");
    assert.match(intentText, /## Open questions/);
    assert.ok(!intentText.includes("{{"));

    assert.match(git(["show", "--name-only", "--format=", "HEAD"], dir), /intent\/permit-intake\.md/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run intent: a mock that writes two intent files fails post-checks", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-intent-two-"));
  const { dir, prevEgress } = await makeProject(tmp);
  commitBrief(dir);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-intent-two-mock-"));
  writeFileSync(join(mockDir, "intent.json"), JSON.stringify({
    text: "wrote two intent files by mistake",
    files: {
      "intent/permit-intake.md": "# Intent: Permit intake\nStatus: draft\n\n## Open questions\n- [ ]\n",
      "intent/permit-intake-v2.md": "# Intent: Permit intake\nStatus: draft\n\n## Open questions\n- [ ]\n",
    },
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "intent");
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /expected exactly one new or changed file under intent\//.test(m)), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(intent\): post-checks failed/);
    // The agent's own files are left in the working tree, untracked, for inspection —
    // only the journal and run record were staged and committed.
    assert.ok(existsSync(join(dir, "intent/permit-intake.md")));
    assert.ok(existsSync(join(dir, "intent/permit-intake-v2.md")));
    const status = git(["status", "--porcelain"], dir);
    assert.match(status, /intent\/permit-intake\.md/);
    assert.match(status, /intent\/permit-intake-v2\.md/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run intent: a mock that writes outside intent/ fails scope check", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-intent-scope-"));
  const { dir, prevEgress } = await makeProject(tmp);
  commitBrief(dir);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-intent-scope-mock-"));
  writeFileSync(join(mockDir, "intent.json"), JSON.stringify({
    text: "wrote a file outside intent",
    files: {
      "intent/permit-intake.md": "# Intent: Permit intake\nStatus: draft\n\n## Open questions\n- [ ]\n",
      "app/oops.md": "This should not be here",
    },
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "intent");
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m.includes("app/oops.md")), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(intent\): post-checks failed/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run intent: a second run while the proposal is open is refused before any agent turn runs", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-intent-rerun-"));
  const { dir, prevEgress } = await makeProject(tmp);
  commitBrief(dir);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  try {
    const first = await runStage(dir, "intent");
    assert.equal(first.ok, true, JSON.stringify(first.messages));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/intent-permit-intake");

    // Before this fix, `intent.proposal` returned `null` until `ctx.intentFile` existed,
    // so this pre-flight had nothing to check and a second run reached the agent turn —
    // which then collided with the still-open proposal partway through `finishStage`.
    // `intent.proposal` now derives the same slug the agent itself builds its filename
    // from straight out of `intent/brief.md`'s own heading, so the pre-flight catches
    // this the same way any other gated stage's does: before a workspace is even
    // materialised, no agent turn, tree left exactly as it was.
    const second = await runStage(dir, "intent");
    assert.equal(second.ok, false);
    assert.deepEqual(second.messages, [
      "proposal intent-permit-intake is still open; rule it (or delete the branch) before running intent again",
    ]);
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/intent-permit-intake");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /run\(intent\): proposal still open/);
    // No second journal entry was written — the pre-flight caught this before any agent
    // turn, so there is nothing to journal.
    assert.ok(!existsSync(join(dir, ".sdlc/journal/002-intent.md")));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("finishStage: a proposal collision the pre-flight could not have known about is caught before propose, agent files left untracked", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-intent-late-collision-"));
  const { dir, prevEgress } = await makeProject(tmp);
  commitBrief(dir);
  try {
    // Simulates a proposal that appeared under the name this run's own agent turn is
    // about to land on, opened after any pre-flight check could have looked — the case
    // the pre-flight structurally cannot cover (`docs/stages/run.md`), whatever the
    // reason: a run that arrived via `sdlc resume` and skipped straight to `finishStage`,
    // or an intent brief whose heading didn't match what the agent actually titled its
    // document. `propose` opens the branch directly, with no gate file on it yet.
    propose(dir, "intent-permit-intake", {
      gate: "G0", question: "Is this the right problem and outcome?", recommendation: "placeholder",
    });
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/intent-permit-intake");
    git(["checkout", "-q", "main"], dir);

    // Stand in for what a real agent turn would have left behind: a valid intent
    // document, uncommitted, in the working tree.
    writeFileSync(join(dir, "intent", "permit-intake.md"),
      "# Intent: Permit intake\nStatus: draft\n\n## Open questions\n- [ ]\n");

    const { config } = loadConfig(join(dir, ".sdlc/config.yaml"));
    const ctx = { slice: undefined, domain: undefined, config };
    const agentResult = { text: "wrote the intent document", cost: 0, turns: 1, sessionId: "" };
    const r = await finishStage(dir, stageFor("intent"), ctx, agentResult);

    assert.equal(r.ok, false);
    assert.deepEqual(r.messages, [
      "proposal intent-permit-intake is still open; rule it (or delete the branch) before running intent again",
    ]);
    assert.ok(r.journal && existsSync(r.journal));
    assert.match(readFileSync(r.journal, "utf8"), /proposal intent-permit-intake is still open/);

    // Reported the same way any other post-check failure is: a journal entry and run
    // record committed on `main` (finishStage never touched branches), the agent's own
    // file left in the working tree, untracked, for a person to inspect.
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(intent\): post-checks failed/);
    const status = git(["status", "--porcelain"], dir);
    assert.match(status, /intent\/permit-intake\.md/);
  } finally {
    restoreEgress(prevEgress);
  }
});

test("sdlc run archaeology --domain applications: the mock run opens proposal/archaeology-applications, recovers the domain file, and leaves sources/ untracked", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-archaeology-ok-"));
  const { dir, prevEgress } = await makeSourcesProject(tmp);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  try {
    const r = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.ok(r.proposal);
    assert.equal(r.proposal.name, "archaeology-applications");
    assert.equal(r.proposal.gate, "G1");
    assert.equal(r.proposal.branch, "proposal/archaeology-applications");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/archaeology-applications");
    assert.equal(git(["status", "--porcelain"], dir), "");

    const domainPath = join(dir, "spec/domains/applications.md");
    assert.ok(existsSync(domainPath));
    const domainText = readFileSync(domainPath, "utf8");
    assert.match(domainText, /D-applications-1/);
    assert.match(domainText, /D-applications-2/);

    // ensureSources materialised the old app under sources/old, but sources/ is
    // gitignored project-wide, so none of it is ever tracked in the project's history.
    assert.equal(git(["ls-files", "--", "sources"], dir), "");
    assert.ok(existsSync(join(dir, "sources/old/src/routes.js")));
    assert.ok(!existsSync(join(dir, "sources/old/tests")));

    const journalPath = join(dir, ".sdlc/journal/001-archaeology.md");
    assert.ok(existsSync(journalPath));
    assert.match(readFileSync(journalPath, "utf8"), /applications domain/);

    const proposalText = readFileSync(join(dir, ".sdlc/proposals/archaeology-applications.md"), "utf8");
    assert.match(proposalText, /gate: G1/);
    assert.match(proposalText, /Is this what the applications domain does, and which of it is the contract\?/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run archaeology --domain applications: a second run while the proposal is open is refused; ruling it lets a fresh run through", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-archaeology-rerun-"));
  const { dir, prevEgress } = await makeSourcesProject(tmp);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  try {
    const first = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(first.ok, true, JSON.stringify(first.messages));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/archaeology-applications");

    // The proposal is still open: a second run must not touch the workspace or run an
    // agent turn at all, only report the block and leave the tree exactly as it was.
    const second = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(second.ok, false);
    assert.deepEqual(second.messages, [
      "proposal archaeology-applications is still open; rule it (or delete the branch) before running archaeology again",
    ]);
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "proposal/archaeology-applications");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /run\(archaeology\): proposal still open/);

    // G1's holder is the human role tech-lead, not an agent, so this rules directly
    // rather than through the mock executor.
    const ruled = rule(dir, "archaeology-applications", "approve", { by: "tech-lead" });
    assert.equal(ruled.verdict, "approve");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");

    const third = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(third.ok, true, JSON.stringify(third.messages));
    assert.equal(third.proposal.branch, "proposal/archaeology-applications");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run archaeology: without --domain, fails pre-checks", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-archaeology-nodomain-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    const r = await runStage(dir, "archaeology");
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /--domain/.test(m)), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    restoreEgress(prevEgress);
  }
});

test("sdlc run archaeology --domain bogus: fails pre-checks, domain not in project.domains", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-archaeology-baddomain-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    const r = await runStage(dir, "archaeology", { domain: "bogus" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /not in project\.domains/.test(m)), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
  } finally {
    restoreEgress(prevEgress);
  }
});

test("sdlc run archaeology: a mock that mints an R- id fails post-checks", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-archaeology-rid-"));
  const { dir, prevEgress } = await makeSourcesProject(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-archaeology-rid-mock-"));
  writeFileSync(join(mockDir, "archaeology.json"), JSON.stringify({
    text: "recovered the applications domain and minted a permanent id",
    files: {
      "spec/domains/applications.md":
        "### R-1.1 · v1 · confirmed · recovered\nWhen an applicant submits a permit application, the system shall "
        + "reject it unless the applicant is at least 19 years old.\n- cites: src/routes.js:3\n"
        + "- reconciliation: implemented-only\n- given: an applicant submitting a permit application\n"
        + "- when: the applicant is under 19 years old\n- then: the application is rejected\n",
    },
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /R-1\.1/.test(m) && /ratify/.test(m)), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(archaeology\): post-checks failed/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("sdlc run archaeology: a mock that also writes app/x fails scope check", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-archaeology-scope-"));
  const { dir, prevEgress } = await makeSourcesProject(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-archaeology-scope-mock-"));
  writeFileSync(join(mockDir, "archaeology.json"), JSON.stringify({
    text: "recovered the applications domain and wrote a stray file",
    files: {
      "spec/domains/applications.md":
        "### D-applications-1 · v1 · confirmed · recovered\nWhen an applicant submits a permit application, the "
        + "system shall reject it unless the applicant is at least 19 years old.\n- cites: src/routes.js:3\n"
        + "- reconciliation: implemented-only\n- given: an applicant submitting a permit application\n"
        + "- when: the applicant is under 19 years old\n- then: the application is rejected\n",
      "app/x": "This should not be here",
    },
  }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const r = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => m.includes("app/x")), r.messages.join(" | "));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(archaeology\): post-checks failed/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

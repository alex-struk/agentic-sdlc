import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;
const MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;

// Isolates the egress name list the same way test/run.test.mjs does: `init` (run as
// part of `newProject`) seeds the default list under the real home directory unless
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

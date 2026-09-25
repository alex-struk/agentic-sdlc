import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { resume } from "../src/commands/resume.mjs";
import { ruleByAgent } from "../src/commands/rule.mjs";
import { stageFor } from "../src/stages/registry.mjs";
import { applyConditions, conditionParses, parseDomainFile, criterionFingerprint, CONDITION_GRAMMAR } from "../src/spec/criteria.mjs";
import { addRecovery, answerRecoveries, outstandingRecoveries, readRecovery, readRecoveryFor, recoveryRequestCount } from "../src/spec/recovery.mjs";

// A gated stage commits its work to its proposal branch and leaves the checkout on
// `main`, so reading what the stage produced means reading that branch. `read` is run
// with the branch checked out and HEAD is put back wherever it was.
function onBranch(dir, branch, read) {
  const start = git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  git(["checkout", "-q", branch], dir);
  try { return read(); } finally { git(["checkout", "-q", start], dir); }
}

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;
const MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;
const OLD_DIR = new URL("../fixture-project/old", import.meta.url).pathname;

// What the product owner says about a criterion whose evidence does not hold: the fixture's
// D-applications-2 claims the intake fee is calculated from the applicant's age, and the
// ruling below says the code it cites shows something else. It is one line, in the
// ratification grammar, exactly as the persona would write it.
const WHY = "src/routes.js:10 never reads the applicant's age when it stores the fee, so nothing in the old application calculates a fee from age";
const CONDITION = `recovery-wrong D-applications-2: ${WHY}`;

function criterion(overrides = {}) {
  return {
    id: "D-content-1", version: 1, confidence: "inferred", origin: "recovered",
    statement: "a guard rejects the request", cites: [{ path: "src/x.js", line: 4 }],
    reconciliation: "implemented-only", given: "a request", when: "it arrives", then: "it is rejected",
    notes: [], state: "proposed", ...overrides,
  };
}

test("the ratification grammar reads `recovery-wrong <ID>: <text>` and states what it does", () => {
  assert.equal(conditionParses("recovery-wrong D-content-12: the guard can never run"), true);
  // Text is required — the whole point of the verb is the reason it carries — and a
  // condition may not span more than one line, the same rule every other verb keeps.
  assert.equal(conditionParses("recovery-wrong D-content-12"), false);
  assert.equal(conditionParses("recovery-wrong D-content-12: why\n- tier: CRITICAL"), false);
  assert.match(CONDITION_GRAMMAR, /recovery-wrong <ID>/);
});

test("applyConditions: `recovery-wrong` marks the row, drops it to open, and leaves its wording alone", () => {
  const before = [criterion()];
  const { criteria, applied, unknown } = applyConditions(before, ["recovery-wrong D-content-1: the guard sits behind a check that is always false"]);
  assert.deepEqual(unknown, []);
  assert.equal(applied[0].verb, "recovery-wrong");
  const c = criteria[0];
  assert.equal(c.statement, "a guard rejects the request", "the statement is untouched: there is nothing to rewrite it to yet");
  assert.equal(c.version, 1, "no version is minted for a row nobody has rewritten");
  assert.equal(c.confidence, "open", "a row whose evidence is under re-recovery cannot mint");
  assert.deepEqual(c.recoveryRequests, ["the guard sits behind a check that is always false"]);
  assert.ok(c.notes.some((n) => n.startsWith("sent back for re-recovery: ")), c.notes.join(" | "));
});

test("applyConditions: replaying the same `recovery-wrong` condition changes nothing further", () => {
  const line = "recovery-wrong D-content-1: the guard sits behind a check that is always false";
  const once = applyConditions([criterion()], [line]).criteria;
  const twice = applyConditions(once, [line]).criteria;
  assert.equal(twice[0].notes.length, 1, "the note is not duplicated on a second pass");
  assert.deepEqual(twice[0].notes, once[0].notes);
  assert.equal(twice[0].confidence, "open");
});

test("applyConditions: `recovery-wrong` on an already-minted criterion records the request without withdrawing the contract", () => {
  const { criteria } = applyConditions(
    [criterion({ id: "R-1.4", confidence: "confirmed", state: "accepted" })],
    ["recovery-wrong R-1.4: the cited migration was reverted before the release this claims"],
  );
  assert.equal(criteria[0].confidence, "confirmed", "a minted row keeps the confidence the contract depends on");
  assert.equal(criteria[0].state, "accepted");
  assert.ok(criteria[0].notes.some((n) => n.startsWith("sent back for re-recovery: ")));
});

test("a recovery request is outstanding until an archaeology run answers it", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-file-"));
  const c = criterion({ confidence: "open" });
  const entry = { id: c.id, domain: "content", version: c.version, why: "the guard can never run" };

  assert.equal(addRecovery(tmp, [entry]), "spec/recovery.yaml");
  assert.equal(addRecovery(tmp, [entry]), null, "the same request is filed once, however often the ruling is replayed");
  assert.equal(readRecovery(tmp).length, 1);
  assert.deepEqual(readRecoveryFor(tmp, "other-domain"), []);

  const entries = readRecoveryFor(tmp, "content");
  assert.deepEqual(outstandingRecoveries(entries, [c]).map((e) => e.id), ["D-content-1"]);

  // Changing the row is not the answer, whoever changed it and for whatever reason: a
  // `spike`'s note, an `edit`'s new statement and a corrected citation are all things that
  // happen without anybody going back to the old application.
  assert.equal(outstandingRecoveries(entries, [{ ...c, notes: ["spiked: is this in scope at all?"] }]).length, 1);
  assert.equal(outstandingRecoveries(entries, [{ ...c, statement: "something else entirely", version: 2 }]).length, 1);
  // A criterion the recovery removed is the one thing besides the stamp that ends a
  // request: there is no row left to recover.
  assert.deepEqual(outstandingRecoveries(entries, []), []);

  // A second reason on the same row is a second request, and both are owed.
  addRecovery(tmp, [{ ...entry, why: "and the citation points at a file the release never shipped" }]);
  const both = readRecoveryFor(tmp, "content");
  assert.equal(recoveryRequestCount(both, "D-content-1"), 2);
  assert.equal(outstandingRecoveries(both, [c]).length, 2);

  // The stamp an archaeology run writes is what ends them, and it ends every request that
  // was owed on the row it recovered.
  const recovered = { ...c, version: 3, statement: "what the route actually does" };
  assert.equal(answerRecoveries(tmp, "content", ["D-content-1"], new Map([["D-content-1", recovered]])), "spec/recovery.yaml");
  const after = readRecoveryFor(tmp, "content");
  assert.deepEqual(after.map((e) => e.answered), [{ version: 3 }, { version: 3 }]);
  assert.deepEqual(outstandingRecoveries(after, [recovered]), []);
  assert.equal(recoveryRequestCount(after, "D-content-1"), 2, "an answered request stays on file as the record that it was made");
  assert.equal(answerRecoveries(tmp, "content", ["D-content-1"], new Map([["D-content-1", recovered]])), null, "nothing is rewritten once there is nothing left to stamp");

  // A recovery that removed the row records that instead of a version.
  const gone = { id: "D-content-9", domain: "content", version: 1, why: "this behaviour is not in the application at all" };
  addRecovery(tmp, [gone]);
  assert.equal(answerRecoveries(tmp, "fees", ["D-content-9"], new Map()), null, "a run for one domain never answers another domain's request");
  assert.equal(readRecoveryFor(tmp, "content").find((e) => e.id === "D-content-9").answered, undefined);
  answerRecoveries(tmp, "content", ["D-content-9"], new Map());
  assert.deepEqual(readRecoveryFor(tmp, "content").find((e) => e.id === "D-content-9").answered, { removed: true });
});

// ---------------------------------------------------------------------------
// End to end, through a real project: the same scaffolding `test/ratify.test.mjs`
// builds, since the route runs from a product-owner ruling at G1 all the way to the
// archaeology run that has to act on it.
// ---------------------------------------------------------------------------

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

async function makeProject(tmp) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  const { dir: repoDir, commit } = makeOldRepo(tmp);
  const dir = join(tmp, "permit-intake-recovery");
  await newProject({ dir, from: sourcesConfigWithAgentG1(tmp, repoDir, commit) });
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "fill constitution"], dir);
  return { dir, prevEgress };
}

// Adds lines under `policy:` in a project's committed config, so a test can run the same
// project under a policy other than the defaults.
function setPolicy(dir, ...lines) {
  const p = join(dir, ".sdlc/config.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^  default_tier: (\S+)$/m, (m) => `${m}\n${lines.map((l) => `  ${l}`).join("\n")}`));
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "policy"], dir);
}

function restoreEgress(prev) {
  if (prev === undefined) delete process.env.SDLC_EGRESS_NAMES;
  else process.env.SDLC_EGRESS_NAMES = prev;
}

function mockDirWith(name, payload) {
  const dir = mkdtempSync(join(tmpdir(), `sdlc-mock-${name}-`));
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(payload));
  return dir;
}

// The ruling: one criterion sent back for re-recovery, and nothing said about the other,
// which is treated as `contract` and mints on its own confidence.
function mockOwnerSendsOneBack() {
  return mockDirWith("rule", {
    text: '```json\n' + JSON.stringify({
      verdict: "approve",
      rationale: "the age minimum holds on two sources; the fee criterion does not describe anything this application does",
      conditions: [CONDITION],
    }) + '\n```',
  });
}

// archaeology, then the G1 ruling that sends D-applications-2 back, then ratify.
async function ratifyWithOneSentBack(dir) {
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = MOCK_DIR;
  const archaeologyRun = await runStage(dir, "archaeology", { domain: "applications" });
  assert.equal(archaeologyRun.ok, true, JSON.stringify(archaeologyRun.messages));

  process.env.SDLC_MOCK_DIR = mockOwnerSendsOneBack();
  const ruling = await ruleByAgent(dir, "archaeology-applications", { persona: "product-owner" });
  assert.equal(ruling.verdict, "approve");
  const gate = parseYaml(readFileSync(join(dir, ".sdlc/gates/archaeology-applications.yaml"), "utf8"));
  assert.deepEqual(gate.unparsed_conditions ?? [], [], "the ruling's condition was read in the ratification grammar");

  delete process.env.SDLC_EXECUTOR;
  delete process.env.SDLC_MOCK_DIR;
  return runStage(dir, "ratify", { domain: "applications" });
}

test("ratify: a criterion ruled recovery-wrong goes back to archaeology while the rest of its domain mints", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-ratify-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    const r = await ratifyWithOneSentBack(dir);
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.equal(git(["status", "--porcelain"], dir), "", "the run leaves nothing dirty");

    const domainText = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    // The eleven-sound-criteria case in miniature: the criterion nobody sent back minted a
    // permanent id on the same pass as the one that went back.
    assert.match(domainText, /### R-1\.1 · v1 · confirmed · recovered/);
    assert.match(domainText, /### D-applications-2 · v1 · open · recovered/);
    assert.match(domainText, /- note: sent back for re-recovery: src\/routes\.js:10 never reads/);
    assert.match(domainText, /calculate an intake fee for it from the applicant's age/,
      "the statement is left exactly as recovered: there is nothing to rewrite it to until the evidence is read again");

    const entries = readRecoveryFor(dir, "applications");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "D-applications-2");
    assert.equal(entries[0].domain, "applications");
    assert.equal(entries[0].version, 1);
    assert.equal(entries[0].why, WHY, "the ruler's reason is carried whole, not reduced to a marker");
    const { criteria } = parseDomainFile(domainText, "applications");
    assert.equal(outstandingRecoveries(entries, criteria).length, 1);

    const journal = readFileSync(join(dir, ".sdlc/journal/002-ratify.md"), "utf8");
    assert.match(journal, /1 out for re-recovery/);
    assert.match(journal, /D-applications-2 — src\/routes\.js:10 never reads/);

    // The point of the route: no follow-up is opened to ask the product owner about a
    // criterion that is waiting on archaeology instead.
    const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], dir).split("\n");
    assert.ok(!branches.some((b) => b.startsWith("proposal/ratify-applications-")), branches.join(" | "));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ratify: re-running over the same ruling files no second request and stays a no-op", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-rerun-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);
    const head = git(["rev-parse", "HEAD"], dir);

    const again = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(again.ok, true, JSON.stringify(again.messages));
    assert.deepEqual(again.changed, []);
    assert.equal(git(["rev-parse", "HEAD"], dir), head, "no new commit");
    assert.equal(readRecoveryFor(dir, "applications").length, 1, "the request is filed once, not once per ratify run");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("archaeology: the next run for the domain is told which criteria it is recovering again, and why", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-prompt-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    const prompt = stageFor("archaeology").prompt({ domain: "applications", projectDir: dir });
    assert.match(prompt, /recovering it again rather than discovering it/);
    assert.match(prompt, /D-applications-2 \(as recovered at v1\)/);
    assert.ok(prompt.includes(WHY), "the ruler's own words reach the stage that has to redo the work");

    // A revision prompt carries the same block: a return and a sent-back criterion can be
    // outstanding at the same time, and the run has to answer both.
    const revisePrompt = stageFor("archaeology").prompt({ domain: "applications", projectDir: dir, revise: true, revision: { rationale: "the surface is missing a page" } });
    assert.ok(revisePrompt.includes(WHY));

    // A domain nobody sent anything back for reads exactly as it always has.
    assert.ok(!stageFor("archaeology").prompt({ domain: "fees", projectDir: dir }).includes("recovering it again"));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("archaeology: a criterion sent back and re-emitted unchanged fails the run rather than passing as recovered", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-unchanged-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    // The failure this route exists to make visible: the stage runs, writes the domain
    // file back byte for byte, and reports success.
    const unchanged = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDirWith("archaeology", {
      text: "## Journal\n\nRe-read the intake flow and left the fee criterion as it was.",
      files: { "spec/domains/applications.md": unchanged },
    });

    const r = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(r.ok, false, "a re-recovery that changed nothing is not a re-recovery");
    assert.ok(r.messages.some((m) => /D-applications-2 was sent back for re-recovery/.test(m)), r.messages.join(" | "));
    assert.ok(r.messages.some((m) => m.includes(WHY)), r.messages.join(" | "));
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /stage\(archaeology\): post-checks failed/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("archaeology: recovering the criterion again answers the request and passes the run's checks", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-answered-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    const before = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    const recovered = before
      .replace("calculate an intake fee for it from the applicant's age.", "store the intake fee the permit type carries.")
      .replace("- then: a fee is calculated from the applicant's age and stored on the record",
        "- then: the fee for the submitted permit type is stored on the record");
    assert.notEqual(recovered, before);

    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDirWith("archaeology", {
      text: "## Journal\n\nThe fee comes from the permit type, not the applicant's age; the row now says so and cites the line that reads it.",
      files: { "spec/domains/applications.md": recovered },
    });

    const r = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    onBranch(dir, r.proposal.branch, () => {
      const { criteria } = parseDomainFile(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), "applications");
      const entries = readRecoveryFor(dir, "applications");
      assert.equal(entries.length, 1, "the request stays on file as the record that it was made");
      assert.deepEqual(outstandingRecoveries(entries, criteria), [], "and is answered by the criterion no longer being the one that went out");
    });
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("the closing loop's bound never force-obsoletes a criterion that is out for re-recovery", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-sweep-"));
  const { dir, prevEgress } = await makeProject(tmp);
  setPolicy(dir, "loops: { ratify_follow_ups: { on_limit: obsolete } }");
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    // Two follow-up rulings are what arms the sweep that marks anything still
    // `inferred`/`open` obsolete. Written straight to the gate directory, the same shape
    // `sdlc rule` writes, and committed so the tree is clean for the next run.
    for (const n of [1, 2]) {
      writeFileSync(join(dir, `.sdlc/gates/ratify-applications-${n}.yaml`),
        `name: ratify-applications-${n}\ngate: G1\nverdict: approve\nby: product-owner\nrationale: nothing further to decide on this pass\nconditions: []\n`);
    }
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "record two follow-up rulings"], dir);

    const r = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    const domainText = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(domainText, /### D-applications-2 · v1 · open · recovered/);
    assert.ok(!/unresolved after two rulings/.test(domainText),
      "a criterion waiting on archaeology has not been asked twice and must not be swept");
    assert.ok(!/- state: obsolete/.test(domainText), domainText);
    assert.equal(outstandingRecoveries(readRecoveryFor(dir, "applications"), parseDomainFile(domainText, "applications").criteria).length, 1);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("spec/recovery.yaml is absent until something is actually sent back", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-absent-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    assert.equal(existsSync(join(dir, "spec/recovery.yaml")), false);
    assert.deepEqual(readRecovery(dir), []);
  } finally {
    restoreEgress(prevEgress);
  }
});

// ---------------------------------------------------------------------------
// The round trip: a criterion goes back, comes back recovered, and the ruling that
// sent it stops firing. A gate file is never consumed — `readRulings` reads every
// approved ruling on every pass — so this is the part that has to be exact.
// ---------------------------------------------------------------------------

function mockRuling(verdict, rationale, conditions) {
  return mockDirWith("rule", { text: '```json\n' + JSON.stringify({ verdict, rationale, conditions }) + '\n```' });
}

async function rule(dir, name, verdict, rationale, conditions = []) {
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockRuling(verdict, rationale, conditions);
  const ruled = await ruleByAgent(dir, name, { persona: "product-owner" });
  delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
  assert.equal(ruled.verdict, verdict, `${name} was ruled ${ruled.verdict}`);
  // An approval merges and leaves the caller on `main`; a return deliberately leaves the
  // proposal checked out for whoever has to act on it, and the next `sdlc run` has to
  // start from `main` the way a person running it would.
  if (verdict !== "approve") git(["checkout", "-q", "main"], dir);
  return ruled;
}

// The domain file with D-applications-2 recovered again: a different statement, a
// different `then`, and whatever confidence the fresh reading earned. Everything above it
// — R-1.1, once it has been minted — is carried across untouched, which is what a real
// recovery run writing the whole file back does.
function withCriterionRecovered(text, { confidence, note, version = 2 }) {
  const head = text.slice(0, text.indexOf("### D-applications-2"));
  return head + [
    `### D-applications-2 · v${version} · ${confidence} · recovered`,
    "When a permit application is accepted, the system shall store the intake fee the submitted permit type carries.",
    "- cites: src/routes.js:10",
    "- reconciliation: implemented-only",
    "- given: an accepted permit application",
    "- when: the application record is created",
    "- then: the fee for the submitted permit type is stored on the record",
    "- state: proposed",
    `- note: ${note}`,
    "",
  ].join("\n");
}

async function archaeologyWriting(dir, domainText, journal) {
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDirWith("archaeology", {
    text: `## Journal\n\n${journal}`,
    files: { "spec/domains/applications.md": domainText },
  });
  const r = await runStage(dir, "archaeology", { domain: "applications" });
  delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
  return r;
}

test("ratify: the ruling that sent a criterion back does not send it back again once it has been recovered", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-roundtrip-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    const recovered = withCriterionRecovered(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), {
      confidence: "inferred",
      note: "re-read src/routes.js:10: the stored fee is the submitted permit type's own",
    });
    assert.equal((await archaeologyWriting(dir, recovered, "The fee comes from the permit type; the row and its citation now say so.")).ok, true);
    // The ruling on the re-recovery is made on the numbered archaeology proposal a re-run
    // opens, and closing the criterion out there is the ordinary way it reaches the
    // contract — so `ratify` has to read that proposal's conditions as well as the first
    // proposal's and the follow-ups'.
    await rule(dir, "archaeology-applications-2", "approve", "the fee table in the README agrees with the route now that the row reads it correctly",
      ["confirm D-applications-2"]);

    const r = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    const text = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    // The recovery stands, and mints: the ruling that sent the row back is read again on
    // this pass and must do nothing, rather than re-pushing its note, dropping the row to
    // `open` and putting it back in a queue it had already left.
    assert.match(text, /### R-1\.2 · v2 · confirmed · recovered/);
    assert.match(text, /store the intake fee the submitted permit type carries/);
    assert.ok(!text.includes("sent back for re-recovery"), text);
    assert.ok(!/ · open · /.test(text), text);
    assert.equal(readRecoveryFor(dir, "applications").length, 1, "the request stays on file as the record, and is not filed again");
    assert.deepEqual(outstandingRecoveries(readRecoveryFor(dir, "applications"), parseDomainFile(text, "applications").criteria), []);

    const journal = readFileSync(join(dir, ".sdlc/journal/004-ratify.md"), "utf8");
    assert.ok(!/out for re-recovery/.test(journal), journal);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("the closing loop's bound reaches a criterion again once its re-recovery has come back", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-bound-lifts-"));
  const { dir, prevEgress } = await makeProject(tmp);
  setPolicy(dir, "loops: { ratify_follow_ups: { on_limit: obsolete } }");
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    // Recovered again, and still only `inferred`: an ordinary unresolved criterion, which
    // is exactly what the closing loop exists to chase.
    const recovered = withCriterionRecovered(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), {
      confidence: "inferred",
      note: "only the route shows which fee is stored; nothing else documents the fee schedule",
    });
    assert.equal((await archaeologyWriting(dir, recovered, "The fee comes from the permit type, on the route alone.")).ok, true);
    await rule(dir, "archaeology-applications-2", "approve", "the evidence is read correctly now, but one source is still one source", []);
    assert.equal((await runStage(dir, "ratify", { domain: "applications" })).ok, true);

    // The re-recovered criterion is an open question again, so the closing loop asks about
    // it: two follow-ups answered `contract` — the non-answer the bound exists for — are
    // what arms it.
    for (const n of [1, 2]) {
      await rule(dir, `ratify-applications-${n}`, "approve", "still one source; leaving it as recovered for now", ["contract D-applications-2"]);
      if (n === 1) assert.equal((await runStage(dir, "ratify", { domain: "applications" })).ok, true);
    }

    const r = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    const text = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(text, /- note: unresolved after two rulings/,
      "the exemption lifts when the re-recovery comes back: the bound must be able to close the loop");
    assert.match(text, /- state: obsolete/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ratify: two criteria in one domain can be sent back at once, each with its own reason", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-two-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const why1 = "the route rejects on a missing field, not on the applicant's age; nothing there reads an age at all";
  try {
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    assert.equal((await runStage(dir, "archaeology", { domain: "applications" })).ok, true);
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

    await rule(dir, "archaeology-applications", "approve", "neither criterion describes what the route does", [
      `recovery-wrong D-applications-1: ${why1}`,
      CONDITION,
    ]);
    const r = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    const entries = readRecoveryFor(dir, "applications");
    assert.deepEqual(entries.map((e) => e.id).sort(), ["D-applications-1", "D-applications-2"]);
    assert.equal(entries.find((e) => e.id === "D-applications-1").why, why1);
    assert.equal(entries.find((e) => e.id === "D-applications-2").why, WHY);

    const text = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(text, /### D-applications-1 · v1 · open · recovered/);
    assert.match(text, /### D-applications-2 · v1 · open · recovered/);
    assert.ok(text.includes(`- note: sent back for re-recovery: ${why1}`), text);
    assert.ok(text.includes(`- note: sent back for re-recovery: ${WHY}`), text);
    assert.ok(!text.includes("R-1."), "nothing mints out of a domain whose every criterion went back");

    const prompt = stageFor("archaeology").prompt({ domain: "applications", projectDir: dir });
    assert.match(prompt, /2 criterion\(s\) in this domain were sent back/);
    assert.ok(prompt.includes(why1) && prompt.includes(WHY));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ratify: a criterion whose re-recovery did not answer the question can be sent back again", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-twice-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const why2 = "the permit type is not read on this path either; the stored fee is a constant, and that is what the row has to say";
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    const recovered = withCriterionRecovered(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), {
      confidence: "inferred",
      note: "the route stores a fee the submitted permit type carries",
    });
    assert.equal((await archaeologyWriting(dir, recovered, "Re-read the intake route; the fee follows the permit type.")).ok, true);
    await rule(dir, "archaeology-applications-2", "approve", "closer, and still not what the route does", [`recovery-wrong D-applications-2: ${why2}`]);

    const r = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    const entries = readRecoveryFor(dir, "applications");
    assert.equal(recoveryRequestCount(entries, "D-applications-2"), 2, "a second reason is a second request, not a repeat of the first");
    const text = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(text, /### D-applications-2 · v2 · open · recovered/);
    assert.ok(text.includes(`- note: sent back for re-recovery: ${why2}`), text);

    // Only the latest reason is owed, and the count is what makes a row that keeps coming
    // back legible as a problem rather than as routine.
    assert.deepEqual(outstandingRecoveries(entries, parseDomainFile(text, "applications").criteria).map((e) => e.why), [why2]);
    const journal = readFileSync(join(dir, ".sdlc/journal/004-ratify.md"), "utf8");
    assert.match(journal, /D-applications-2 \(sent back 2 times\)/);
    assert.ok(stageFor("archaeology").prompt({ domain: "applications", projectDir: dir }).includes(why2));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("archaeology --revise: a minted criterion that was sent back may be rewritten, and only that one", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-minted-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const whyMinted = "the age comparison in the route is inside a branch the request never reaches, so no application is rejected for age";
  try {
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    assert.equal((await runStage(dir, "archaeology", { domain: "applications" })).ok, true);
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

    // D-applications-1 arrives `confirmed`, so it mints on the first pass and the ruling
    // that sends it back is ruling on a permanent id.
    await rule(dir, "archaeology-applications", "approve", "the age minimum is evidenced twice; the fee is not settled", []);
    assert.equal((await runStage(dir, "ratify", { domain: "applications" })).ok, true);
    assert.match(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), /### R-1\.1 · v1 · confirmed · recovered/);

    await rule(dir, "ratify-applications-1", "approve", "the age minimum does not survive a second reading of the route", [`recovery-wrong R-1.1: ${whyMinted}`]);
    assert.equal((await runStage(dir, "ratify", { domain: "applications" })).ok, true);

    const afterSendBack = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(afterSendBack, /### R-1\.1 · v1 · confirmed · recovered/, "a minted row keeps its permanent id and its confidence");
    assert.ok(afterSendBack.includes(`- note: sent back for re-recovery: ${whyMinted}`), afterSendBack);
    assert.equal(readRecoveryFor(dir, "applications")[0].id, "R-1.1");

    // A returned follow-up is what a `--revise` run acts on; the sent-back minted row is
    // still outstanding while it runs.
    await rule(dir, "ratify-applications-2", "return", "the fee criterion has no evidence behind it either", []);

    const revised = afterSendBack
      .replace("the system shall reject it unless the applicant is at least 19 years old.",
        "the system shall record the applicant's stated age without rejecting the application.")
      .replace("- then: the application is rejected with an error and no record is created",
        "- then: the application is stored with the stated age and no age check is applied");
    assert.notEqual(revised, afterSendBack);

    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDirWith("archaeology", {
      text: "## Journal\n\nThe age branch is unreachable; R-1.1 now records what the route actually does with an age.",
      files: { "spec/domains/applications.md": revised },
    });
    const r = await runStage(dir, "archaeology", { domain: "applications", revise: true });
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    onBranch(dir, r.proposal.branch, () => {
      const text = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
      assert.match(text, /record the applicant's stated age without rejecting the application/);
      assert.deepEqual(outstandingRecoveries(readRecoveryFor(dir, "applications"), parseDomainFile(text, "applications").criteria), []);
    });
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("archaeology --revise: a minted criterion nobody sent back is still refused", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-minted-guard-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    assert.equal((await runStage(dir, "archaeology", { domain: "applications" })).ok, true);
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

    await rule(dir, "archaeology-applications", "approve", "the age minimum is evidenced twice; the fee is not settled", []);
    assert.equal((await runStage(dir, "ratify", { domain: "applications" })).ok, true);
    await rule(dir, "ratify-applications-1", "return", "the fee criterion has no evidence behind it", []);

    const minted = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    const tampered = minted.replace("the system shall reject it unless the applicant is at least 19 years old.",
      "the system shall reject it unless the applicant is at least 21 years old.");
    assert.notEqual(tampered, minted);

    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDirWith("archaeology", {
      text: "## Journal\n\nRaised the age minimum while revising the fee criterion.",
      files: { "spec/domains/applications.md": tampered },
    });
    const r = await runStage(dir, "archaeology", { domain: "applications", revise: true });
    assert.equal(r.ok, false, "the permanent record is only ever open to a revision where a ruling sent it back");
    assert.ok(r.messages.some((m) => /R-1\.1 changed; a revision may not alter an already-minted criterion/.test(m)), r.messages.join(" | "));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("the runner hands archaeology the project, so a real run's prompt carries the re-recovery block", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-wiring-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const logs = [];
  const origLog = console.log;
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    // A dry run builds the prompt exactly as a real run does and prints it, which is the
    // only way to see the prompt the runner's own `ctx` produces rather than one the test
    // assembled by hand.
    console.log = (...a) => logs.push(a.join(" "));
    const r = await runStage(dir, "archaeology", { domain: "applications", dryRun: true });
    console.log = origLog;
    assert.equal(r.dryRun, true, JSON.stringify(r.messages));
    const printed = logs.join("\n");
    assert.ok(printed.includes(WHY), "the runner's ctx reaches stage.prompt, or a live agent is never told what to recover again");
    assert.match(printed, /D-applications-2 \(as recovered at v1\)/);
  } finally {
    console.log = origLog;
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("resume: the repair turn after a failed archaeology run is told what it is recovering again", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-resume-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const promptFile = join(tmp, "fix-turn-prompt.txt");
  const origLog = console.log;
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    // The state an interrupted `archaeology` run leaves behind: its post-checks never
    // ran. They fail here, because the criterion it was told to recover again is still
    // the one that went out — so `finishStage` takes its one repair turn, and that turn's
    // prompt is built from the `ctx` `resume` assembles rather than the one `runStage`
    // did.
    writeFileSync(join(dir, ".sdlc/run-state.json"),
      JSON.stringify({ stage: "archaeology", ctx: { domain: "applications" }, phase: "post-checks" }) + "\n");

    const recovered = withCriterionRecovered(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), {
      confidence: "inferred",
      note: "re-read src/routes.js:10 on the repair turn: the stored fee follows the permit type",
    });
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDirWith("archaeology", {
      text: "## Journal\n\nCorrected the fee criterion against the route.",
      files: { "spec/domains/applications.md": recovered },
    });
    process.env.SDLC_MOCK_PROMPT_FILE = promptFile;

    console.log = () => {};
    const code = await resume(dir, { again: true });
    console.log = origLog;
    assert.equal(code, 0);

    const asked = readFileSync(promptFile, "utf8");
    assert.ok(asked.includes(WHY), "a resumed run's repair turn is told which criteria it is recovering again, and why");
    assert.match(asked, /recovering it again rather than discovering it/);
  } finally {
    console.log = origLog;
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR; delete process.env.SDLC_MOCK_PROMPT_FILE;
    restoreEgress(prevEgress);
  }
});

test("applyConditions: a ruling that both confirms and sends back the same criterion behaves the same on every pass", () => {
  // Contradictory conditions on one id are the persona's mistake, not the reader's, and
  // the last one wins — but whichever way it resolves it has to resolve the same way
  // every pass, or a criterion sent back on one run mints on the next with nothing
  // changing in between. The request is what decides: it is unanswered, so it still
  // applies, and it still applies over the `confirm` that shares the ruling with it.
  const lines = ["confirm D-content-1", "recovery-wrong D-content-1: the guard sits behind a check that is always false"];
  const first = applyConditions([criterion()], lines).criteria;
  assert.equal(first[0].confidence, "open");

  const filed = [{
    id: "D-content-1", domain: "content", version: first[0].version,
    why: "the guard sits behind a check that is always false",
  }];
  const second = applyConditions(first, lines, filed).criteria;
  assert.equal(second[0].confidence, "open", "the request is still outstanding, so the row stays where it was put");
  assert.deepEqual(second[0].notes, first[0].notes);
});

// ---------------------------------------------------------------------------
// What answers a request, and what does not. "Archaeology went back to the old
// application for this row" is the fact; "the row reads differently now" is a
// different one, and the two come apart the moment any other verb touches the row.
// ---------------------------------------------------------------------------

test("a criterion out for re-recovery stays out when another ruling edits or spikes it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-spiked-"));
  const { dir, prevEgress } = await makeProject(tmp);
  setPolicy(dir, "loops: { ratify_follow_ups: { on_limit: obsolete } }");
  try {
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    assert.equal((await runStage(dir, "archaeology", { domain: "applications" })).ok, true);
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

    // One criterion goes back; the other is left unresolved, which is what keeps the
    // closing loop running so there are follow-ups to rule at all.
    await rule(dir, "archaeology-applications", "approve", "the fee criterion is not a record of this application; the age minimum is not settled either",
      [CONDITION, "spike D-applications-1: is the age minimum still the policy, or inherited from the paper form?"]);
    assert.equal((await runStage(dir, "ratify", { domain: "applications" })).ok, true);

    // Two follow-ups that touch the sent-back row for reasons of their own. A spike adds
    // its question as a note; an edit rewrites the statement and would ordinarily raise
    // confidence to `confirmed`. Neither is anybody going back to the old application.
    await rule(dir, "ratify-applications-1", "approve", "worth asking where the fee belongs, and still waiting on the age policy",
      ["spike D-applications-2: does the fee belong to this domain or to fees?",
        "spike D-applications-1: still waiting on the policy owner"]);
    assert.equal((await runStage(dir, "ratify", { domain: "applications" })).ok, true);
    await rule(dir, "ratify-applications-2", "approve", "the fee wording was loose either way, and the age minimum is still unanswered",
      ["edit D-applications-2: When a permit application is accepted, the system shall calculate an intake fee for it.",
        "spike D-applications-1: still waiting on the policy owner"]);
    const r = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    const text = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    const criteria = parseDomainFile(text, "applications").criteria;
    const entries = readRecoveryFor(dir, "applications");
    assert.equal(outstandingRecoveries(entries, criteria).length, 1,
      "only an archaeology run answers a request; an edit or a spike on the row is not one");

    const sentBack = criteria.find((c) => c.id === "D-applications-2");
    // The edit's wording stands — the ruler said something true about the sentence — but
    // the row must not reach the contract while its evidence is known to be wrong.
    assert.match(sentBack.statement, /shall calculate an intake fee for it\.$/);
    assert.equal(sentBack.confidence, "open");
    assert.equal(sentBack.state, "proposed");
    assert.ok(sentBack.notes.some((n) => n.startsWith("sent back for re-recovery: ")), sentBack.notes.join(" | "));
    assert.ok(!sentBack.notes.includes("unresolved after two rulings"),
      "a criterion waiting on archaeology is not answering follow-ups and must not be swept for it");

    // The criterion beside it, asked twice and answered with a non-answer twice, is swept
    // exactly as it always was: the bound still closes the loop on everything that is
    // genuinely the ruler's to decide.
    const spiked = criteria.find((c) => c.id === "D-applications-1");
    assert.equal(spiked.state, "obsolete");
    assert.ok(spiked.notes.includes("unresolved after two rulings"), spiked.notes.join(" | "));

    assert.ok(stageFor("archaeology").prompt({ domain: "applications", projectDir: dir }).includes(WHY),
      "the reason still reaches the stage that has to act on it");
    assert.match(readFileSync(join(dir, ".sdlc/journal/004-ratify.md"), "utf8"), /out for re-recovery/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ratify: one ruling can send a criterion back for two separate reasons, and both are owed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-two-reasons-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const whyB = "the citation points at the line that stores the record, not at anything that computes a fee";
  try {
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    assert.equal((await runStage(dir, "archaeology", { domain: "applications" })).ok, true);
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

    await rule(dir, "archaeology-applications", "approve", "two separate things are wrong with the fee criterion",
      [CONDITION, `recovery-wrong D-applications-2: ${whyB}`]);
    assert.equal((await runStage(dir, "ratify", { domain: "applications" })).ok, true);

    const entries = readRecoveryFor(dir, "applications");
    assert.equal(entries.length, 2, "each reason is its own request; keeping only the last would leave the first unanswerable");
    assert.deepEqual(entries.map((e) => e.why).sort(), [WHY, whyB].sort());
    const text = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.ok(text.includes(`- note: sent back for re-recovery: ${WHY}`), text);
    assert.ok(text.includes(`- note: sent back for re-recovery: ${whyB}`), text);

    const prompt = stageFor("archaeology").prompt({ domain: "applications", projectDir: dir });
    assert.ok(prompt.includes(WHY) && prompt.includes(whyB), "the stage that has to redo the work is told both things");

    // One recovery answers everything that was owed on the row it recovered, and the
    // ruling then stops firing entirely — neither reason sends the row back a second time.
    const recovered = withCriterionRecovered(text, {
      confidence: "confirmed", note: "re-read src/routes.js:10: the stored fee is the permit type's own, and the README's fee table agrees",
    });
    const redone = await archaeologyWriting(dir, recovered, "Both readings corrected against the route.");
    assert.equal(redone.ok, true);
    assert.deepEqual(onBranch(dir, redone.proposal.branch, () => readRecoveryFor(dir, "applications").map((e) => e.answered)),
      [{ version: 2 }, { version: 2 }]);

    await rule(dir, "archaeology-applications-2", "approve", "the fee criterion now matches the route and the fee table", []);
    assert.equal((await runStage(dir, "ratify", { domain: "applications" })).ok, true);
    const after = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(after, /### R-1\.2 · v2 · confirmed · recovered/);
    assert.ok(!after.includes("sent back for re-recovery"), after);
    assert.equal(readRecoveryFor(dir, "applications").length, 2, "no third request is filed by a ruling that has been answered");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("archaeology: a run may not rewrite the record of what was sent back", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-ledger-guard-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    // The session drops the request instead of doing the work. The ledger is under
    // `spec/`, which an archaeology run may otherwise write freely.
    const recovered = withCriterionRecovered(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), {
      confidence: "inferred", note: "the stored fee follows the permit type",
    });
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDirWith("archaeology", {
      text: "## Journal\n\nTidied the recovery list.",
      files: { "spec/domains/applications.md": recovered, "spec/recovery.yaml": "recovery: []\n" },
    });

    const r = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /spec\/recovery\.yaml gained or lost entries/.test(m)), r.messages.join(" | "));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("archaeology: a run that marks its own request answered without doing the work is still refused", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-forged-stamp-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    // A stamp the session writes itself is shaped exactly like the runner's, so the guard
    // above cannot tell them apart — and does not have to. What a run was asked to recover
    // is read from the ledger as `HEAD` holds it, so stamping the request in the working
    // tree changes nothing about what this run is judged on, and the row is still
    // unchanged.
    const unchanged = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    const ledger = readFileSync(join(dir, "spec/recovery.yaml"), "utf8").replace(/\n$/, "\n    answered:\n      version: 1\n");
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDirWith("archaeology", {
      text: "## Journal\n\nNothing to change.",
      files: { "spec/domains/applications.md": unchanged, "spec/recovery.yaml": ledger },
    });

    const r = await runStage(dir, "archaeology", { domain: "applications" });
    assert.equal(r.ok, false);
    assert.ok(r.messages.some((m) => /D-applications-2 was sent back for re-recovery/.test(m)), r.messages.join(" | "));
    // And the forgery does not survive the failed run: a failed run commits only its
    // journal and run record, so the recorded ledger still shows the request owed and the
    // next attempt is judged against that.
    assert.ok(!git(["show", "HEAD:spec/recovery.yaml"], dir).includes("answered"),
      "what a run was asked to recover is read from the recorded ledger, never from the tree it wrote");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("two domains can carry re-recovery requests at once without answering each other's", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-domains-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const feesWhy = "the quote page reads a rate table that this release does not ship; nothing computes a quote here";
  const feesDomain = [
    "# fees",
    "",
    "### D-fees-1 · v1 · inferred · recovered",
    "When a visitor asks for a fee quote, the system shall calculate the quote from the applicant's age.",
    "- cites: src/routes.js:10",
    "- reconciliation: implemented-only",
    "- given: a visitor on the fee quote page",
    "- when: a quote is asked for",
    "- then: a quote calculated from the applicant's age is shown",
    "- state: proposed",
    "",
  ].join("\n");
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDirWith("archaeology", {
      text: "## Journal\n\nThe fees domain quotes a fee for a permit type.",
      files: { "spec/domains/fees.md": feesDomain },
    });
    const feesRun = await runStage(dir, "archaeology", { domain: "fees" });
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    assert.equal(feesRun.ok, true, JSON.stringify(feesRun.messages));
    await rule(dir, "archaeology-fees", "approve", "the quote criterion describes a page this release does not have", [`recovery-wrong D-fees-1: ${feesWhy}`]);
    assert.equal((await runStage(dir, "ratify", { domain: "fees" })).ok, true);

    assert.deepEqual(readRecoveryFor(dir, "applications").map((e) => e.id), ["D-applications-2"]);
    assert.deepEqual(readRecoveryFor(dir, "fees").map((e) => e.id), ["D-fees-1"]);
    assert.ok(!stageFor("archaeology").prompt({ domain: "applications", projectDir: dir }).includes(feesWhy),
      "one domain's prompt never carries another domain's request");
    assert.ok(stageFor("archaeology").prompt({ domain: "fees", projectDir: dir }).includes(feesWhy));

    // Answering the fees domain leaves the applications request exactly where it was.
    const recoveredFees = feesDomain.replace(
      "When a visitor asks for a fee quote, the system shall calculate the quote from the applicant's age.",
      "When a visitor asks for a fee quote, the system shall show the fee the chosen permit type carries.");
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDirWith("archaeology", {
      text: "## Journal\n\nThe quote comes from the permit type.",
      files: { "spec/domains/fees.md": recoveredFees },
    });
    const revised = await runStage(dir, "archaeology", { domain: "fees" });
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    assert.equal(revised.ok, true, JSON.stringify(revised.messages));

    onBranch(dir, revised.proposal.branch, () => {
      assert.deepEqual(readRecoveryFor(dir, "fees").map((e) => e.answered), [{ version: 1 }]);
      assert.deepEqual(readRecoveryFor(dir, "applications").map((e) => e.answered), [undefined]);
    });
    assert.ok(stageFor("archaeology").prompt({ domain: "applications", projectDir: dir }).includes(WHY));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("ratify reads a ruling whose gate file records no time, after the ones that do", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-no-at-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    // A gate file written by hand rather than by `sdlc rule` carries no `at`. It is read
    // last, and its verdict still applies — a ruling nobody can date is not a ruling
    // nobody made.
    writeFileSync(join(dir, ".sdlc/gates/ratify-applications-1.yaml"),
      "gate: G1\nverdict: approve\nby: product-owner\nheld_by: agent\nrationale: |2-\n  the age minimum is worth stating in full\nconditions:\n  - \"edit R-1.1: When an applicant submits a permit application, the system shall reject it unless the applicant is at least 19 years old on the day of submission.\"\n");
    git(["add", "-A"], dir);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "record a ruling made by hand"], dir);

    const r = await runStage(dir, "ratify", { domain: "applications" });
    assert.equal(r.ok, true, JSON.stringify(r.messages));
    assert.match(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), /at least 19 years old on the day of submission/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("archaeology --revise: a sent-back minted criterion may be rewritten, never removed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-minted-removal-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const whyMinted = "the age comparison in the route is inside a branch the request never reaches, so no application is rejected for age";
  try {
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    assert.equal((await runStage(dir, "archaeology", { domain: "applications" })).ok, true);
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

    await rule(dir, "archaeology-applications", "approve", "the age minimum is evidenced twice; the fee is not settled", []);
    assert.equal((await runStage(dir, "ratify", { domain: "applications" })).ok, true);
    await rule(dir, "ratify-applications-1", "approve", "the age minimum does not survive a second reading of the route", [`recovery-wrong R-1.1: ${whyMinted}`]);
    assert.equal((await runStage(dir, "ratify", { domain: "applications" })).ok, true);
    await rule(dir, "ratify-applications-2", "return", "the fee criterion has no evidence behind it either", []);

    const withMinted = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    const withoutMinted = withMinted.slice(withMinted.indexOf("### D-applications-2"));
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDirWith("archaeology", {
      text: "## Journal\n\nThe age behaviour is not in the application, so the criterion is gone.",
      files: { "spec/domains/applications.md": `# applications\n\n${withoutMinted}` },
    });

    const r = await runStage(dir, "archaeology", { domain: "applications", revise: true });
    assert.equal(r.ok, false, "a permanent id the contract and its tests point at is not a recovery's to delete");
    assert.ok(r.messages.some((m) => /R-1\.1 is missing; a revision may not remove an already-minted criterion/.test(m)), r.messages.join(" | "));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("resume: a run that died between the stamp and its commit finishes, and is not blamed for the stamp", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-resume-stamp-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const origLog = console.log;
  const logs = [];
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    // The tree a run leaves when it dies after its post-checks passed and before
    // `finishStage` committed: the recovered domain file, and the stamp the runner writes
    // on its way out. Both are the runner's own work, and the retry has to be able to tell
    // that.
    const domainFile = join(dir, "spec/domains/applications.md");
    const recovered = withCriterionRecovered(readFileSync(domainFile, "utf8"), {
      confidence: "inferred", note: "re-read src/routes.js:10: the stored fee follows the permit type",
    });
    writeFileSync(domainFile, recovered);
    answerRecoveries(dir, "applications", ["D-applications-2"],
      new Map(parseDomainFile(recovered, "applications").criteria.map((c) => [c.id, c])));
    assert.match(readFileSync(join(dir, "spec/recovery.yaml"), "utf8"), /answered/);
    writeFileSync(join(dir, ".sdlc/run-state.json"),
      JSON.stringify({ stage: "archaeology", ctx: { domain: "applications" }, phase: "post-checks" }) + "\n");

    // A canned turn stands in for the repair turn a post-check failure would take, so the
    // test measures whether the checks pass rather than whether something cleaned up after
    // them. It writes nothing: a run whose checks pass never reaches it.
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDirWith("archaeology", { text: "nothing to repair" });

    console.log = (...a) => logs.push(a.join(" "));
    const code = await resume(dir, { again: true });
    console.log = origLog;
    assert.equal(code, 0, logs.join(" | "));
    assert.ok(!logs.join(" ").includes("is not a run's to write"), logs.join(" | "));
    assert.ok(!/post-checks failed/.test(git(["log", "-1", "--pretty=%s"], dir)), git(["log", "-1", "--pretty=%s"], dir));
    // And nothing is left dirty, so the next run is not wedged behind a ledger somebody
    // has to hand-revert.
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.deepEqual(onBranch(dir, "proposal/archaeology-applications-2", () => readRecoveryFor(dir, "applications").map((e) => e.answered)),
      [{ version: 2 }]);
  } finally {
    console.log = origLog;
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("a re-recovery nobody approved answers nothing: the stamp lands on the proposal, not on main", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-returned-"));
  const { dir, prevEgress } = await makeProject(tmp);
  try {
    assert.equal((await ratifyWithOneSentBack(dir)).ok, true);

    const recovered = withCriterionRecovered(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), {
      confidence: "inferred", note: "the stored fee follows the permit type",
    });
    const redone = await archaeologyWriting(dir, recovered, "Re-read the intake route.");
    assert.equal(redone.ok, true);
    // On the proposal branch the work is done and the request is stamped.
    assert.deepEqual(onBranch(dir, redone.proposal.branch, () => readRecoveryFor(dir, "applications").map((e) => e.answered)),
      [{ version: 2 }]);

    await rule(dir, "archaeology-applications-2", "return", "the fee schedule is documented in the README and this still does not cite it", []);

    // A return merges nothing, so `main` carries neither the recovery nor its stamp: the
    // request is owed exactly as it was, and the next run is told about it.
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.deepEqual(readRecoveryFor(dir, "applications").map((e) => e.answered), [undefined]);
    assert.match(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), /calculate an intake fee for it from the applicant's age/);
    assert.ok(stageFor("archaeology").prompt({ domain: "applications", projectDir: dir }).includes(WHY));
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("a recovery that finds the behaviour is not there at all removes the row, and the request records that", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-removed-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const feesWhy = "nothing on this path reads a rate table; the quote shown is the permit type's own fee and this criterion describes a screen the release does not have";
  const feesBlock = [
    "### D-fees-2 · v1 · confirmed · recovered",
    "When a visitor asks for a fee quote, the system shall show the fee the chosen permit type carries.",
    "- cites: src/routes.js:10",
    "- reconciliation: implemented-only",
    "- given: a visitor on the fee quote page",
    "- when: a quote is asked for",
    "- then: the fee the chosen permit type carries is shown",
    "- state: proposed",
    "",
  ].join("\n");
  const feesDomain = [
    "# fees",
    "",
    "### D-fees-1 · v1 · inferred · recovered",
    "When a visitor asks for a fee quote, the system shall look the quote up in a published rate table.",
    "- cites: src/routes.js:4",
    "- reconciliation: documented-only",
    "- given: a visitor on the fee quote page",
    "- when: a quote is asked for",
    "- then: the rate table's entry for that permit type is shown",
    "- state: proposed",
    "",
    feesBlock,
  ].join("\n");
  try {
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDirWith("archaeology", {
      text: "## Journal\n\nThe fees domain quotes a fee for a permit type.",
      files: { "spec/domains/fees.md": feesDomain },
    });
    assert.equal((await runStage(dir, "archaeology", { domain: "fees" })).ok, true);
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;

    await rule(dir, "archaeology-fees", "approve", "the rate table criterion describes something this release does not do", [`recovery-wrong D-fees-1: ${feesWhy}`]);
    assert.equal((await runStage(dir, "ratify", { domain: "fees" })).ok, true);
    assert.match(readFileSync(join(dir, "spec/domains/fees.md"), "utf8"), /### R-2\.1 · v1 · confirmed · recovered/);

    // The recovery finds nothing behind the criterion and drops the row. That answers the
    // request as surely as a rewrite does — there is no row left to recover — and the
    // ledger records which of the two happened.
    process.env.SDLC_EXECUTOR = "mock";
    const ratified = readFileSync(join(dir, "spec/domains/fees.md"), "utf8");
    process.env.SDLC_MOCK_DIR = mockDirWith("archaeology", {
      text: "## Journal\n\nThere is no rate table in this release; the criterion had nothing behind it.",
      files: { "spec/domains/fees.md": `# fees\n\n${ratified.slice(ratified.indexOf("### R-2.1"))}` },
    });
    const r = await runStage(dir, "archaeology", { domain: "fees" });
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    assert.equal(r.ok, true, JSON.stringify(r.messages));

    onBranch(dir, r.proposal.branch, () => {
      const text = readFileSync(join(dir, "spec/domains/fees.md"), "utf8");
      assert.ok(!text.includes("D-fees-1"), text);
      assert.deepEqual(readRecoveryFor(dir, "fees").map((e) => e.answered), [{ removed: true }]);
      assert.deepEqual(outstandingRecoveries(readRecoveryFor(dir, "fees"), parseDomainFile(text, "fees").criteria), []);
    });
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

// The ledger is the record of what was sent back, and a run may leave exactly one mark in
// it: the answer it was itself owed. Every other shape of change is a session writing the
// record of its own work, which is how a recovery gets marked done without being done.
test("the ledger guard permits only the answer this run was owed", async () => {
  const { unexpectedLedgerChange, keyOf } = await import("../src/spec/recovery.mjs");
  const head = [
    { id: "D-a-1", domain: "a", version: 1, why: "the guard cannot fire" },
    { id: "D-a-2", domain: "a", version: 1, why: "the citation is dead code" },
  ];
  const owed = new Set(head.map(keyOf));
  const clone = () => JSON.parse(JSON.stringify(head));

  assert.equal(unexpectedLedgerChange(head, clone(), owed), null, "an untouched ledger is fine");

  const answered = clone();
  answered[0].answered = { version: 2 };
  assert.equal(unexpectedLedgerChange(head, answered, owed), null, "the answer it was owed is the one permitted change");

  // An answer already recorded is not this run's to revise: a request is answered once, by
  // the run that did the work.
  const already = clone();
  already[0].answered = { version: 2 };
  const revised = JSON.parse(JSON.stringify(already));
  revised[0].answered = { version: 7 };
  assert.match(unexpectedLedgerChange(already, revised, owed), /changes an answer already recorded for D-a-1/);

  // An answer on a request this run was never asked to recover.
  const notOwed = clone();
  notOwed[1].answered = { version: 2 };
  assert.match(unexpectedLedgerChange(head, notOwed, new Set([keyOf(head[0])])), /marks D-a-2 answered, which this run was not asked to recover/);

  // The shapes that are never a run's to make.
  const reworded = clone();
  reworded[1].why = "a reason the run preferred";
  assert.match(unexpectedLedgerChange(head, reworded, owed), /entry 2 was rewritten/);
  assert.match(unexpectedLedgerChange(head, [head[0]], owed), /gained or lost entries/);
});

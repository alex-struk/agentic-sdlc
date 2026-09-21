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
import { addRecovery, outstandingRecoveries, readRecovery, readRecoveryFor, recoveryRequestCount } from "../src/spec/recovery.mjs";

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
  assert.equal(c.recoveryRequested, "the guard sits behind a check that is always false");
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

test("a recovery request is outstanding until the criterion it names actually changes", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-file-"));
  const c = criterion({ confidence: "open" });
  const entry = { id: c.id, domain: "content", version: c.version, why: "the guard can never run", fingerprint: criterionFingerprint(c) };

  assert.equal(addRecovery(tmp, [entry]), "spec/recovery.yaml");
  assert.equal(addRecovery(tmp, [entry]), null, "the same request is filed once, however often the ruling is replayed");
  assert.equal(readRecovery(tmp).length, 1);
  assert.deepEqual(readRecoveryFor(tmp, "other-domain"), []);

  const entries = readRecoveryFor(tmp, "content");
  assert.deepEqual(outstandingRecoveries(entries, [c]).map((e) => e.id), ["D-content-1"]);
  // Any change to the evidence answers it: a corrected statement, a corrected citation, or
  // a note recording that the evidence was read again and holds.
  assert.deepEqual(outstandingRecoveries(entries, [{ ...c, notes: ["re-read src/x.js:4; the guard does run on the anonymous path"] }]), []);
  assert.deepEqual(outstandingRecoveries(entries, [{ ...c, cites: [{ path: "src/y.js", line: 9 }] }]), []);
  assert.deepEqual(outstandingRecoveries(entries, []), [], "a criterion the recovery removed answers its request by being gone");

  // A second reason on the same row is a second request — the first re-recovery did not
  // answer it — and only the latest is owed.
  addRecovery(tmp, [{ ...entry, why: "and the citation points at a file the release never shipped" }]);
  const both = readRecoveryFor(tmp, "content");
  assert.equal(recoveryRequestCount(both, "D-content-1"), 2);
  assert.deepEqual(outstandingRecoveries(both, [c]).map((e) => e.why), ["and the citation points at a file the release never shipped"]);
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

    const { criteria } = parseDomainFile(readFileSync(join(dir, "spec/domains/applications.md"), "utf8"), "applications");
    const entries = readRecoveryFor(dir, "applications");
    assert.equal(entries.length, 1, "the request stays on file as the record that it was made");
    assert.deepEqual(outstandingRecoveries(entries, criteria), [], "and is answered by the criterion no longer being the one that went out");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

test("the closing loop's bound never force-obsoletes a criterion that is out for re-recovery", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-recovery-sweep-"));
  const { dir, prevEgress } = await makeProject(tmp);
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
    // `open` and restoring the fingerprint that says the work is still owed.
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

    const text = readFileSync(join(dir, "spec/domains/applications.md"), "utf8");
    assert.match(text, /record the applicant's stated age without rejecting the application/);
    assert.deepEqual(outstandingRecoveries(readRecoveryFor(dir, "applications"), parseDomainFile(text, "applications").criteria), []);
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
  // changing in between.
  const lines = ["confirm D-content-1", "recovery-wrong D-content-1: the guard sits behind a check that is always false"];
  const first = applyConditions([criterion()], lines).criteria;
  assert.equal(first[0].confidence, "open");

  const filed = [{
    id: "D-content-1", domain: "content", version: first[0].version,
    why: "the guard sits behind a check that is always false", fingerprint: criterionFingerprint(first[0]),
  }];
  const second = applyConditions(first, lines, filed).criteria;
  assert.equal(second[0].confidence, "open", "the request is still outstanding, so the row stays where it was put");
  assert.deepEqual(second[0].notes, first[0].notes);
});

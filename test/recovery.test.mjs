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

// test/ruling-conditions.test.mjs — the ledger of instructions a ruling wrote down.
//
// Builds its own minimal fixture project the way test/gates.test.mjs does, rather than
// importing that file: each test file owns its own setup so a change to one never has to
// reckon with what another file's helpers happen to assume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { git } from "../src/lib/git.mjs";
import { propose } from "../src/commands/propose.mjs";
import { rule } from "../src/commands/rule.mjs";
import { runChecks } from "../src/checks/index.mjs";
import { checkConditions } from "../src/checks/conditions.mjs";
import { CONDITIONS_PATH, readConditions, openConditions } from "../src/spec/conditions.mjs";
import { addRevisionRequests } from "../src/spec/revisions.mjs";
import { ruleByAgent } from "../src/commands/rule.mjs";
import { newProject } from "../src/commands/new.mjs";
import { fileURLToPath } from "node:url";

const FROM = fileURLToPath(new URL("../fixture-project/fixture.config.yaml", import.meta.url));

// The fixture project, whose G3 is held by the reviewer persona: the agent seat's own
// rulings are what the last two tests are about. The egress name list is isolated the way
// every other test file that calls `newProject` isolates it.
async function agentProject(tmp) {
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

function mockRule(...replies) {
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-rule-"));
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify(replies.length === 1
    ? { text: replies[0] }
    : { sequence: replies.map((text) => ({ text })) }));
  return mockDir;
}

const reply = (verdict, rationale, conditions) =>
  `Read the branch.\n\n\`\`\`json\n${JSON.stringify({ verdict, rationale, conditions })}\n\`\`\``;

const CONFIG = `
pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: p, domains: [a] }
policy:
  gates:
    G0: { holder: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: tech-lead }
    G3: { holder: tech-lead }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;

// A condition that names no file: what a plain condition may ask for is settled elsewhere
// (`assertDeliverableRulable`), and these tests are about what happens to it afterwards.
const MOVE = "the second slice claims a criterion nothing it builds can demonstrate; move it to a later one";
const NARROW = "narrow the third test to what its criterion states and no further";

function project() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-conditions-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d);
  git(["config", "user.name", "t"], d);
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), CONFIG);
  writeFileSync(join(d, "README.md"), "x");
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "init"], d);
  return d;
}

function openAndReturn(d, name, conditions) {
  propose(d, name, { gate: "G3", question: "Does it?", recommendation: "No." });
  const r = rule(d, name, "return", { by: "tech-lead", note: "sent back", conditions });
  // A return ends on the proposal branch, for whoever has to act on it. The ledger is a fact
  // about the project rather than about the proposal and lives on `main`, which is where the
  // check and the next run read it, so that is where these tests read it too.
  git(["checkout", "-q", "main"], d);
  return r;
}

const ledger = (d) => readConditions(d);
const conditionsCheck = (d) => checkConditions(d);

test("a return's plain conditions land on the ledger, each with a reference a later ruling can name", () => {
  const d = project();
  const r = openAndReturn(d, "derive-tests-applications", [MOVE, NARROW]);
  assert.deepEqual(r.opened, ["derive-tests-applications#1", "derive-tests-applications#2"]);

  const rows = ledger(d);
  assert.deepEqual(rows.map((c) => c.ref), ["derive-tests-applications#1", "derive-tests-applications#2"]);
  assert.equal(rows[0].text, MOVE);
  assert.equal(rows[0].stage, "derive-tests", "the stage the return goes back to");
  assert.equal(rows[0].family, "derive-tests-applications",
    "the line of work, so a later approval of another domain's tests does not read as an answer to this");
  assert.equal(rows[0].gate, "G3");
  assert.equal(rows[0].by, "tech-lead");
  assert.ok(rows[0].at, "the order of events is what tells an owed instruction from an overtaken one");
  assert.ok(!rows[0].closed);

  // On `main`, in its own commit, where the ledger is read from — a copy on a branch nobody
  // merges would never be read at all.
  assert.ok(existsSync(join(d, CONDITIONS_PATH)));
  assert.match(git(["log", "--pretty=%s", "main"], d), /rule\(G3\): derive-tests-applications owes derive-tests-applications#1, derive-tests-applications#2/);
});

test("an approval's conditions, and the two cross-stage forms, are not owed by anybody", () => {
  const d = project();
  // An approval's conditions are commentary no revise run reads, so there is nothing to owe.
  propose(d, "derive-tests-a", { gate: "G3", question: "Does it?", recommendation: "Yes." });
  const approved = rule(d, "derive-tests-a", "approve", { by: "tech-lead", conditions: ["worth watching next time"] });
  assert.deepEqual(approved.opened ?? [], []);
  assert.deepEqual(ledger(d), []);

  // Each cross-stage form already has a ledger that follows it from filing to consumption,
  // and a second row here would be a second thing to close for one instruction.
  const returned = openAndReturn(d, "derive-tests-b", [
    "addressed-to plan: the slice claims a criterion nothing it builds can demonstrate",
    "test-overreaches R-1.2: the test reads an audit log the criterion never names",
  ]);
  assert.deepEqual(returned.opened, []);
  assert.deepEqual(ledger(d), []);
});

test("a ruling whose conditions are a closed grammar files nothing: its own stage already follows them", () => {
  const d = project();
  propose(d, "archaeology-a", { gate: "G1", question: "Is this the domain?", recommendation: "No." });
  const r = rule(d, "archaeology-a", "return", { by: "tech-lead", conditions: ["confirm D-a-1"] });
  assert.deepEqual(r.opened ?? [], []);
  assert.deepEqual(ledger(d), []);
});

test("an open condition is read back on every run, with the reference and the lines that close it", async () => {
  const d = project();
  openAndReturn(d, "derive-tests-applications", [MOVE]);

  const c = conditionsCheck(d);
  assert.equal(c.ok, true, "still owed is the ordinary state between a return and the revision that answers it");
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /^derive-tests-applications#1: /);
  assert.ok(c.warnings[0].includes(MOVE));
  assert.match(c.warnings[0], /asked of derive-tests, ruled at G3 on derive-tests-applications by tech-lead/);
  assert.match(c.warnings[0], /condition-met <ref>/);
  assert.match(c.warnings[0], /condition-withdrawn <ref>/);

  // And it reaches every surface that runs the checks, which is what puts it in front of
  // whoever rules next rather than only whoever re-reads a gate file.
  const all = await runChecks(d);
  assert.ok(all.some((r) => r.id === "conditions"), all.map((r) => r.id).join(", "));
});

test("an instruction the stage was approved past is a contradiction, and fails", async () => {
  const d = project();
  openAndReturn(d, "derive-tests-applications", [MOVE]);

  // The revision is ruled on its own merits and says nothing about what was asked for. That
  // is the defect: the gate files now say the work was required and that the stage's work
  // was accepted, and nothing says whether the two were reconciled.
  propose(d, "derive-tests-applications-2", { gate: "G3", question: "Does it now?", recommendation: "Yes." });
  rule(d, "derive-tests-applications-2", "approve", { by: "tech-lead", note: "reads well" });

  const c = conditionsCheck(d);
  assert.equal(c.ok, false);
  assert.deepEqual(c.warnings, []);
  assert.equal(c.messages.length, 1);
  assert.match(c.messages[0], /^derive-tests-applications#1: /);
  assert.match(c.messages[0], /derive-tests-applications-2 was approved afterwards and no ruling has said whether this was done/);
  assert.match(c.messages[0], /condition-met <ref>/);

  const all = await runChecks(d);
  assert.equal(all.find((r) => r.id === "conditions").ok, false);
});

// A stage revises several artifacts over a project's life. An approval of one says nothing
// about an instruction left on another, and reading the stage rather than the line of work
// would report every one of them as answered by the first approval of anything the stage did.
test("an approval of another line of the same stage's work does not answer this one", () => {
  const d = project();
  openAndReturn(d, "derive-tests-applications", [MOVE]);

  propose(d, "derive-tests-fees-2", { gate: "G3", question: "Do the fees tests?", recommendation: "Yes." });
  rule(d, "derive-tests-fees-2", "approve", { by: "tech-lead", note: "a different domain entirely" });

  const c = conditionsCheck(d);
  assert.equal(c.ok, true);
  assert.equal(c.warnings.length, 1, "still owed, not overtaken");
});

test("a ruler closes an instruction, and the ledger keeps what was asked alongside what was answered", () => {
  const d = project();
  openAndReturn(d, "derive-tests-applications", [MOVE, NARROW]);

  propose(d, "derive-tests-applications-2", { gate: "G3", question: "Does it now?", recommendation: "Yes." });
  const r = rule(d, "derive-tests-applications-2", "approve", {
    by: "tech-lead",
    conditions: [
      "condition-met derive-tests-applications#1: the criterion is now claimed by the fourth slice",
      "condition-withdrawn derive-tests-applications#2: the criterion itself moved, so the test is answerable to a different statement",
    ],
  });
  assert.deepEqual(r.closed, [
    { ref: "derive-tests-applications#1", outcome: "met" },
    { ref: "derive-tests-applications#2", outcome: "withdrawn" },
  ]);

  const rows = ledger(d);
  assert.equal(rows[0].text, MOVE, "what was asked is still on file");
  assert.deepEqual(rows[0].closed, {
    outcome: "met",
    why: "the criterion is now claimed by the fourth slice",
    by: "tech-lead",
    at: rows[0].closed.at,
  });
  assert.equal(rows[1].closed.outcome, "withdrawn");
  assert.deepEqual(openConditions(d), []);

  const c = conditionsCheck(d);
  assert.equal(c.ok, true);
  assert.deepEqual([...c.messages, ...c.warnings], []);
  assert.match(git(["log", "--pretty=%s", "main"], d), /closes derive-tests-applications#1 met, derive-tests-applications#2 withdrawn/);
});

test("a reference nothing has open is refused, and the refusal says what is open", () => {
  const d = project();
  openAndReturn(d, "derive-tests-applications", [MOVE]);
  propose(d, "derive-tests-applications-2", { gate: "G3", question: "Does it now?", recommendation: "Yes." });

  assert.throws(() => rule(d, "derive-tests-applications-2", "approve", {
    by: "tech-lead", conditions: ["condition-met derive-tests-applications#7: done"],
  }), (e) => /is not an open condition/.test(e.message)
    && e.message.includes("derive-tests-applications#1")
    && e.message.includes(MOVE));

  // Refused before anything was written: no gate file, and the instruction is still owed.
  assert.ok(!existsSync(join(d, ".sdlc/gates/derive-tests-applications-2.yaml")));
  assert.equal(openConditions(d).length, 1);
});

test("closing an instruction with no reason is refused, and the whole ruling is handed back", () => {
  const d = project();
  openAndReturn(d, "derive-tests-applications", [MOVE]);
  propose(d, "derive-tests-applications-2", { gate: "G3", question: "Does it now?", recommendation: "Yes." });

  assert.throws(() => rule(d, "derive-tests-applications-2", "approve", {
    by: "tech-lead", conditions: ["condition-met derive-tests-applications#1", "read the fourth test again"],
  }), (e) => /carries no reason/.test(e.message)
    // Every throw in this family carries the verdict and every condition, not only the line
    // that sank it, so a refusal does not cost the rest of the ruling.
    && /verdict: approve/.test(e.message)
    && e.message.includes("read the fourth test again"));
  assert.equal(openConditions(d).length, 1);
});

test("the same instruction is not owed twice when a ruling is replayed, and a closed one cannot be closed again", () => {
  const d = project();
  const first = openAndReturn(d, "derive-tests-applications", [MOVE]);
  assert.deepEqual(first.opened, ["derive-tests-applications#1"]);

  propose(d, "derive-tests-applications-2", { gate: "G3", question: "Does it now?", recommendation: "Yes." });
  rule(d, "derive-tests-applications-2", "approve", {
    by: "tech-lead", conditions: ["condition-met derive-tests-applications#1: the fourth slice claims it now"],
  });

  propose(d, "derive-tests-applications-3", { gate: "G3", question: "And now?", recommendation: "Yes." });
  assert.throws(() => rule(d, "derive-tests-applications-3", "approve", {
    by: "tech-lead", conditions: ["condition-met derive-tests-applications#1: done again"],
  }), /is not an open condition/);
  assert.equal(ledger(d).length, 1, "an entry is never added twice and never removed");
});

test("a revision request nobody has taken up is read back too, and never fails on its own", () => {
  const d = project();
  addRevisionRequests(d, [{
    stage: "plan", why: "the second slice claims a criterion nothing it builds can demonstrate",
    from: "build-slice-2", gate: "G3", by: "agent:reviewer", at: "2026-01-01T00:00:00.000Z",
  }]);

  const c = conditionsCheck(d);
  assert.equal(c.ok, true, "the only way to clear a request is to take it up, so a failure would have no answer");
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /plan has an untaken revision request from build-slice-2 \(G3, agent:reviewer\)/);
  assert.match(c.warnings[0], /sdlc run plan --revise/);
});

test("a ledger that does not parse reads as nothing owed rather than stopping the check", () => {
  const d = project();
  writeFileSync(join(d, CONDITIONS_PATH), "conditions: [unterminated\n");
  const c = conditionsCheck(d);
  assert.equal(c.ok, true);
  assert.deepEqual([...c.messages, ...c.warnings], []);
});

test("the gate file records the conditions exactly as it always did, ledger or no ledger", () => {
  const d = project();
  openAndReturn(d, "derive-tests-applications", [MOVE]);
  // A return's gate file stays on its own branch; nothing about the proposal was accepted.
  const gate = parseYaml(git(["show", "proposal/derive-tests-applications:.sdlc/gates/derive-tests-applications.yaml"], d));
  assert.equal(gate.verdict, "return");
  assert.deepEqual(gate.conditions, [MOVE]);
});

// Both seats hold the same powers. A persona closes an instruction with the identical line a
// person types, and nothing about the ledger is reachable from one seat and not the other.
test("the agent seat closes an instruction with the same line the human seat types", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-conditions-agent-"));
  const { dir, prevEgress } = await agentProject(tmp);
  t.after(() => restoreEgress(prevEgress));
  propose(dir, "derive-tests-applications", { gate: "G3", question: "Does it?", recommendation: "No." });
  process.env.SDLC_EXECUTOR = "mock";
  try {
    process.env.SDLC_MOCK_DIR = mockRule(reply("return", "the third test reaches past its criterion", [NARROW]));
    const returned = await ruleByAgent(dir, "derive-tests-applications", { persona: "reviewer" });
    assert.deepEqual(returned.opened, ["derive-tests-applications#1"]);
    git(["checkout", "-q", "main"], dir);

    propose(dir, "derive-tests-applications-2", { gate: "G3", question: "Does it now?", recommendation: "Yes." });
    process.env.SDLC_MOCK_DIR = mockRule(reply("approve", "the third test now states exactly its criterion", [
      "condition-met derive-tests-applications#1: the test asserts the criterion's own sentence and stops there",
    ]));
    const approved = await ruleByAgent(dir, "derive-tests-applications-2", { persona: "reviewer" });
    assert.deepEqual(approved.closed, [{ ref: "derive-tests-applications#1", outcome: "met" }]);
    assert.equal(readConditions(dir)[0].closed.by, "agent:reviewer");
    assert.deepEqual(openConditions(dir), []);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
  }
});

// The same chance to correct a line the other fixable defects get (0028): a persona that
// names a reference nothing has open is asked once more rather than losing a whole ruling.
test("a persona that names a reference nothing has open is re-prompted once, with the open list", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-conditions-reprompt-"));
  const { dir, prevEgress } = await agentProject(tmp);
  t.after(() => restoreEgress(prevEgress));
  propose(dir, "derive-tests-applications", { gate: "G3", question: "Does it?", recommendation: "No." });
  process.env.SDLC_EXECUTOR = "mock";
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    process.env.SDLC_MOCK_DIR = mockRule(reply("return", "the third test reaches past its criterion", [NARROW]));
    await ruleByAgent(dir, "derive-tests-applications", { persona: "reviewer" });
    git(["checkout", "-q", "main"], dir);

    propose(dir, "derive-tests-applications-2", { gate: "G3", question: "Does it now?", recommendation: "Yes." });
    process.env.SDLC_MOCK_DIR = mockRule(
      reply("approve", "it reads well", ["condition-met derive-tests-applications#4: done"]),
      reply("approve", "it reads well", ["condition-met derive-tests-applications#1: the test states its criterion and stops"]),
    );
    const r = await ruleByAgent(dir, "derive-tests-applications-2", { persona: "reviewer" });
    assert.equal(r.reprompted, true);
    assert.deepEqual(r.closed, [{ ref: "derive-tests-applications#1", outcome: "met" }]);
    assert.ok(logs.some((l) => /re-asking once/.test(l) && l.includes("derive-tests-applications#1")), logs.join(" | "));
  } finally {
    console.log = origLog;
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
  }
});

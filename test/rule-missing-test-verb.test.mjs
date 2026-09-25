// A ruler keeps a clause of a criterion owed on any ruling, approval included, with
// `missing-test <ID>: <clause> — owed by <stage>: <what is missing>`, from either seat and through
// the same guards; a recorded ruling that said it in prose has it applied by `rule --settle`
// with the line given, citing the condition it restates (`docs/decisions/0054`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { git, gitOk } from "../src/lib/git.mjs";
import { rule, ruleByAgent, settleRuling } from "../src/commands/rule.mjs";
import { buildPersonaPrompt } from "../src/runner/persona.mjs";
import { openMissingTestsAt, syncMissingTests } from "../src/spec/missing-tests.mjs";

const CONFIG = (g3) => `
pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: p, domains: [a] }
policy:
  gates:
    G0: { holder: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: tech-lead }
    G2: { holder: tech-lead }
    G3: ${g3}
    G-POL: { holder: "agent:tech-lead", escalate_to: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;
const HUMAN_HELD = CONFIG("{ holder: tech-lead, escalate_to: delivery-lead }");
const SIMULATED = CONFIG('{ holder: "agent:reviewer", escalate_to: tech-lead }');

function put(d, rel, text) {
  mkdirSync(join(d, rel, ".."), { recursive: true });
  writeFileSync(join(d, rel), text);
}

function commit(d, m) {
  git(["add", "-A"], d);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", m], d);
}

const FILE = "tests/acceptance/a/R-1.2.spec.ts";

// A derivation open at G3 whose test for R-1.2 asserts one of its two clauses.
function project(t, config = HUMAN_HELD) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-rule-clause-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], d);
  put(d, ".sdlc/config.yaml", config);
  put(d, ".gitattributes", ".sdlc/runs/*.md merge=union\n");
  for (const p of ["reviewer", "tech-lead"]) put(d, `.sdlc/personas/${p}.md`, `# Persona: ${p}\n\nRules.\n`);
  put(d, "spec/criteria-index.json", JSON.stringify({ criteria: [
    { id: "R-1.1", domain: "a", version: 1, state: "accepted" },
    { id: "R-1.2", domain: "a", version: 1, state: "accepted" },
  ] }));
  put(d, "tests/acceptance/not-testable.yaml", stringifyYaml({ criteria: [] }));
  commit(d, "init");
  git(["checkout", "-q", "-b", "proposal/derive-tests-a"], d);
  put(d, FILE, "// criterion: @R-1.2 v1\n// provenance: blind, spec@abc123, derived 2026-09-19\n");
  put(d, ".sdlc/proposals/derive-tests-a.md",
    "---\ngate: G3\nquestion: \"Are these the tests?\"\nrecommendation: \"Yes.\"\nopened: 2026-09-19T00:00:00.000Z\n---\n\n# Are these the tests?\n");
  commit(d, "open derive-tests-a");
  git(["checkout", "-q", "main"], d);
  return d;
}

const LINE = "missing-test R-1.2: a refused order is never charged — owed by contract: an observation reporting whether an order was charged";
const PROSE = "R-1.2's clause 'a refused order is never charged' is not asserted by any test: a pass establishes only the rest. It stays open until the contract can observe a charge.";

const owed = (d) => (gitOk(["cat-file", "-e", "main:.sdlc/owed.yaml"], d)
  ? parseYaml(git(["show", "main:.sdlc/owed.yaml"], d)).owed.filter((e) => e.kind === "missing-test") : []);

// What calibration writes once it has run the partial test on main.
function runPartialTest(d) {
  put(d, "tests/results/old/latest.json", JSON.stringify({
    rows: [{ id: "R-1.2", version: 1, domain: "a", file: FILE, file_sha: git(["hash-object", FILE], d), result: "pass" }],
  }));
  return syncMissingTests(d, { config: { profile: "rebuild", oracle: { target: "old" } } });
}

function replyWith(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-rule-clause-mock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const turn = ({ verdict, rationale, conditions = [] }) => ({ text: `\`\`\`json\n${JSON.stringify({ verdict, rationale, conditions })}\n\`\`\`` });
  writeFileSync(join(dir, "rule.json"), JSON.stringify({ sequence: entries.map(turn) }));
  process.env.SDLC_MOCK_DIR = dir;
}

function withMock(t) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const names = join(mkdtempSync(join(tmpdir(), "sdlc-rule-clause-egress-")), "names.txt");
  writeFileSync(names, "");
  process.env.SDLC_EGRESS_NAMES = names;
  process.env.SDLC_EXECUTOR = "mock";
  t.after(() => {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    if (prevEgress === undefined) delete process.env.SDLC_EGRESS_NAMES; else process.env.SDLC_EGRESS_NAMES = prevEgress;
  });
}

test("a person's approval carrying a missing-test line leaves the clause owed on main, and the partial test does not close it", (t) => {
  const d = project(t);
  const r = rule(d, "derive-tests-a", "approve", { by: "tech-lead", note: "the rest is asserted", conditions: [LINE] });
  assert.equal(r.verdict, "approve");
  assert.deepEqual(r.clauses, [{ id: "R-1.2", stage: "contract" }]);
  const [item] = owed(d);
  assert.deepEqual([item.item, item.stage, item.clause, item.why], ["R-1.2", "contract", "a refused order is never charged", "an observation reporting whether an order was charged"]);
  assert.equal(item.by, "tech-lead");
  assert.equal(item.from, "derive-tests-a");
  assert.match(git(["log", "-1", "--format=%s", "main"], d), /merge: derive-tests-a approved/, "recorded in the approval's merge");
  assert.equal(git(["status", "--porcelain"], d), "");
  assert.deepEqual(runPartialTest(d).closed, []);
  assert.deepEqual(openMissingTestsAt(d, "HEAD").map((e) => [e.item, e.stage]), [["R-1.2", "contract"]]);
});

test("a return carrying the line records it on main in a commit of its own", (t) => {
  const d = project(t);
  rule(d, "derive-tests-a", "return", { by: "tech-lead", note: "x", conditions: ["Say what the test asserts in its title.", LINE] });
  git(["checkout", "-q", "main"], d);
  assert.deepEqual(owed(d).map((e) => [e.item, e.stage, e.clause]), [["R-1.2", "contract", "a refused order is never charged"]]);
  assert.match(git(["log", "--format=%s", "main"], d), /rule\(G3\): derive-tests-a owes missing-test\/R-1\.2's clause to contract/);
  const conditions = parseYaml(git(["show", "main:.sdlc/conditions.yaml"], d)).conditions;
  assert.deepEqual(conditions.map((c) => c.text), ["Say what the test asserts in its title."], "it is not a plain condition on the returned stage");
});

test("a missing-test line is refused where it cannot be recorded, before anything is written", (t) => {
  const d = project(t);
  const refused = (line, pattern) => {
    assert.throws(() => rule(d, "derive-tests-a", "approve", { by: "tech-lead", note: "x", conditions: [line] }), pattern);
    assert.equal(gitOk(["cat-file", "-e", "proposal/derive-tests-a:.sdlc/gates/derive-tests-a.yaml"], d), false);
  };
  refused("missing-test R-1.2: a refused order is never charged", /carries no stage or nothing missing\. Write it as `missing-test <ID>: <clause> — owed by <stage>: <what is missing>`/);
  refused("missing-test R-9.9: a clause — owed by contract: a seeded order", /R-9\.9 is not an accepted criterion/);
  refused("missing-test R-1.2: a clause — owed by nobody: a seeded order", /nobody is not a stage/);
  refused("missing-test R-1.2: a clause — owed by derive-tests: a better test", /derive-tests.*return the proposal/s);
});

test("the persona holding the gate records the same line, and is asked once more over a malformed one", async (t) => {
  withMock(t);
  const d = project(t, SIMULATED);
  replyWith(t, [
    { verdict: "approve", rationale: "the rest is asserted", conditions: ["missing-test R-1.2: a refused order is never charged"] },
    { verdict: "approve", rationale: "the rest is asserted", conditions: [LINE] },
  ]);
  const r = await ruleByAgent(d, "derive-tests-a", { persona: "reviewer" });
  assert.equal(r.verdict, "approve");
  assert.equal(r.reprompted, true);
  const [item] = owed(d);
  assert.deepEqual([item.stage, item.clause, item.by], ["contract", "a refused order is never charged", "agent:reviewer"]);
});

test("the ruler is told an approval may carry the line, and that its free-text lines are owed by nobody", async (t) => {
  withMock(t);
  const d = project(t, SIMULATED);
  git(["checkout", "-q", "proposal/derive-tests-a"], d);
  const prompt = await buildPersonaPrompt(d, "derive-tests-a", "reviewer", { tier: "STANDARD", gate: "G3" });
  git(["checkout", "-q", "main"], d);
  const either = prompt.slice(prompt.indexOf("**Either verdict**"), prompt.indexOf("**A return only**"));
  assert.match(either, /`missing-test <ID>: <clause> — owed by <stage>: <what is missing>`/);
  assert.match(prompt, /A free-text line on an approval is kept on the gate file and owed by nobody/);
});

test("rule --settle applies a missing-test line restating a recorded approval's condition, once, as the pipeline", (t) => {
  const d = project(t);
  rule(d, "derive-tests-a", "approve", { by: "tech-lead", note: "the rest is asserted", conditions: [PROSE] });
  assert.deepEqual(owed(d), [], "the prose condition was recorded on the gate file alone");

  assert.throws(() => settleRuling(d, "derive-tests-a", { conditions: [LINE.replace("R-1.2", "R-1.1")] }),
    /derive-tests-a's ruling names R-1\.1 in none of its conditions/);
  assert.throws(() => settleRuling(d, "derive-tests-a", { conditions: ["R-1.2 stays open"] }), /is not a missing-test line/);

  const r = settleRuling(d, "derive-tests-a", { conditions: [LINE] });
  assert.deepEqual(r.clauses, [{ id: "R-1.2", stage: "contract" }]);
  const [item] = owed(d);
  assert.deepEqual([item.item, item.stage, item.clause, item.by, item.from, item.gate], ["R-1.2", "contract", "a refused order is never charged", "tech-lead", "derive-tests-a", "G3"]);
  assert.deepEqual(item.restates, [{ ref: "derive-tests-a#1", text: PROSE }]);
  assert.match(git(["log", "-1", "--format=%an|%s", "main"], d), /^sdlc\|record\(G3\): derive-tests-a owes missing-test\/R-1\.2's clause to contract/);
  assert.equal(git(["status", "--porcelain"], d), "");

  const head = git(["rev-parse", "HEAD"], d);
  assert.deepEqual(settleRuling(d, "derive-tests-a", { conditions: [LINE] }).clauses, []);
  assert.equal(git(["rev-parse", "HEAD"], d), head, "settling again commits nothing");
  assert.deepEqual(runPartialTest(d).closed, [], "the partial test's run does not close it");
});

test("rule --settle applies a missing-test line a recorded ruling carries and main does not hold", (t) => {
  const d = project(t);
  rule(d, "derive-tests-a", "approve", { by: "tech-lead", note: "the rest is asserted", conditions: [LINE] });
  // An approval whose bookkeeping did not reach main: the item is taken back off the list.
  put(d, ".sdlc/owed.yaml", stringifyYaml({ owed: [] }));
  commit(d, "lost");
  const r = settleRuling(d, "derive-tests-a");
  assert.deepEqual(r.clauses, [{ id: "R-1.2", stage: "contract" }]);
  assert.equal(owed(d)[0].stage, "contract");
});

// The persona is told the same two things the guards and the ledger hold it to.
test("the reviewer's brief returns an unasserted clause with no record, and the skill records one", () => {
  const root = new URL("..", import.meta.url).pathname;
  const brief = readFileSync(join(root, "templates/project/.sdlc/personas/reviewer.md"), "utf8");
  assert.match(brief, /A test that asserts part of its criterion with no such entry[\s\S]*grounds to return/);
  assert.match(brief, /missing-test <ID>: <clause> — owed by <stage>: <what is missing>/);
  const skill = readFileSync(join(root, "src/stages/skills/derive-tests.md"), "utf8");
  assert.match(skill, /## When part of a criterion cannot be tested/);
  assert.match(skill, /clause: "<the clause no test asserts/);
});

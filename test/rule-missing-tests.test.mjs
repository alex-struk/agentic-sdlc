// A build slice whose criterion is owed a test is not approved while the item is open
// (`policy.gates.G3.block_on_missing_tests`, true by default), from either seat, and a ruler
// withdraws an item with the same accounting line a condition is withdrawn with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { git, gitOk } from "../src/lib/git.mjs";
import { rule, ruleByAgent } from "../src/commands/rule.mjs";
import { buildPersonaPrompt } from "../src/runner/persona.mjs";
import { openMissingTestsAt } from "../src/spec/missing-tests.mjs";

const SIMULATED = `
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
    G3: { holder: "agent:reviewer", escalate_to: tech-lead }
    G-POL: { holder: "agent:tech-lead", escalate_to: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;
const HUMAN_HELD = SIMULATED.replace('G3: { holder: "agent:reviewer", escalate_to: tech-lead }', "G3: { holder: tech-lead, escalate_to: delivery-lead }");

const RECORD = { id: "R-1.2", version: 1, reason: "blocked: no observation of the total", missing: "an observation of the order total", owner: "contract" };
const RAN = { id: "R-1.1", version: 1, domain: "a", file: "tests/acceptance/a/R-1.1.spec.ts", result: "pass" };
const UNASSERTED = { id: "R-1.2", version: 1, domain: "a", file: null, result: "not-testable", reason: RECORD.reason };

function put(d, rel, text) {
  mkdirSync(join(d, rel, ".."), { recursive: true });
  writeFileSync(join(d, rel), text);
}

function commit(d, m) {
  git(["add", "-A"], d);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", m], d);
}

// A project whose `main` holds one untestable record, and an open build slice claiming both
// of its criteria, verified with `rows`.
function project(t, { config = HUMAN_HELD, rows = [RAN, UNASSERTED], verdict = "pass-unasserted", owed = null, records = [RECORD] } = {}) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-rule-missing-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], d);
  put(d, ".sdlc/config.yaml", config);
  put(d, ".gitattributes", ".sdlc/runs/*.md merge=union\n");
  for (const p of ["reviewer", "tech-lead"]) put(d, `.sdlc/personas/${p}.md`, `# Persona: ${p}\n\nRules.\n`);
  put(d, "spec/criteria-index.json", JSON.stringify({ criteria: [
    { id: "R-1.1", domain: "a", version: 1, state: "accepted" },
    { id: "R-1.2", domain: "a", version: 1, state: "accepted" },
  ] }));
  put(d, "plan/tasks.md", "# Tasks\n\n### Slice 1 · orders\n\n- criteria: R-1.1, R-1.2\n");
  put(d, "tests/acceptance/not-testable.yaml", stringifyYaml({ criteria: records }));
  if (owed) put(d, ".sdlc/owed.yaml", stringifyYaml({ owed }));
  commit(d, "init");
  git(["checkout", "-q", "-b", "proposal/build-slice-1"], d);
  put(d, "app/index.ts", "export {};\n");
  put(d, ".sdlc/proposals/build-slice-1.md",
    "---\ngate: G3\nquestion: \"Does it work?\"\nrecommendation: \"Yes.\"\nopened: 2026-09-19T00:00:00.000Z\n---\n\n# Does it work?\n");
  commit(d, "open build-slice-1");
  put(d, "tests/results/new/slice-1.json", JSON.stringify({
    slice: 1, proposal: "build-slice-1", app_tree: git(["rev-parse", "HEAD:app"], d), at: "2026-09-19T00:00:00.000Z", verdict, rows,
  }));
  commit(d, "verify slice 1");
  git(["checkout", "-q", "main"], d);
  return d;
}

function replyWith(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-rule-missing-mock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const turn = ({ verdict, rationale, conditions = [] }) => ({ text: `\`\`\`json\n${JSON.stringify({ verdict, rationale, conditions })}\n\`\`\`` });
  writeFileSync(join(dir, "rule.json"), JSON.stringify({ sequence: entries.map(turn) }));
  process.env.SDLC_MOCK_DIR = dir;
}

function withMock(t) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const names = join(mkdtempSync(join(tmpdir(), "sdlc-rule-missing-egress-")), "names.txt");
  writeFileSync(names, "");
  process.env.SDLC_EGRESS_NAMES = names;
  process.env.SDLC_EXECUTOR = "mock";
  t.after(() => {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    if (prevEgress === undefined) delete process.env.SDLC_EGRESS_NAMES; else process.env.SDLC_EGRESS_NAMES = prevEgress;
  });
}

const owedOnMain = (d) => parseYaml(git(["show", "main:.sdlc/owed.yaml"], d)).owed.filter((e) => e.kind === "missing-test");
const WITHDRAW = "condition-withdrawn missing-test/R-1.2: the total is shown by the payment provider's own receipt; the risk is accepted";

test("a person may not approve a slice whose criterion is owed a test, and the refusal is recorded", (t) => {
  const d = project(t);
  assert.throws(() => rule(d, "build-slice-1", "approve", { by: "tech-lead", note: "fine" }),
    /missing-test\/R-1\.2 \(owed by contract: "an observation of the order total"\).*block_on_missing_tests/s);
  assert.equal(gitOk(["cat-file", "-e", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d), false);
  assert.match(git(["log", "-1", "--format=%s", "main"], d), /rule\(G3\): build-slice-1 refused/);
  assert.equal(rule(d, "build-slice-1", "return", { by: "tech-lead", note: "the total needs a test" }).verdict, "return");
});

test("a withdrawal in the same ruling lets the approval through and closes the item with its reason", (t) => {
  const d = project(t);
  const r = rule(d, "build-slice-1", "approve", { by: "tech-lead", note: "fine", conditions: [WITHDRAW] });
  assert.equal(r.verdict, "approve");
  const [item] = owedOnMain(d);
  assert.equal(item.item, "R-1.2");
  assert.equal(item.closed.outcome, "withdrawn");
  assert.equal(item.closed.by, "tech-lead");
  assert.match(item.closed.why, /risk is accepted/);
  assert.deepEqual(openMissingTestsAt(d, "main"), []);
});

test("a missing test is not closed by saying it was met, nor withdrawn when nothing names it", (t) => {
  const d = project(t);
  assert.throws(() => rule(d, "build-slice-1", "return", { by: "tech-lead", note: "x", conditions: ["condition-met missing-test/R-1.2: a test exists now"] }),
    /closed only by a test that runs/);
  assert.throws(() => rule(d, "build-slice-1", "return", { by: "tech-lead", note: "x", conditions: ["condition-withdrawn missing-test/R-9.9: no longer wanted"] }),
    /not an open missing test\. The missing tests still open are: missing-test\/R-1\.2 \(owed by contract\)/);
});

test("with block_on_missing_tests false the approval goes through and the item stays owed", (t) => {
  const d = project(t, { config: HUMAN_HELD.replace("G3: { holder: tech-lead, escalate_to: delivery-lead }",
    "G3: { holder: tech-lead, escalate_to: delivery-lead, block_on_missing_tests: false }") });
  assert.equal(rule(d, "build-slice-1", "approve", { by: "tech-lead", note: "fine" }).verdict, "approve");
  assert.deepEqual(openMissingTestsAt(d, "main").map((e) => [e.item, e.stage]), [["R-1.2", "contract"]]);
});

test("a test the slice's verify ran closes the item when the slice is approved", (t) => {
  const owed = [{ kind: "missing-test", item: "R-1.2", id: "R-1.2", version: 1, domain: "a", stage: "verify", why: "a test for v1 exists and has not run", by: "runner", at: "2026-09-18T00:00:00.000Z" }];
  const d = project(t, { owed, records: [], verdict: "pass", rows: [RAN, { ...RAN, id: "R-1.2", file: "tests/acceptance/a/R-1.2.spec.ts" }] });
  const r = rule(d, "build-slice-1", "approve", { by: "tech-lead", note: "fine" });
  assert.deepEqual(r.missingTests.closed, ["R-1.2"]);
  const [item] = owedOnMain(d);
  assert.equal(item.closed.outcome, "met");
  assert.equal(item.closed.why, "tests/results/new/slice-1.json: R-1.2 v1 pass");
});

test("the persona is refused the same approval after one more turn, and may withdraw in it", async (t) => {
  withMock(t);
  const d = project(t, { config: SIMULATED });
  replyWith(t, [{ verdict: "approve", rationale: "the asserted criterion passes" }]);
  await assert.rejects(() => ruleByAgent(d, "build-slice-1", { persona: "reviewer" }), /missing-test\/R-1\.2.*block_on_missing_tests/s);
  assert.equal(gitOk(["cat-file", "-e", "proposal/build-slice-1:.sdlc/gates/build-slice-1.yaml"], d), false);

  const e = project(t, { config: SIMULATED });
  replyWith(t, [
    { verdict: "approve", rationale: "the asserted criterion passes" },
    { verdict: "approve", rationale: "the asserted criterion passes; the other is owed no test", conditions: [WITHDRAW] },
  ]);
  const r = await ruleByAgent(e, "build-slice-1", { persona: "reviewer" });
  assert.equal(r.verdict, "approve");
  assert.equal(r.reprompted, true);
  assert.equal(owedOnMain(e)[0].closed.by, "agent:reviewer");
});

test("the ruler of a slice is shown the missing tests its criteria are owed, and how to withdraw one", async (t) => {
  withMock(t);
  const d = project(t, { config: SIMULATED });
  git(["checkout", "-q", "proposal/build-slice-1"], d);
  const prompt = await buildPersonaPrompt(d, "build-slice-1", "reviewer", { tier: "STANDARD", gate: "G3" });
  assert.match(prompt, /## Tests these criteria are owed/);
  assert.match(prompt, /`missing-test\/R-1\.2` — owed by contract: "an observation of the order total"/);
  assert.match(prompt, /condition-withdrawn <ref>: <why it is no longer asked for>/);
  assert.match(prompt, /block_on_missing_tests/);
});

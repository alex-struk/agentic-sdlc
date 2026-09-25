// A criterion whose test asserts only some of what it states is owed a test for the rest
// (`docs/decisions/0054`). A not-testable record may name the clause nobody asserted, and a
// ruler may name one on any ruling with `missing-test <ID>: <clause> — owed by <stage>: <what is
// missing>`. Either keeps the criterion's missing test open, owed by the stage named, whatever
// its partial test's runs say, until a test asserts the clause or a ruler withdraws it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { git } from "../src/lib/git.mjs";
import { read } from "../src/spec/owed.mjs";
import { checkTests, coverage } from "../src/checks/tests.mjs";
import { removeTestsNowRecordedNotTestable } from "../src/stages/registry.mjs";
import {
  CONDITION_FORM_RULES, MISSING_TEST_CONDITION_FORM, malformedMissingTestConditions, missingTestConditions, splitConditionsByAddressee,
} from "../src/spec/criteria.mjs";
import {
  MISSING_TEST, blockingMissingTests, handedNote, missingTestRef, openMissingTestsAt, oweClauses, readdressMissingTests, recordProblems, syncMissingTests,
} from "../src/spec/missing-tests.mjs";

function put(d, rel, text) {
  mkdirSync(join(d, rel, ".."), { recursive: true });
  writeFileSync(join(d, rel), text);
}

function commit(d, m) {
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", m], d);
}

function project(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-clauses-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d);
  git(["config", "user.name", "t"], d);
  put(d, "spec/criteria-index.json", JSON.stringify({ criteria: [
    { id: "R-1.1", domain: "orders", version: 1, state: "accepted" },
    { id: "R-1.2", domain: "orders", version: 1, state: "accepted" },
  ] }));
  commit(d, "init");
  return d;
}

const FILE = "tests/acceptance/orders/R-1.2.spec.ts";
const records = (d, criteria) => put(d, "tests/acceptance/not-testable.yaml", stringifyYaml({ criteria }));
const spec = (d, id) => put(d, `tests/acceptance/orders/${id}.spec.ts`,
  `// criterion: @${id} v1\n// provenance: blind, spec@abc123, derived 2026-01-01\n`);
// A result showing the test for R-1.2, as the file now stands, ran.
const ran = (d) => put(d, "tests/results/old/latest.json", JSON.stringify({
  rows: [{ id: "R-1.2", version: 1, domain: "orders", file: FILE, file_sha: git(["hash-object", FILE], d), result: "pass" }],
}));

const CLAUSE = {
  id: "R-1.2", version: 1, clause: "a refused order is never charged",
  reason: "unobservable through the contract: no observation reports a charge",
  missing: "an observation reporting whether an order was charged", owner: "contract",
};
const CALIBRATES = { profile: "rebuild", oracle: { target: "old" } };

test("a record naming a clause sits beside the test that asserts the rest", (t) => {
  const d = project(t);
  spec(d, "R-1.2");
  records(d, [CLAUSE]);
  commit(d, "partial");
  const recordMessages = () => checkTests(d, {}).messages.filter((m) => m.startsWith("tests/acceptance/not-testable.yaml"));
  assert.deepEqual(recordMessages(), []);
  const cov = coverage(d, "orders");
  assert.deepEqual(cov.covered, ["R-1.2"], "the criterion has a test");
  assert.deepEqual(cov.notTestable, [], "a clause record does not make the criterion not-testable");
  records(d, [CLAUSE, { ...CLAUSE, id: "R-1.1" }]);
  assert.match(recordMessages().join("\n"), /R-1\.1 names a clause and has no test/);
});

test("a clause record a run adds does not delete the test it sits beside", (t) => {
  const d = project(t);
  spec(d, "R-1.2");
  commit(d, "test");
  records(d, [CLAUSE]);
  assert.deepEqual(removeTestsNowRecordedNotTestable(d, "orders"), []);
  assert.equal(existsSync(join(d, FILE)), true);
});

test("a record naming an empty clause is refused like one naming no owner", () => {
  assert.match(recordProblems({ ...CLAUSE, clause: " " }).join("\n"), /R-1\.2 names an empty clause/);
  assert.deepEqual(recordProblems(CLAUSE), []);
});

test("a criterion with a clause record keeps its item open, owed by the record's owner, however often its test runs", (t) => {
  const d = project(t);
  spec(d, "R-1.2");
  records(d, [CLAUSE]);
  commit(d, "partial");
  const [open] = openMissingTestsAt(d, "main");
  assert.deepEqual([open.item, open.stage, open.clause, open.why], ["R-1.2", "contract", CLAUSE.clause, CLAUSE.missing]);
  ran(d);
  const r = syncMissingTests(d, { config: CALIBRATES });
  assert.deepEqual(r.closed, [], "a run of the partial test does not close the item");
  const [e] = read(d, MISSING_TEST);
  assert.equal(e.closed ?? null, null);
  assert.equal(e.stage, "contract");

  records(d, []);
  assert.deepEqual(syncMissingTests(d, { config: CALIBRATES }).closed, ["R-1.2"], "once no clause is recorded, a run closes it");
});

test("a slice claiming a criterion with an unasserted clause is blocked though its partial test ran", (t) => {
  const d = project(t);
  spec(d, "R-1.2");
  records(d, [CLAUSE]);
  commit(d, "partial");
  const rows = [{ id: "R-1.2", version: 1, file: FILE, file_sha: git(["hash-object", FILE], d), result: "pass" }];
  assert.deepEqual(blockingMissingTests(d, { claimed: ["R-1.2"], rows }).map((e) => e.item), ["R-1.2"]);
});

test("the stage owing a clause is handed it with the clause named", (t) => {
  const d = project(t);
  spec(d, "R-1.2");
  records(d, [CLAUSE]);
  commit(d, "partial");
  assert.match(handedNote(d, "contract", { domain: "orders" }),
    /- missing-test\/R-1\.2 — the clause "a refused order is never charged" — "an observation reporting whether an order was charged"/);
});

const LINE = "missing-test R-1.2: a refused order is never charged — owed by contract: an observation reporting whether an order was charged";

test("the missing-test line names a criterion, a clause, the stage that owes it and what is missing", () => {
  assert.deepEqual(missingTestConditions([LINE, "plain words"]), [{
    verb: "missing-test", id: "R-1.2", clause: "a refused order is never charged", stage: "contract",
    missing: "an observation reporting whether an order was charged",
  }]);
  assert.deepEqual(missingTestConditions(["missing-test R-1.2: a clause -- owed by contract: a seeded order"])[0].stage, "contract",
    "a double hyphen stands in for the dash");
  assert.deepEqual(malformedMissingTestConditions([
    LINE, "missing-test R-1.2: a clause with no owner", "missing-test R-1.2: — owed by contract: x", "missing-test R-1.2: c — owed by contract:  ",
    "condition-withdrawn missing-test/R-1.2: no longer asked for",
  ]), ["missing-test R-1.2: a clause with no owner", "missing-test R-1.2: — owed by contract: x", "missing-test R-1.2: c — owed by contract:  "]);
  assert.equal(MISSING_TEST_CONDITION_FORM, "missing-test <ID>: <clause> — owed by <stage>: <what is missing>");
  assert.equal(CONDITION_FORM_RULES.find((r) => r.verb === "missing-test")?.onApproval, true, "an approval may carry it");
  const split = splitConditionsByAddressee([LINE]);
  assert.deepEqual(split.mine, [], "it is no instruction to the stage being ruled");
  assert.deepEqual(split.elsewhere.map((e) => e.stage), ["contract"]);
});

test("a ruler's missing-test line keeps an open item open with its clause and moves it to the stage named", (t) => {
  const d = project(t);
  spec(d, "R-1.2");
  commit(d, "test");
  put(d, ".sdlc/owed.yaml", stringifyYaml({ owed: [{
    kind: MISSING_TEST, item: "R-1.2", id: "R-1.2", version: 1, domain: "orders", stage: "calibrate", target: "old",
    why: "a test for v1 exists and has not run", by: "runner", at: "2026-01-01T00:00:00.000Z",
  }] }));
  commit(d, "owed a run");
  const r = oweClauses(d, missingTestConditions([LINE]), { from: "derive-tests-orders-2", gate: "G3", by: "agent:reviewer" });
  assert.deepEqual(r.owed, [{ id: "R-1.2", stage: "contract" }]);
  const [e] = read(d, MISSING_TEST);
  assert.equal(e.stage, "contract");
  assert.equal(e.clause, "a refused order is never charged");
  assert.deepEqual((({ at: _a, ...m }) => m)(e.readdressed.at(-1)), {
    from: "calibrate", to: "contract", why: "an observation reporting whether an order was charged",
    by: "agent:reviewer", proposal: "derive-tests-orders-2", gate: "G3",
  });
  assert.equal(oweClauses(d, missingTestConditions([LINE]), { from: "derive-tests-orders-2", gate: "G3", by: "agent:reviewer" }).path, null,
    "the same line again changes nothing");

  commit(d, "clause owed");
  ran(d);
  assert.deepEqual(syncMissingTests(d, { config: CALIBRATES }).closed, [], "its partial test running does not close it");
  assert.equal(read(d, MISSING_TEST)[0].stage, "contract");
});

test("a ruler's missing-test line opens an item for a criterion that had none, or whose item a run had closed", (t) => {
  const d = project(t);
  spec(d, "R-1.2");
  commit(d, "test");
  const r = oweClauses(d, missingTestConditions([LINE]), { from: "build-slice-1", gate: "G3", by: "tech-lead" });
  assert.deepEqual(r.owed, [{ id: "R-1.2", stage: "contract" }]);
  const [e] = read(d, MISSING_TEST);
  assert.deepEqual([e.item, e.stage, e.clause, e.why, e.from, e.gate, e.by, e.domain, e.version],
    ["R-1.2", "contract", "a refused order is never charged", "an observation reporting whether an order was charged", "build-slice-1", "G3", "tech-lead", "orders", 1]);
});

test("the clause travels with the item, and the approved derivation it was handed answers it", (t) => {
  const d = project(t);
  spec(d, "R-1.2");
  commit(d, "test");
  oweClauses(d, missingTestConditions([LINE]), { from: "build-slice-1", gate: "G3", by: "tech-lead" });
  commit(d, "clause owed");
  readdressMissingTests(d, "contract", `re-address ${missingTestRef("R-1.2")} to derive-tests: seed.orders.refused and orders.charged`, { by: "contract-v3" });
  commit(d, "handed on");
  const base = git(["rev-parse", "HEAD"], d);
  ran(d);
  assert.deepEqual(syncMissingTests(d, { config: CALIBRATES }).closed, [], "owed by the writer, a run of the partial test closes nothing");

  const before = git(["rev-parse", "HEAD"], d);
  put(d, FILE, "// criterion: @R-1.2 v1\n// provenance: blind, spec@def456, derived 2026-01-02\n// the charge is asserted\n");
  commit(d, "merge: derive-tests-orders-3 approved");
  const r = syncMissingTests(d, { before, from: "derive-tests-orders-3", stage: "derive-tests", domain: "orders", base, gate: "G3", by: "agent:reviewer", config: CALIBRATES });
  assert.deepEqual(r.readdressed, [{ id: "R-1.2", from: "derive-tests", to: "calibrate" }], "the whole test now waits on a run");
  const [e] = read(d, MISSING_TEST);
  assert.equal(e.clause, undefined, "the derivation it was handed, approved with no record, asserts the clause");
  assert.equal(e.asserted.at(-1).clause, "a refused order is never charged");
  assert.equal(e.asserted.at(-1).by, "derive-tests-orders-3");
});

// A criterion recorded as untestable is owed a test (`docs/operating-model.md` §7): the record
// opens an item owed by the stage it names, the item is re-addressed by the stage that owns
// it, closed only on a result row that shows a test ran, and withdrawn only with a reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { git } from "../src/lib/git.mjs";
import { read } from "../src/spec/owed.mjs";
import { checkConditions } from "../src/checks/conditions.mjs";
import {
  MISSING_TEST, blockingMissingTests, missingTestRef, openMissingTestsAt, parseMissingTestRef, readdressLines,
  readdressMissingTests, recordProblems, settleApprovedMissingTests, syncMissingTests, withdrawMissingTest,
} from "../src/spec/missing-tests.mjs";

function project(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-missing-tests-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d);
  git(["config", "user.name", "t"], d);
  put(d, "spec/criteria-index.json", JSON.stringify({ criteria: [
    { id: "R-1.1", domain: "orders", version: 1, state: "accepted" },
    { id: "R-1.2", domain: "orders", version: 2, state: "accepted" },
    { id: "R-1.3", domain: "orders", version: 1, state: "accepted" },
  ] }));
  commit(d, "init");
  return d;
}

function put(d, rel, text) {
  mkdirSync(join(d, rel, ".."), { recursive: true });
  writeFileSync(join(d, rel), text);
}

function commit(d, m) {
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", m], d);
}

const records = (d, criteria) => put(d, "tests/acceptance/not-testable.yaml", stringifyYaml({ criteria }));
const spec = (d, id, version) => put(d, `tests/acceptance/orders/${id}.spec.ts`,
  `// criterion: @${id} v${version}\n// provenance: blind, spec@abc123, derived 2026-01-01\n`);

const LEGACY = { id: "R-1.1", version: 1, reason: "blocked: no seeded order in the shipped state" };
const NAMED = { id: "R-1.2", version: 2, reason: "blocked: the refund mail body is not observable", missing: "a mail observation exposing the body", owner: "contract" };

test("a record on main with no entry is read as an open item, owed by the stage it names or by contract", (t) => {
  const d = project(t);
  records(d, [LEGACY, { ...NAMED, owner: "archaeology" }]);
  commit(d, "records");
  const open = openMissingTestsAt(d, "main");
  assert.deepEqual(open.map((e) => [e.item, e.stage, e.domain]), [["R-1.1", "contract", "orders"], ["R-1.2", "archaeology", "orders"]]);
  assert.equal(open[0].why, LEGACY.reason, "a record naming nothing missing is read by its reason");
  assert.equal(open[1].why, NAMED.missing);
  assert.equal(read(d, MISSING_TEST).length, 0, "reading writes nothing");
});

test("an approval opens an entry for each record it brings onto main, stamped with the ruling, and backfills the rest", (t) => {
  const d = project(t);
  records(d, [LEGACY]);
  commit(d, "legacy record");
  const before = git(["rev-parse", "HEAD"], d);
  records(d, [LEGACY, NAMED]);
  commit(d, "merge: derive-tests-orders approved");
  const r = syncMissingTests(d, { before, from: "derive-tests-orders", gate: "G3", by: "agent:reviewer" });
  assert.deepEqual(r.opened.sort(), ["R-1.1", "R-1.2"]);
  const [legacy, named] = ["R-1.1", "R-1.2"].map((id) => read(d, MISSING_TEST).find((e) => e.item === id));
  assert.equal(named.from, "derive-tests-orders");
  assert.equal(named.gate, "G3");
  assert.equal(named.by, "agent:reviewer");
  assert.equal(named.version, 2);
  assert.equal(legacy.from, undefined, "a record already on main was opened by no ruling");
  assert.equal(legacy.by, "runner");
  assert.equal(legacy.stage, "contract");
  assert.equal(syncMissingTests(d, { before }).path, null, "a second pass opens nothing");
});

test("a record that changes its owner in an approved merge re-addresses the open item", (t) => {
  const d = project(t);
  records(d, [NAMED]);
  commit(d, "record");
  syncMissingTests(d, {});
  commit(d, "materialised");
  const before = git(["rev-parse", "HEAD"], d);
  records(d, [{ ...NAMED, owner: "ratify", missing: "the criterion contradicts R-1.3" }]);
  commit(d, "merge");
  const r = syncMissingTests(d, { before, from: "derive-tests-orders-stale-1", gate: "G3", by: "agent:reviewer" });
  assert.deepEqual(r.readdressed, [{ id: "R-1.2", from: "contract", to: "ratify" }]);
  const [e] = read(d, MISSING_TEST);
  assert.equal(e.stage, "ratify");
  assert.equal(e.readdressed.at(-1).why, "the criterion contradicts R-1.3");
});

test("an item handed to derive-tests goes back to its record's owner when the approved derivation keeps the record", (t) => {
  const d = project(t);
  records(d, [NAMED]);
  commit(d, "record");
  syncMissingTests(d, {});
  readdressMissingTests(d, "contract", `re-address ${missingTestRef("R-1.2")} to derive-tests: the body is now observable`, { by: "contract-v2" });
  commit(d, "handed on");
  const before = git(["rev-parse", "HEAD"], d);
  git(["commit", "-q", "--allow-empty", "-m", "merge: derive-tests-orders-stale-1 approved"], d);
  const other = syncMissingTests(d, { before, from: "plan", stage: "plan", gate: "G2", by: "agent:architect" });
  assert.deepEqual(other.readdressed, [], "another stage's approval leaves it where it is");
  const r = syncMissingTests(d, { before, from: "derive-tests-orders-stale-1", stage: "derive-tests", gate: "G3", by: "agent:reviewer" });
  assert.deepEqual(r.readdressed, [{ id: "R-1.2", from: "derive-tests", to: "contract" }]);
});

// Two domains' items handed to the test writer, each derived by a run of its own. The approval of
// one domain's derivation acts on what that run was handed and on nothing else.
function twoDomains(t) {
  const d = project(t);
  put(d, "spec/criteria-index.json", JSON.stringify({ criteria: [
    { id: "R-1.1", domain: "orders", version: 1, state: "accepted" },
    { id: "R-1.2", domain: "orders", version: 2, state: "accepted" },
    { id: "R-2.1", domain: "billing", version: 1, state: "accepted" },
  ] }));
  const BILLING = { id: "R-2.1", version: 1, reason: "blocked: no invoice", missing: "a seeded invoice", owner: "contract" };
  records(d, [NAMED, BILLING]);
  commit(d, "records");
  syncMissingTests(d, {});
  readdressMissingTests(d, "contract", [
    `re-address ${missingTestRef("R-1.2")} to derive-tests: the body is now observable`,
    `re-address ${missingTestRef("R-2.1")} to derive-tests: the seeded invoice`,
  ].join("\n"), { by: "contract-v2" });
  commit(d, "handed on");
  return { d, BILLING };
}

const CALIBRATES = { profile: "rebuild", oracle: { target: "old" } };

test("an approved derivation hands back only its own domain's items; another domain's stay with the writer", (t) => {
  const { d, BILLING } = twoDomains(t);
  const before = git(["rev-parse", "HEAD"], d);
  // The orders derivation keeps one record and writes a test for nothing; billing is untouched.
  git(["commit", "-q", "--allow-empty", "-m", "merge: derive-tests-orders approved"], d);
  const r = syncMissingTests(d, { before, from: "derive-tests-orders", stage: "derive-tests", domain: "orders", base: before, gate: "G3", by: "agent:reviewer", config: CALIBRATES });
  assert.deepEqual(r.readdressed, [{ id: "R-1.2", from: "derive-tests", to: "contract" }]);
  const billing = read(d, MISSING_TEST).find((e) => e.item === BILLING.id);
  assert.equal(billing.stage, "derive-tests");
  assert.equal(billing.readdressed.length, 1, "nothing about it changed");
});

test("an approved derivation that writes its domain's test hands it to calibrate and leaves another domain's item alone", (t) => {
  const { d, BILLING } = twoDomains(t);
  const before = git(["rev-parse", "HEAD"], d);
  records(d, [BILLING]);
  spec(d, "R-1.2", 2);
  commit(d, "merge: derive-tests-orders approved");
  const r = syncMissingTests(d, { before, from: "derive-tests-orders", stage: "derive-tests", domain: "orders", base: before, gate: "G3", by: "agent:reviewer", config: CALIBRATES });
  assert.deepEqual(r.readdressed, [{ id: "R-1.2", from: "derive-tests", to: "calibrate" }]);
  assert.equal(read(d, MISSING_TEST).find((e) => e.item === BILLING.id).stage, "derive-tests");
});

test("an approved derivation does not hand back an item the writer was handed after its branch was cut", (t) => {
  const d = project(t);
  records(d, [NAMED]);
  commit(d, "record");
  syncMissingTests(d, {});
  commit(d, "materialised");
  const base = git(["rev-parse", "HEAD"], d);
  readdressMissingTests(d, "contract", `re-address ${missingTestRef("R-1.2")} to derive-tests: the body is now observable`, { by: "contract-v2" });
  commit(d, "handed on after the derivation started");
  const before = git(["rev-parse", "HEAD"], d);
  git(["commit", "-q", "--allow-empty", "-m", "merge: derive-tests-orders approved"], d);
  const r = syncMissingTests(d, { before, from: "derive-tests-orders", stage: "derive-tests", domain: "orders", base, gate: "G3", by: "agent:reviewer" });
  assert.deepEqual(r.readdressed, []);
  assert.equal(read(d, MISSING_TEST)[0].stage, "derive-tests");
});

test("a run that derives one domain hands on only that domain's items, at its finish and at its approval", (t) => {
  const { d } = twoDomains(t);
  const base = git(["rev-parse", "HEAD"], d);
  const line = `re-address ${missingTestRef("R-2.1")} to ratify: the criterion asks for two states`;
  const r = readdressMissingTests(d, "derive-tests", line, { by: "derive-tests-orders", domain: "orders" });
  assert.deepEqual(r.readdressed, []);
  assert.match(r.refused.join("\n"), /R-2\.1 is not an open item owed by derive-tests in orders/);
  const s = settleApprovedMissingTests(d, { stage: "derive-tests", proposal: "derive-tests-orders", gate: "G3", by: "agent:reviewer", page: line, base, domain: "orders" });
  assert.deepEqual(s.readdressed, []);
  assert.deepEqual(s.kept, ["R-1.2"]);
  assert.equal(read(d, MISSING_TEST).find((e) => e.item === "R-2.1").stage, "derive-tests");
});

test("an item closes only on a result row that ran its test at the current version", (t) => {
  const d = project(t);
  records(d, [NAMED]);
  commit(d, "record");
  syncMissingTests(d, {});
  records(d, []);
  spec(d, "R-1.2", 2);
  commit(d, "test derived");
  const owed = syncMissingTests(d, { config: { profile: "rebuild", oracle: { target: "old" } } });
  assert.deepEqual(owed.readdressed, [{ id: "R-1.2", from: "contract", to: "calibrate" }], "a test that exists and has not run is owed a run");
  assert.equal(read(d, MISSING_TEST)[0].target, "old");

  put(d, "tests/results/old/latest.json", JSON.stringify({ rows: [{ id: "R-1.2", version: 1, file: "tests/acceptance/orders/R-1.2.spec.ts", result: "pass" }] }));
  assert.equal(syncMissingTests(d, {}).closed.length, 0, "a row for an earlier version is not evidence");
  put(d, "tests/results/old/latest.json", JSON.stringify({ rows: [{ id: "R-1.2", version: 2, result: "attested" }] }));
  assert.equal(syncMissingTests(d, {}).closed.length, 0, "an attestation is not a test that ran");
  put(d, "tests/results/old/latest.json", JSON.stringify({ rows: [{ id: "R-1.2", version: 2, file: "tests/acceptance/orders/R-1.2.spec.ts", result: "fail" }] }));
  const r = syncMissingTests(d, {});
  assert.deepEqual(r.closed, ["R-1.2"], "a failing row is still a test that ran");
  const [e] = read(d, MISSING_TEST);
  assert.equal(e.closed.outcome, "met");
  assert.match(e.closed.why, /tests\/results\/old\/latest\.json: R-1\.2 v2 fail/);
});

test("without a calibration target, a test owed a run is owed by verify", (t) => {
  const d = project(t);
  records(d, [NAMED]);
  commit(d, "record");
  syncMissingTests(d, {});
  records(d, []);
  spec(d, "R-1.2", 2);
  assert.equal(syncMissingTests(d, { config: { profile: "greenfield" } }).readdressed[0].to, "verify");
});

test("a met item whose record comes back is owed again", (t) => {
  const d = project(t);
  records(d, [NAMED]);
  commit(d, "record");
  syncMissingTests(d, {});
  records(d, []);
  put(d, "tests/results/new/slice-1.json", JSON.stringify({ rows: [{ id: "R-1.2", version: 2, file: "tests/acceptance/orders/R-1.2.spec.ts", result: "pass" }] }));
  syncMissingTests(d, {});
  assert.equal(read(d, MISSING_TEST)[0].closed.outcome, "met");
  records(d, [NAMED]);
  assert.deepEqual(syncMissingTests(d, {}).opened, ["R-1.2"]);
});

test("a withdrawal needs a reason and holds for the version it was made at", (t) => {
  const d = project(t);
  records(d, [LEGACY]);
  commit(d, "record");
  assert.throws(() => withdrawMissingTest(d, "R-1.1", { why: "  ", by: "tech-lead" }), /a reason/);
  assert.ok(withdrawMissingTest(d, "R-1.1", { why: "nothing outside the service can show it; the risk is accepted", by: "tech-lead" }),
    "a pending item is written and withdrawn in one step");
  const [e] = read(d, MISSING_TEST);
  assert.equal(e.closed.outcome, "withdrawn");
  assert.equal(e.closed.by, "tech-lead");
  commit(d, "withdrawn");
  assert.equal(openMissingTestsAt(d, "main").length, 0);
  assert.equal(syncMissingTests(d, {}).path, null, "the record at the same version stays withdrawn");
  records(d, [{ ...LEGACY, version: 2 }]);
  assert.deepEqual(syncMissingTests(d, {}).opened, ["R-1.1"], "a record at a new version is owed again");
  assert.equal(withdrawMissingTest(d, "R-9.9", { why: "x", by: "tech-lead" }), null, "withdrawing nothing is refused by the caller");
});

test("the stage that owes an item re-addresses it by a journal line, and only an item it owes", (t) => {
  const d = project(t);
  records(d, [LEGACY, NAMED]);
  commit(d, "records");
  const text = [
    "Supplied the observation.",
    `- re-address ${missingTestRef("R-1.1")} to ratify: the criterion asks for two states at once`,
    `re-address ${missingTestRef("R-1.2")} to nowhere: typo`,
    `re-address ${missingTestRef("R-1.3")} to archaeology: not handed to this run`,
    `re-address ${missingTestRef("R-1.2")} to contract: already here`,
  ].join("\n");
  assert.equal(readdressLines(text).length, 4);
  const r = readdressMissingTests(d, "contract", text, { by: "contract-v3" });
  assert.deepEqual(r.readdressed, [{ id: "R-1.1", from: "contract", to: "ratify" }]);
  assert.equal(r.refused.length, 3);
  assert.match(r.refused.join("\n"), /nowhere is not a stage/);
  assert.match(r.refused.join("\n"), /R-1\.3 is not an open item owed by contract/);
  assert.match(r.refused.join("\n"), /already owed by contract/);
  const e = read(d, MISSING_TEST).find((x) => x.item === "R-1.1");
  assert.equal(e.stage, "ratify");
  assert.deepEqual([e.readdressed[0].from, e.readdressed[0].by], ["contract", "contract-v3"]);
});

// A move to the test writer rests on what the run supplied, which reaches `main` only when
// its proposal is approved; a move to the stage whose the item is rests on nothing the run made.
test("a gated run's hand-on to derive-tests waits for its approval, and a move elsewhere does not", (t) => {
  const d = project(t);
  records(d, [LEGACY, NAMED]);
  commit(d, "records");
  const text = [
    `re-address ${missingTestRef("R-1.1")} to derive-tests: the seeded order`,
    `re-address ${missingTestRef("R-1.2")} to ratify: the criterion asks for two states at once`,
  ].join("\n");
  const r = readdressMissingTests(d, "contract", text, { by: "contract-v2", hold: ["derive-tests"] });
  assert.deepEqual(r.readdressed, [{ id: "R-1.2", from: "contract", to: "ratify" }]);
  assert.deepEqual(r.held, [{ id: "R-1.1", to: "derive-tests" }]);
  assert.equal(read(d, MISSING_TEST).find((e) => e.item === "R-1.1").stage, "contract");
});

// What an approval settles: what the run handed on, and what it was handed and kept.
test("an approval hands on what its run supplied, stamped with the ruling, and records what the run kept", (t) => {
  const d = project(t);
  put(d, "spec/criteria-index.json", JSON.stringify({ criteria: [
    { id: "R-1.1", domain: "orders", version: 1, state: "accepted" },
    { id: "R-1.2", domain: "orders", version: 2, state: "accepted" },
    { id: "R-1.3", domain: "orders", version: 1, state: "accepted" },
    { id: "R-1.4", domain: "orders", version: 1, state: "accepted" },
  ] }));
  const R13 = { id: "R-1.3", version: 1, reason: "blocked: the criterion asks for two states", missing: "one state", owner: "contract" };
  records(d, [LEGACY, NAMED, R13]);
  commit(d, "records");
  const base = git(["rev-parse", "HEAD"], d);
  // Owed after the run was cut, so never handed to it.
  records(d, [LEGACY, NAMED, R13, { id: "R-1.4", version: 1, reason: "blocked", missing: "a seeded refund", owner: "contract" }]);
  commit(d, "a later record");
  const page = [
    "---", "gate: G1", "---", "", "## Journal: contract", "",
    `re-address ${missingTestRef("R-1.1")} to derive-tests: the seeded order`,
    `re-address ${missingTestRef("R-1.3")} to ratify: the criterion asks for two states at once`,
    "", "## Ruling", "",
    `re-address ${missingTestRef("R-1.4")} to derive-tests: a ruler quoting a line is not the run's`,
  ].join("\n");
  const opts = { stage: "contract", proposal: "contract-v2", gate: "G1", by: "agent:product-owner", page, base };
  const r = settleApprovedMissingTests(d, opts);
  assert.deepEqual(r.readdressed, [{ id: "R-1.1", from: "contract", to: "derive-tests" }, { id: "R-1.3", from: "contract", to: "ratify" }]);
  assert.deepEqual(r.kept, ["R-1.2"]);
  const byId = new Map(read(d, MISSING_TEST).map((e) => [e.item, e]));
  assert.equal(byId.get("R-1.1").stage, "derive-tests");
  assert.deepEqual(
    (({ at: _a, ...m }) => m)(byId.get("R-1.1").readdressed.at(-1)),
    { from: "contract", to: "derive-tests", why: "the seeded order", by: "contract-v2", gate: "G1", approved_by: "agent:product-owner" });
  assert.equal(byId.get("R-1.2").stage, "contract");
  assert.deepEqual((({ at: _a, ...k }) => k)(byId.get("R-1.2").kept), { by: "contract-v2", gate: "G1", approved_by: "agent:product-owner" });
  assert.equal(byId.get("R-1.4").stage, "contract");
  assert.equal(byId.get("R-1.4").kept, undefined, "an item the run was never handed is not one it kept");
  assert.equal(settleApprovedMissingTests(d, opts).path, null, "settling twice changes nothing");

  // A later move takes the item out of the owner's keeping.
  readdressMissingTests(d, "contract", `re-address ${missingTestRef("R-1.2")} to archaeology: recovered wrongly`, { by: "contract-v3" });
  assert.equal(read(d, MISSING_TEST).find((e) => e.item === "R-1.2").kept, undefined);
});

test("an approval for one domain settles only what that domain's run was handed", (t) => {
  const d = project(t);
  records(d, [{ ...NAMED, owner: "archaeology" }]);
  commit(d, "records");
  const base = git(["rev-parse", "HEAD"], d);
  const r = settleApprovedMissingTests(d, { stage: "archaeology", proposal: "archaeology-billing", gate: "G1", by: "tech-lead", page: "", base, domain: "billing" });
  assert.equal(r.path, null);
  const s = settleApprovedMissingTests(d, { stage: "archaeology", proposal: "archaeology-orders", gate: "G1", by: "tech-lead", page: "", base, domain: "orders" });
  assert.deepEqual(s.kept, ["R-1.2"]);
});

// derive-tests writes no test for a criterion another has superseded, or one made obsolete, so
// an item for one is an item nothing can ever close.
test("a criterion superseded or made obsolete is owed no test, and the next pipeline commit withdraws its item", (t) => {
  const d = project(t);
  records(d, [LEGACY, NAMED, { id: "R-1.3", version: 1, reason: "blocked", missing: "a page", owner: "contract" }]);
  commit(d, "records");
  syncMissingTests(d, {});
  commit(d, "materialised");
  put(d, "spec/criteria-index.json", JSON.stringify({ criteria: [
    { id: "R-1.1", domain: "orders", version: 1, state: "accepted", supersededBy: "R-1.3" },
    { id: "R-1.2", domain: "orders", version: 2, state: "obsolete" },
    { id: "R-1.3", domain: "orders", version: 1, state: "accepted" },
  ] }));
  commit(d, "ratified");
  assert.deepEqual(openMissingTestsAt(d, "main").map((e) => e.item), ["R-1.3"], "read as owed nothing before anything is written");
  const moved = readdressMissingTests(d, "contract", `re-address ${missingTestRef("R-1.1")} to derive-tests: supplied`, { by: "contract-v2" });
  assert.deepEqual(moved.readdressed, [], "a line cannot hand on an item nothing owes");
  const r = syncMissingTests(d, {});
  assert.deepEqual(r.withdrawn.sort(), ["R-1.1", "R-1.2"]);
  const byId = new Map(read(d, MISSING_TEST).map((e) => [e.item, e]));
  assert.equal(byId.get("R-1.1").closed.outcome, "withdrawn");
  assert.match(byId.get("R-1.1").closed.why, /R-1\.1 is superseded by R-1\.3/);
  assert.match(byId.get("R-1.2").closed.why, /R-1\.2 is obsolete/);
  assert.equal(byId.get("R-1.2").closed.by, "runner");
  assert.ok(!byId.get("R-1.3").closed);
  assert.equal(syncMissingTests(d, {}).path, null, "and nothing reopens it");
});

test("refs name an item by its criterion", () => {
  assert.equal(missingTestRef("R-1.1"), "missing-test/R-1.1");
  assert.equal(parseMissingTestRef("missing-test/R-1.1"), "R-1.1");
  assert.equal(parseMissingTestRef("build-slice-1#1"), null);
});

test("a record derive-tests writes names what is missing and a stage other than itself that owns it", () => {
  assert.deepEqual(recordProblems(NAMED), []);
  assert.match(recordProblems(LEGACY).join("\n"), /names nothing as missing/);
  assert.match(recordProblems({ ...NAMED, owner: undefined }).join("\n"), /names no stage/);
  assert.match(recordProblems({ ...NAMED, owner: "derive-tests" }).join("\n"), /derive-tests/);
  assert.match(recordProblems({ ...NAMED, owner: "reviewer" }).join("\n"), /reviewer is not a stage/);
});

test("an open item naming a slice's criterion blocks it unless withdrawn in the ruling or run by its verify result", (t) => {
  const d = project(t);
  records(d, [LEGACY, NAMED]);
  commit(d, "records");
  const claimed = ["R-1.1", "R-1.2", "R-1.3"];
  assert.deepEqual(blockingMissingTests(d, { claimed }).map((e) => e.item), ["R-1.1", "R-1.2"]);
  assert.deepEqual(blockingMissingTests(d, { claimed, withdrawn: ["R-1.1"] }).map((e) => e.item), ["R-1.2"]);
  const rows = [{ id: "R-1.2", version: 2, file: "tests/acceptance/orders/R-1.2.spec.ts", result: "pass" }];
  assert.deepEqual(blockingMissingTests(d, { claimed, withdrawn: ["R-1.1"], rows }).map((e) => e.item), []);
  assert.deepEqual(blockingMissingTests(d, { claimed: ["R-1.3"] }), []);
});

// A person in a seat is handed no prompt, and reads what is owed from `sdlc checks`.
test("sdlc checks lists every open missing test with its owner and the line that withdraws it", (t) => {
  const d = project(t);
  records(d, [LEGACY, NAMED]);
  commit(d, "records");
  const r = checkConditions(d);
  assert.equal(r.ok, true, "an owed test is a warning, not a failure");
  const lines = r.warnings.filter((w) => w.startsWith("missing-test/"));
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^missing-test\/R-1\.2: owed by contract — "a mail observation exposing the body"\. .*condition-withdrawn <ref>: <why it is no longer asked for>/);
});

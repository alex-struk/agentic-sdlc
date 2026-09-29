// test/calibrate-scope.test.mjs — which rows a calibration re-runs and which it carries
// (`src/testrun/scope.mjs`, `docs/decisions/0072-a-calibration-re-runs-what-changed.md`).
//
// The oracle never changes, so a row's result can only change when one of its inputs does: its
// test file, the adapter, the contract and seed, the oracle's override, or the harness the suite
// runs in. These tests hold the rule over plain data; `test/calibrate.test.mjs` holds the stage
// that acts on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRunIds, fullRunDue, planCalibration, rulingsSeen, stampProvenance } from "../src/testrun/scope.mjs";

const INPUTS = { adapter: "a1", contract_seed: "c1", override: "o1", harness: "h1" };
const CHANGED = { policy: { calibrate: { scope: "changed" } } };

const row = (id, result, more = {}) => ({
  id, version: 1, domain: "alpha", file: `tests/acceptance/alpha/${id}.spec.ts`, result, tests: [],
  file_sha: `sha-${id}`, adapter: "a1", contract_seed: "c1", override: "o1", harness: "h1", measured_in: "2026-01-01", ...more,
});

const spec = (id, sha = `sha-${id}`) => ({ file: `tests/acceptance/alpha/${id}.spec.ts`, sha });

function plan(rows, more = {}) {
  return planCalibration({
    config: CHANGED,
    previous: { run: "2026-01-01", scope: "full", full_run: "2026-01-01", since_full: 0, rows },
    specs: rows.filter((r) => r.file).map((r) => spec(r.id)),
    inputs: INPUTS,
    stale: new Set(),
    rulings: () => [],
    owed: new Map(),
    ...more,
  });
}

const rerunIds = (p) => p.rerun.map((r) => r.id);
const reasonsOf = (p, id) => p.rerun.find((r) => r.id === id)?.reasons;

test("with policy.calibrate.scope unset every calibration is full, as it always was", () => {
  const p = plan([row("R-1", "pass")], { config: {} });
  assert.equal(p.mode, "full");
  assert.deepEqual(p.fullBecause, ["policy.calibrate.scope is full"]);
  assert.deepEqual(rerunIds(p), ["R-1"]);
  assert.deepEqual(p.carry, []);
});

test("a row none of whose inputs changed is carried, and one whose test changed is re-run", () => {
  const rows = [row("R-1", "pass"), row("R-2", "fail"), row("R-3", "pass")];
  const p = plan(rows, { specs: [spec("R-1"), spec("R-2"), spec("R-3", "sha-new")] });
  assert.equal(p.mode, "changed");
  assert.deepEqual(rerunIds(p), ["R-3"]);
  assert.deepEqual(reasonsOf(p, "R-3"), ["test changed"]);
  assert.deepEqual(p.carry.map((r) => r.id), ["R-1", "R-2"]);
  assert.equal(p.total, 3);
});

test("a changed adapter re-runs the rows it could close, and carries the ones already passing or ruled", () => {
  const rows = [row("R-1", "pass"), row("R-2", "fail"), row("R-3", "unbound"), row("R-4", "fail", { ruled: "defect-in-old" })];
  const p = plan(rows, { inputs: { ...INPUTS, adapter: "a2" } });
  assert.deepEqual(rerunIds(p), ["R-2", "R-3"]);
  assert.deepEqual(reasonsOf(p, "R-2"), ["adapter changed"]);
  assert.deepEqual(p.carry.map((r) => r.id), ["R-1", "R-4"]);
});

test("a new test, a row with no provenance and a row the machine failed are always re-run", () => {
  const envFault = row("R-2", "fail", { tests: [{ title: "t", status: "failed", error: "Error: could not reset the target" }] });
  const { measured_in: _m, ...bare } = row("R-3", "pass");
  const p = plan([row("R-1", "pass"), envFault, bare], { specs: [spec("R-1"), spec("R-2"), spec("R-3"), spec("R-4")] });
  assert.deepEqual(rerunIds(p), ["R-2", "R-3", null]);
  assert.deepEqual(reasonsOf(p, "R-2"), ["environment fault"]);
  assert.deepEqual(reasonsOf(p, "R-3"), ["no provenance"]);
  assert.deepEqual(p.rerun[2], { file: "tests/acceptance/alpha/R-4.spec.ts", id: null, reasons: ["new test"] });
});

test("a row named by open owed work, ruled on since it was measured, or whose staleness moved is re-run", () => {
  const rows = [row("R-1", "pass"), row("R-2", "fail", { rulings_seen: ["calibrate-triage-old-1"] }), row("R-3", "pass"), row("R-4", "pass")];
  const p = plan(rows, {
    owed: new Map([["R-1", ["owed a rebind"]]]),
    rulings: (id) => (id === "R-2" ? ["calibrate-old-2", "calibrate-triage-old-1"] : []),
    stale: new Set(["R-3"]),
  });
  assert.deepEqual(rerunIds(p), ["R-1", "R-2", "R-3"]);
  assert.deepEqual(reasonsOf(p, "R-1"), ["owed a rebind"]);
  assert.deepEqual(reasonsOf(p, "R-2"), ["ruled since measured"]);
  assert.deepEqual(reasonsOf(p, "R-3"), ["staleness changed"]);
  assert.deepEqual(p.carry.map((r) => r.id), ["R-4"]);
});

test("any change to the contract and seed, the oracle's override or the harness makes the run full", () => {
  for (const [key, said] of [["contract_seed", /spec\/contract\/ or the seed/], ["override", /Compose override/], ["harness", /harness/]]) {
    const p = plan([row("R-1", "pass")], { inputs: { ...INPUTS, [key]: "changed" } });
    assert.equal(p.mode, "full", key);
    assert.match(p.fullBecause.join("; "), said);
    assert.deepEqual(p.carry, []);
  }
});

test("--full, no results on file, and every row's inputs having changed each make the run full", () => {
  assert.deepEqual(plan([row("R-1", "pass")], { force: true }).fullBecause, ["--full"]);
  const none = planCalibration({ config: CHANGED, previous: null, specs: [spec("R-1")], inputs: INPUTS, stale: new Set(), rulings: () => [], owed: new Map() });
  assert.deepEqual(none.fullBecause, ["no results on file"]);
  const all = plan([row("R-1", "pass")], { specs: [spec("R-1", "sha-new")] });
  assert.equal(all.mode, "full");
  assert.deepEqual(all.fullBecause, ["every test's inputs changed"]);
});

test("policy.calibrate.full_every makes every n-th calibration full", () => {
  const cfg = { policy: { calibrate: { scope: "changed", full_every: 3 } } };
  const at = (since) => plan([row("R-1", "pass")], { config: cfg, previous: { run: "2026-01-03", scope: "changed", full_run: "2026-01-01", since_full: since, rows: [row("R-1", "pass")] } });
  assert.equal(at(0).mode, "changed");
  assert.equal(at(1).mode, "changed");
  assert.equal(at(2).mode, "full");
  assert.match(at(2).fullBecause[0], /^2 scoped calibrations since the last full run \(2026-01-01\); policy\.calibrate\.full_every is 3$/);
  assert.equal(fullRunDue(cfg, { since_full: 1 }), null);
  assert.match(fullRunDue(cfg, { since_full: 2, full_run: "2026-01-01" }), /full_every is 3/);
  assert.equal(fullRunDue({ policy: { calibrate: { full_every: 3 } } }, { since_full: 5 }), null, "under scope full every run is full already");
});

test("--domain re-runs that domain and carries every other row, whatever changed", () => {
  const nt = (id, domain) => ({ id, domain, file: null, result: "not-testable", tests: [] });
  const rows = [row("R-1", "pass"), { ...row("R-2", "pass"), domain: "beta", file: "tests/acceptance/beta/R-2.spec.ts" }, nt("R-8", "alpha"), nt("R-9", "beta")];
  const p = plan(rows, { domain: "beta", specs: [spec("R-1", "sha-new"), { file: "tests/acceptance/beta/R-2.spec.ts", sha: "sha-R-2" }] });
  assert.equal(p.mode, "domain");
  assert.deepEqual(rerunIds(p), ["R-2"]);
  assert.deepEqual(reasonsOf(p, "R-2"), ["--domain beta"]);
  // A run narrowed to a domain reads only that domain's not-testable entries again.
  assert.deepEqual(p.carry.map((r) => r.id), ["R-1", "R-8"]);
});

test("a row whose file is gone is neither re-run nor carried, and a row with no file is regenerated", () => {
  const nt = { id: "R-9", domain: "alpha", file: null, result: "not-testable", tests: [] };
  const p = plan([row("R-1", "pass"), row("R-2", "pass"), nt], { specs: [spec("R-1"), spec("R-3")] });
  assert.deepEqual(rerunIds(p), [null]);
  assert.deepEqual(p.carry.map((r) => r.id), ["R-1"]);
});

test("a measured row records what it ran with, and the gates that had ruled on it", () => {
  const stamped = stampProvenance({ id: "R-1", file: "f", result: "pass" }, { run: "2026-01-02", inputs: INPUTS, rulings: ["calibrate-old-1"] });
  assert.deepEqual(stamped, { id: "R-1", file: "f", result: "pass", adapter: "a1", contract_seed: "c1", override: "o1", harness: "h1", measured_in: "2026-01-02", rulings_seen: ["calibrate-old-1"] });
  const nt = stampProvenance({ id: "R-2", file: null, result: "not-testable" }, { run: "2026-01-02", inputs: INPUTS, rulings: [] });
  assert.deepEqual(nt, { id: "R-2", file: null, result: "not-testable", measured_in: "2026-01-02" });
});

test("the gates that ruled on a criterion are read off applied.yaml, once each, in order", () => {
  const applied = [
    { id: "R-1", verb: "product-question", gate: "calibrate-triage-old-2" },
    { id: "R-1", verb: "defect-in-old", gate: "calibrate-old-1" },
    { id: "R-2", verb: "test-wrong", gate: "calibrate-old-1" },
    { id: "R-1", verb: "defect-in-old", gate: "calibrate-old-1" },
  ];
  assert.deepEqual(rulingsSeen(applied, "R-1"), ["calibrate-old-1", "calibrate-triage-old-2"]);
  assert.deepEqual(rulingsSeen(applied, "R-3"), []);
});

test("run ids order by day, then by the number a second run on the same day takes", () => {
  const ids = ["2026-01-02", "2026-01-01-10", "2026-01-01-2", "2026-01-01"];
  assert.deepEqual([...ids].sort(compareRunIds), ["2026-01-01", "2026-01-01-2", "2026-01-01-10", "2026-01-02"]);
});

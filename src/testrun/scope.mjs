// Which rows a calibration re-runs, and which it carries from the run that last measured them
// (`docs/decisions/0072-a-calibration-re-runs-what-changed.md`).
//
// The oracle is the old application, and it does not change. A row's result can therefore only
// change when something it ran with does: its own test file, the target's adapter, the contract
// and seed the oracle is started and reset with, the oracle's Compose override, or the harness the
// suite runs in. Every row records those inputs and the run that measured it (`measured_in`), and
// a calibration under `policy.calibrate.scope: changed` re-runs a row only when one of them moved,
// or when something else says it has to be looked at again.
//
// The contract and seed, the override and the harness are shared by every row, so a change to any
// of them makes the run full. The adapter is shared too, but a change to it is usually a binding
// fix for a few members: re-running every row for it would make the scope useless in exactly the
// phase it is for. So a changed adapter re-runs the rows it could close — every row not passing
// and not ruled — and carries the passing ones. A passing test an unrelated adapter change broke
// is found by the next full run, which `policy.calibrate.full_every` and the Tests phase's exit
// both bring.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitOk } from "../lib/git.mjs";
import { calibrateFullEvery, calibrateScope } from "../config/policy.mjs";
import { oracleOverridePath } from "../oracle/paths.mjs";
import { environmentFault, testFingerprint } from "./results.mjs";
import { specFiles } from "./tags.mjs";

// The harness every test runs in: its fixtures, its configuration and its dependencies, and the
// code generated from the contract that tests import. A change to any of it can change any row.
export const HARNESS_PATHS = Object.freeze([
  "tests/fixtures/", "tests/generated/", "tests/playwright.config.ts", "tests/package.json", "tests/package-lock.json", "tests/tsconfig.json",
]);

// The id of a dated run: its results file's name without `.json`, `2026-01-01` or `2026-01-01-2`.
export const runIdOf = (name) => String(name).replace(/\.json$/, "");

// Run ids in the order the runs happened: by day, then by the number a later run on the same day
// takes (`-2`, `-3`, … `-10`), which a plain string sort puts in the wrong place.
export function compareRunIds(a, b) {
  const parse = (id) => { const m = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/.exec(String(id ?? "")); return m ? [m[1], Number(m[2] ?? 1)] : [String(id ?? ""), 0]; };
  const [da, na] = parse(a);
  const [db, nb] = parse(b);
  return da === db ? na - nb : da < db ? -1 : 1;
}

// The gates whose rulings name `id` in `applied.yaml`'s `rulings`, once each, sorted. Recorded on a
// row when it is measured, so a ruling applied since is seen as a change.
export function rulingsSeen(rulings, id) {
  return [...new Set((rulings ?? []).filter((r) => r?.id === id && r?.gate).map((r) => String(r.gate)))].sort();
}

// A row this run measured, with the inputs it ran with. A row with no spec file (a not-testable
// entry) ran nothing, so it records only the run that wrote it.
export function stampProvenance(row, { run, inputs, rulings }) {
  if (!row?.file) return { ...row, measured_in: run };
  const seen = rulings ?? [];
  return {
    ...row,
    adapter: inputs.adapter, contract_seed: inputs.contract_seed, override: inputs.override, harness: inputs.harness,
    measured_in: run,
    ...(seen.length ? { rulings_seen: seen } : {}),
  };
}

const hash = (parts) => createHash("sha1").update(parts.join("\n")).digest("hex");

function objectAt(projectDir, rev, path) {
  const ref = `${rev}:${path.replace(/\/+$/, "")}`;
  return gitOk(["rev-parse", "-q", "--verify", ref], projectDir) ? git(["rev-parse", ref], projectDir) : "";
}

// What every row of a calibration of `target` shares, as git names it at `rev`: the adapter's
// tree, one hash over the contract's and the seed's trees, the override's blob, and one hash over
// the harness. A calibration runs on a clean tree, so `HEAD` is what the suite runs.
export function calibrationInputs(projectDir, config, target, rev = "HEAD") {
  const at = (p) => objectAt(projectDir, rev, p);
  return {
    adapter: at(`tests/adapters/${target}`),
    contract_seed: hash([at("spec/contract"), at(config?.oracle?.seed ?? "tests/seed/")]),
    override: at(oracleOverridePath(config)),
    harness: hash(HARNESS_PATHS.map((p) => `${p}=${at(p)}`)),
  };
}

// Every spec file on disk with git's id for its content, the same fingerprint a row records as
// `file_sha`.
export function currentSpecs(projectDir) {
  return specFiles(projectDir).map((file) => ({ file, sha: testFingerprint(readFileSync(join(projectDir, file))) }));
}

// How many suite runs have gone by since the last full one, as `latest.json` records it.
export const sinceFull = (latest) => (Number.isInteger(latest?.since_full) ? latest.since_full : 0);

// Results with rows and not one recording what it ran with: written before rows recorded their
// provenance, so there is nothing a plan can compare against.
const unprovenanced = (latest) => {
  const rows = (latest?.rows ?? []).filter((r) => r?.file);
  return rows.length > 0 && !rows.some((r) => r.measured_in);
};

// Why the next calibration of a target has to be full, or `null`: results that record no
// provenance, which the first calibration after a project chooses `scope: changed` meets once, or
// `policy.calibrate.full_every`. Never under `scope: full`, where every calibration is full
// already.
export function fullRunDue(config, latest) {
  if (calibrateScope(config) !== "changed" || !latest) return null;
  if (unprovenanced(latest)) return "no row on file records the inputs it ran with, so the first calibration under policy.calibrate.scope: changed measures every row";
  const n = calibrateFullEvery(config);
  if (n === null) return null;
  const since = sinceFull(latest);
  if (since + 1 < n) return null;
  return `${since} scoped calibration${since === 1 ? "" : "s"} since the last full run${latest.full_run ? ` (${latest.full_run})` : ""}; policy.calibrate.full_every is ${n}`;
}

const closed = (row) => row?.result === "pass" || Boolean(row?.ruled);

// The reason a missing test owed a run by calibration gives.
export const OWED_A_RUN = "missing test owed a run";

// Why one row on file has to be re-run, or `[]` when it can be carried. A row closed as
// `persona-unavailable` needs a persona the approved contract marks unavailable on the target, so
// no run there can pass or fail it, and a missing test owed a run for it is no reason to run it
// again (`docs/decisions/0068`).
function rowReasons(row, sha, { inputs, stale, rulings, owed }) {
  const reasons = [];
  if (!row.measured_in || !row.file_sha) return ["no provenance"];
  if (row.file_sha !== sha) reasons.push("test changed");
  if (environmentFault(row)) reasons.push("environment fault");
  if (!closed(row) && row.adapter !== inputs.adapter) reasons.push("adapter changed");
  if (row.id) {
    reasons.push(...(owed.get(row.id) ?? []).filter((why) => !(why === OWED_A_RUN && row.ruled === "persona-unavailable")));
    if (rulings(row.id).join("\n") !== (row.rulings_seen ?? []).join("\n")) reasons.push("ruled since measured");
    if ((row.result === "stale") !== stale.has(row.id)) reasons.push("staleness changed");
  }
  return reasons;
}

// Why the whole suite has to run, from what every row shares.
function sharedChanges(rows, inputs) {
  const measured = rows.filter((r) => r?.file && r.measured_in);
  const said = [];
  const moved = (key) => measured.some((r) => r[key] !== undefined && r[key] !== inputs[key]);
  if (moved("contract_seed")) said.push("spec/contract/ or the seed changed since rows on file were measured");
  if (moved("override")) said.push("the oracle's Compose override changed since rows on file were measured");
  if (moved("harness")) said.push("the test harness changed since rows on file were measured");
  return said;
}

// The plan for one calibration.
//
// `previous` is `latest.json` as it stands, `specs` every spec
// file on disk with its fingerprint, `inputs` what the rows share now, `stale` the criteria whose
// test is stale now, `rulings(id)` the gates whose rulings name a criterion now, `owed` the open
// owed work naming each criterion (`id -> [reason]`), `domain` a `--domain` narrowing and `force`
// `--full`.
//
// Returns `{ mode, fullBecause, rerun, carry, total }`: `mode` is `full`, `changed` or `domain`;
// `rerun` the spec files to run, each `{ file, id, reasons }`; `carry` the rows on file kept as
// they are; `total` how many spec files there are.
export function planCalibration({ config, previous, specs, inputs, stale = new Set(), rulings = () => [], owed = new Map(), domain, force = false }) {
  const rows = Array.isArray(previous?.rows) ? previous.rows : [];
  const byFile = new Map(rows.filter((r) => r?.file).map((r) => [r.file, r]));
  const total = specs.length;
  const full = (because) => ({
    mode: "full", fullBecause: because, carry: [], total,
    rerun: specs.map((s) => ({ file: s.file, id: byFile.get(s.file)?.id ?? null, reasons: ["full run"] })),
  });

  if (force) return full(["--full"]);
  if (domain === undefined && calibrateScope(config) === "full") return full(["policy.calibrate.scope is full"]);
  if (!rows.length) return full(["no results on file"]);

  if (domain !== undefined) {
    const rerun = [];
    const carry = [];
    for (const s of specs) {
      const r = byFile.get(s.file);
      if (s.file.split("/")[2] === domain) rerun.push({ file: s.file, id: r?.id ?? null, reasons: [`--domain ${domain}`] });
      else if (r) carry.push(r);
    }
    // A run narrowed to a domain reads only that domain's not-testable entries again.
    carry.push(...rows.filter((r) => r && !r.file && r.domain !== domain));
    return { mode: "domain", fullBecause: [], rerun, carry, total };
  }

  const shared = sharedChanges(rows, inputs);
  if (shared.length) return full(shared);
  const due = fullRunDue(config, previous);
  if (due) return full([due]);

  const rerun = [];
  const carry = [];
  for (const s of specs) {
    const r = byFile.get(s.file);
    const reasons = r ? rowReasons(r, s.sha, { inputs, stale, rulings, owed }) : ["new test"];
    if (reasons.length) rerun.push({ file: s.file, id: r?.id ?? null, reasons });
    else carry.push(r);
  }
  if (rerun.length && rerun.length === total) return full(["every test's inputs changed"]);
  return { mode: "changed", fullBecause: [], rerun, carry, total };
}

// `N of M re-run (reasons), K carried from <runs>` — how a plan reads in a summary and a dry run.
export function describePlan(plan) {
  if (plan.mode === "full") return `Full run: all ${plan.total} test file(s) re-run (${plan.fullBecause.join("; ")}).`;
  const counts = new Map();
  for (const r of plan.rerun) for (const why of r.reasons) counts.set(why, (counts.get(why) ?? 0) + 1);
  const reasons = [...counts.entries()].map(([why, n]) => `${n} ${why}`).join(", ");
  const from = new Map();
  for (const r of plan.carry) from.set(r.measured_in ?? "an unrecorded run", (from.get(r.measured_in ?? "an unrecorded run") ?? 0) + 1);
  const runs = [...from.entries()].sort((a, b) => compareRunIds(b[0], a[0]));
  const carried = runs.length === 1 ? `from ${runs[0][0]}` : `from ${runs.map(([id, n]) => `${id} (${n})`).join(", ")}`;
  return `${plan.rerun.length} of ${plan.total} re-run${reasons ? ` (${reasons})` : ""}, ${plan.carry.length} carried${plan.carry.length ? ` ${carried}` : ""}.`;
}

// How many more calibrations of this target can be scoped before `full_every` makes one full,
// as a sentence, or `null` where no cadence is set.
export function fullRunCountdown(config, latest) {
  if (calibrateScope(config) !== "changed") return null;
  const n = calibrateFullEvery(config);
  if (n === null) return "No full run is scheduled (policy.calibrate.full_every is unset); the Tests phase still closes only on a run that measures every row.";
  const left = n - 1 - sinceFull(latest);
  return left <= 0
    ? `The next calibration is full (policy.calibrate.full_every: ${n}).`
    : `A full run is due after ${left} more scoped calibration${left === 1 ? "" : "s"} (policy.calibrate.full_every: ${n}).`;
}

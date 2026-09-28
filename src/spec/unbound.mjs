// A calibration row the adapter could not drive (`docs/decisions/0067`).
//
// A row is `unbound` when every failing test in it ended in the adapter's own `unbound:` error
// (`src/testrun/playwright.mjs`): the adapter says the surface member the test needed does not
// exist on the target. That is a gap in the binding, not a difference in behaviour, so neither
// the reviewer's triage nor the product owner's ruling is asked about it, and the one run that
// can close it is a binding run for its target. Until one does, or a ruling closes the row, the
// Tests phase does not exit (`calibrated`, `src/runner/next.mjs`).
//
// So an open unbound row is owed work of kind `rebind` (`src/spec/owed.mjs`), owed by
// `bind-adapter` for the row's target, in the shape a reviewer's `adapter-wrong` verdict files,
// with two fields beside it: `found: unbound`, which is how a reader tells the adapter's own
// report from a reviewer's finding, and `adapter`, the tree of `tests/adapters/<target>` the row
// was found under. `why` is the adapter's own reason, each distinct `unbound:` message on the
// row once, which is what the binding run is shown.
//
// **One send per adapter.** An entry is about one version of the adapter. When calibration runs
// against an adapter that has changed since, the entry lapses (closed as met: the adapter has
// changed), and a row still unbound under the new adapter is filed again, which is the item's
// second send. The count is `sends`, the same one `policy.loops.rebind` bounds for a reviewer's
// verdicts, and the two kinds of finding about one criterion on one target count together: the
// loop is the same binding going back to the same stage.
//
// **The limit.** An item is filed only while it has been sent fewer times than
// `policy.loops.rebind`. Past that it is no longer owed to `bind-adapter`, which has had as many
// attempts as the policy allows, and `sdlc next` lists it as waiting on a ruler instead.
//
// **Rows nothing has filed.** A row on file with no entry for it is owed all the same, by every
// reader, the way a missing test's record is (`src/spec/missing-tests.mjs`): `sdlc next` and a
// binding run read it, and the next calibration writes it. A row that records no adapter was
// found under the adapter at the commit that last wrote the results file.
//
// **Closing.** Calibration closes an entry whose row is no longer an open unbound row: as met
// when the row now passes or fails (the adapter reaches what the test needs), and as withdrawn
// when the row is ruled, is some other result, or is gone.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fsx.mjs";
import { git, gitOk } from "../lib/git.mjs";
import { owedLoopLimit } from "../config/policy.mjs";
import { redactLocalPaths } from "../lib/redact.mjs";
import { close, isOpen, open, read, sends } from "./owed.mjs";

export const UNBOUND = "unbound";

const KIND = "rebind";
const BY = "runner:calibrate";
const UNBOUND_LINE = /^(?:Error: )?(unbound: .*)$/m;

const itemOf = (target, id) => `${target}:${id}`;

// The rows no ruling covers whose every failing test the adapter reported unbound.
export function openUnboundRows(results) {
  return (Array.isArray(results?.rows) ? results.rows : []).filter((r) => r?.result === UNBOUND && r.id && !r.ruled);
}

// The adapter's own reasons on a row, each distinct message once, in the order the tests gave
// them.
export function unboundWhy(row) {
  const said = [];
  const take = (text) => {
    const m = UNBOUND_LINE.exec(String(text ?? ""));
    const line = m?.[1]?.trim();
    if (line && !said.includes(line)) said.push(line);
  };
  for (const t of row?.tests ?? []) if (t?.status !== "passed" && t?.status !== "skipped") take(t?.error);
  if (!said.length) take(row?.error);
  return said.join("; ") || "unbound: the adapter gave no reason";
}

// The tree of `tests/adapters/<target>` at `rev`, or "" where it has none.
export function adapterAt(projectDir, target, rev = "HEAD") {
  const ref = `${rev}:tests/adapters/${target}`;
  return gitOk(["rev-parse", "-q", "--verify", ref], projectDir) ? git(["rev-parse", ref], projectDir) : "";
}

// The adapter a row that records none was found under: the one at the commit that last wrote the
// target's results file on `rev`, or "" where no commit has.
export function legacyAdapter(projectDir, target, rev = "HEAD") {
  let commit = "";
  try { commit = git(["log", "-1", "--format=%H", rev, "--", `tests/results/${target}/latest.json`], projectDir); } catch { return ""; }
  return commit ? adapterAt(projectDir, target, commit) : "";
}

function entryFor(target, row, adapter) {
  return { kind: KIND, item: itemOf(target, row.id), stage: "bind-adapter", id: row.id, target, why: unboundWhy(row), found: UNBOUND, adapter, closed: null };
}

// What the open unbound rows of one target owe, read without writing. `rows` are the target's
// results, `adapter` the adapter the target has now, `fallback` the one a row that records none
// was found under, and `entries` every rebind entry on file, open and closed.
//
// A row with an open entry is owed as that entry. Otherwise a row found under an adapter that
// has since changed is `pending` whatever its count, carrying the adapter it was found under, so
// a reader sends it to calibration to be looked at again; one found under the adapter the target
// has now is `pending` while it has been sent fewer than `limit` times, and `spent` once it has
// been sent that many.
export function unboundOwed({ target, rows, adapter, fallback = "", entries = [], limit }) {
  const pending = [];
  const spent = [];
  const held = new Set(entries.filter((e) => e?.kind === KIND && isOpen(e)).map((e) => e.item));
  for (const row of openUnboundRows({ rows })) {
    const item = itemOf(target, row.id);
    if (held.has(item)) continue;
    const found = row.adapter ?? fallback;
    if (found !== adapter) { pending.push(entryFor(target, row, found)); continue; }
    const n = sends(entries, item);
    if (n < limit) pending.push(entryFor(target, row, adapter));
    else spent.push({ id: row.id, target, sends: n, limit, why: unboundWhy(row) });
  }
  return { pending, spent };
}

function readResults(projectDir, target) {
  const p = join(projectDir, "tests", "results", target, "latest.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readText(p)); } catch { return null; }
}

// What a binding run for `target` is handed beyond its open rebind entries: the unbound rows in
// the working tree nothing has filed, found under the adapter it is about to change and not yet
// sent as often as `policy.loops.rebind` allows.
export function unboundHanded(projectDir, target, config) {
  const results = readResults(projectDir, target);
  if (!openUnboundRows(results).length) return [];
  const adapter = adapterAt(projectDir, target);
  const { pending } = unboundOwed({
    target, rows: results.rows, adapter, fallback: legacyAdapter(projectDir, target),
    entries: read(projectDir, KIND), limit: owedLoopLimit(config, KIND),
  });
  return pending.filter((e) => e.adapter === adapter);
}

// Brings the target's unbound entries into line with `rows`, stamped by the runner. `adapter` is
// the adapter the target has now, and `fallback` the one a row that records none was found
// under. In order:
//
// 1. A row found under an earlier adapter, never filed under it, and sent fewer than `limit`
//    times, is filed under that adapter: whatever it was owed was sent under it.
// 2. Every open unbound entry filed under another adapter than `adapter` lapses, closed as met.
// 3. With `settle` (the rows a calibration has just produced), a row found under `adapter`,
//    with no open entry and sent fewer than `limit` times, is filed; and an open entry under
//    `adapter` whose row is no longer an open unbound row is closed.
//
// Returns the path written (`null` when nothing changed) and the criteria opened and closed.
export function syncUnbound(projectDir, target, { rows = [], adapter, fallback = "", limit, settle = true, at = new Date().toISOString() } = {}) {
  const opened = [];
  const closed = [];
  let path = null;
  const wrote = (p) => { if (p) path = p; };
  const unbound = openUnboundRows({ rows });
  const foundUnder = (row) => row.adapter ?? fallback;
  const stamp = { by: BY, at };
  // The reason is written into a committed file, so it is scrubbed of local paths here, where
  // it is written (`docs/decisions/0020`).
  const why = (row) => redactLocalPaths(unboundWhy(row), projectDir);

  let entries = read(projectDir, KIND);
  const earlier = unbound.filter((row) => {
    const found = foundUnder(row);
    if (!found || found === adapter) return false;
    const item = itemOf(target, row.id);
    if (entries.some((e) => e.item === item && (isOpen(e) || (e.found === UNBOUND && e.adapter === found)))) return false;
    return sends(entries, item) < limit;
  });
  const filed = open(projectDir, KIND, earlier.map((row) => ({ id: row.id, target, why: why(row), found: UNBOUND, adapter: foundUnder(row), ...stamp })));
  wrote(filed.path);
  opened.push(...filed.added.map((e) => e.id));

  const lapsed = read(projectDir, KIND).filter((e) => isOpen(e) && e.found === UNBOUND && e.target === target && e.adapter !== adapter);
  if (lapsed.length) {
    const ids = new Set(lapsed.map((e) => e.id));
    wrote(close(projectDir, KIND, (e) => e.found === UNBOUND && e.target === target && ids.has(e.id) && e.adapter !== adapter, {
      outcome: "met", why: `tests/adapters/${target} has changed since this was found`, ...stamp,
    }));
    closed.push(...lapsed.map((e) => e.id));
  }
  if (!settle) return { path, opened, closed };

  entries = read(projectDir, KIND);
  const fresh = unbound.filter((row) => foundUnder(row) === adapter && !entries.some((e) => isOpen(e) && e.item === itemOf(target, row.id)) && sends(entries, itemOf(target, row.id)) < limit);
  const now = open(projectDir, KIND, fresh.map((row) => ({ id: row.id, target, why: why(row), found: UNBOUND, adapter, ...stamp })));
  wrote(now.path);
  opened.push(...now.added.map((e) => e.id));

  const stillOwed = new Set(unbound.filter((row) => foundUnder(row) === adapter).map((row) => row.id));
  const byId = new Map(rows.filter((r) => r?.id).map((r) => [r.id, r]));
  const closures = new Map();
  for (const e of read(projectDir, KIND)) {
    if (!isOpen(e) || e.found !== UNBOUND || e.target !== target || e.adapter !== adapter || stillOwed.has(e.id)) continue;
    const row = byId.get(e.id);
    const closure = row && !row.ruled && (row.result === "pass" || row.result === "fail")
      ? { outcome: "met", why: `the calibration row is ${row.result} under this adapter` }
      : { outcome: "withdrawn", why: row?.ruled ? `the calibration row is ruled ${row.ruled}` : row ? `the calibration row is ${row.result}` : "the calibration has no row for it" };
    const key = JSON.stringify(closure);
    if (!closures.has(key)) closures.set(key, { closure, ids: new Set() });
    closures.get(key).ids.add(e.id);
  }
  for (const { closure, ids } of closures.values()) {
    wrote(close(projectDir, KIND, (e) => e.found === UNBOUND && e.target === target && e.adapter === adapter && ids.has(e.id), { ...closure, ...stamp }));
    closed.push(...ids);
  }
  return { path, opened, closed };
}

// A requirement with no test (`docs/operating-model.md` §7, `docs/decisions/0046`).
//
// A criterion `derive-tests` records in `tests/acceptance/not-testable.yaml` is owed a test.
// The record names what is missing (`missing`) and the stage that owns supplying it (`owner`),
// and the owed item is an entry of kind `missing-test` in `.sdlc/owed.yaml`, in the shape every
// owed entry has (`src/spec/owed.mjs`): `item` is the criterion, `stage` the stage that owes it,
// `why` what is missing. Beside those it carries the criterion's `id`, `version` and `domain`,
// the `target` a calibration runs it on once it is owed a run, and `readdressed`, every move
// from one owing stage to another with who moved it and why.
//
// The pipeline keeps no list of reasons. Anything that can be missing is owned by some stage,
// and the record says which; a record that names none is read as owed by `contract`, the stage
// whose surface, seed and observations a blind test reaches the application through
// (`docs/decisions/0007`).
//
// **Opening.** An item opens when its record is on `main`. An approval that brings records onto
// `main` writes their entries in the merge, stamped with the ruling (`syncMissingTests`). A
// record already on `main` with no entry is read as open all the same (`openMissingTestsAt`),
// by every reader, so nothing waits on a write to be owed; its entry is written, stamped by the
// runner, by the next pipeline commit that touches this list. A read never writes.
//
// **Closing.** Only on evidence that a test ran: a result row for the criterion, at its current
// version, from a spec file, whose result is `pass` or `fail`. An `attested` row is somebody's
// word and closes nothing. A test that exists and has not run yet is owed a run, by `calibrate`
// where the project calibrates and by `verify` where it does not.
//
// **Withdrawing.** A ruler, with a written reason, through the same accounting line a condition
// is withdrawn with (`condition-withdrawn missing-test/<id>: <why>`). A withdrawal holds for the
// version it was made at; a record at a later version is owed again.
//
// **Re-addressing.** The stage that owes an item, when it is handed it, may say in its journal
// that the item is another stage's (`re-address missing-test/<id> to <stage>: <why>`), and a
// record `derive-tests` rewrites with a different owner moves the item when it is approved. A
// hand-on to `derive-tests` from a gated stage rests on what that stage supplied, so it is
// applied by the approval that brings the supply onto `main`, stamped with the ruling; any
// other move is applied when the run finishes. An approval, and a run's finish, act only on what the
// run was handed: the items its stage owed in its domain when its branch was cut. What the approved run was handed and did not
// hand on it kept (`kept`), and no run of that stage is offered for it again.
//
// **Retired criteria.** A criterion another supersedes, or one made obsolete, is derived no
// test, so it is owed none: every reader leaves it out, and the next pipeline commit that
// touches this list withdraws its item, stamped by the runner.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readText } from "../lib/fsx.mjs";
import { git } from "../lib/git.mjs";
import { STAGES, stagesFor } from "../profiles.mjs";
import { isOpen, open, owedPath, read, readAt, rewrite } from "./owed.mjs";

export const MISSING_TEST = "missing-test";
export const NOT_TESTABLE_PATH = "tests/acceptance/not-testable.yaml";
export const DEFAULT_OWNER = "contract";
export const WRITER = "derive-tests";

const REF_PREFIX = `${MISSING_TEST}/`;
const RAN = new Set(["pass", "fail"]);

// How a ruler and a stage name one item: the kind and the criterion.
export const missingTestRef = (id) => `${REF_PREFIX}${id}`;

export function parseMissingTestRef(ref) {
  const s = String(ref ?? "");
  return s.startsWith(REF_PREFIX) && s.length > REF_PREFIX.length ? s.slice(REF_PREFIX.length) : null;
}

const text = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

// What a record names as missing, falling back to its reason for a record that names nothing.
export function recordMissing(record) {
  return text(record?.missing) || text(record?.reason);
}

// The stage a record names as owning what is missing, or `contract` where it names none.
export function recordOwner(record) {
  return text(record?.owner) || DEFAULT_OWNER;
}

// What is wrong with a record `derive-tests` writes. It names what is missing and the stage
// that owns supplying it, and that stage is not `derive-tests` itself: a record owed back to
// the writer is a test it declined to write.
export function recordProblems(record) {
  const id = record?.id ?? "?";
  const problems = [];
  if (!text(record?.missing)) problems.push(`${id} names nothing as missing: say what would have to exist for a test to reach it (missing: "...")`);
  const owner = text(record?.owner);
  if (!owner) problems.push(`${id} names no stage that owns supplying what is missing (owner: <stage>)`);
  else if (!STAGES.includes(owner)) problems.push(`${id} names ${owner} as its owner, and ${owner} is not a stage; name the stage that supplies what is missing`);
  else if (owner === "derive-tests") problems.push(`${id} names derive-tests as its owner; a record is owed to the stage that supplies what the test writer lacks, never to the writer`);
  return problems;
}

function recordsIn(raw) {
  let parsed;
  try { parsed = parseYaml(raw ?? ""); } catch { return []; }
  const list = Array.isArray(parsed?.criteria) ? parsed.criteria : [];
  return list.filter((r) => r && typeof r === "object" && typeof r.id === "string" && r.id);
}

function showAt(projectDir, rev, rel) {
  try { return git(["show", `${rev}:${rel}`], projectDir); } catch { return null; }
}

function workingText(projectDir, rel) {
  const p = join(projectDir, rel);
  return existsSync(p) ? readText(p) : null;
}

function indexIn(raw) {
  try { return new Map((JSON.parse(raw ?? "").criteria ?? []).map((c) => [c.id, c])); } catch { return new Map(); }
}

// Whether the entries on file account for a record: an open entry for the criterion, or a
// withdrawal made at the record's version. A met entry does not: a record says no test exists,
// and an item closed because one ran is owed again when the record comes back.
function covered(entries, record) {
  return entries.some((e) => e.item === record.id
    && (isOpen(e) || (e.closed?.outcome === "withdrawn" && Number(e.version) === Number(record.version))));
}

// A criterion no test is asked of any more: one another criterion supersedes, which carries
// what it asked, or one made obsolete. `derive-tests` derives neither, so no test for it will
// ever run, and an item for it is an item nothing could close.
function retired(row) {
  return Boolean(row) && (Boolean(row.supersededBy) || row.state === "obsolete");
}

function retiredWhy(row) {
  return row.supersededBy
    ? `${row.id} is superseded by ${row.supersededBy}, which carries what it asked; no test is derived for it`
    : `${row.id} is obsolete; no test is derived for it`;
}

function pendingEntry(record, index) {
  return {
    kind: MISSING_TEST,
    item: record.id,
    id: record.id,
    version: record.version,
    domain: index.get(record.id)?.domain ?? null,
    stage: recordOwner(record),
    why: recordMissing(record),
    closed: null,
    pending: true,
  };
}

// The open items as a commit holds them — `main` unless told otherwise: every open entry on
// file, and an item for each record the entries do not account for. Reads git objects only.
export function openMissingTestsAt(projectDir, rev = "main") {
  return openFrom(readAt(projectDir, MISSING_TEST, rev), showAt(projectDir, rev, NOT_TESTABLE_PATH), showAt(projectDir, rev, "spec/criteria-index.json"));
}

// A criterion that is retired is owed nothing, whether or not the list has caught up with it yet.
function openFrom(stored, recordsText, indexText) {
  const index = indexIn(indexText);
  const pending = recordsIn(recordsText).filter((r) => !covered(stored, r) && !retired(index.get(r.id)));
  return [...stored.filter((e) => isOpen(e) && !retired(index.get(e.item))), ...pending.map((r) => pendingEntry(r, index))];
}

// Every result file a test run leaves: each target's `latest.json` and each slice's verify
// result, as project-relative paths.
function resultFiles(projectDir) {
  const root = join(projectDir, "tests", "results");
  if (!existsSync(root)) return [];
  const out = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(root, dir.name))) {
      if (f === "latest.json" || /^slice-\d+\.json$/.test(f)) out.push(`tests/results/${dir.name}/${f}`);
    }
  }
  return out.sort();
}

// The row that shows a criterion's test ran at its current version, as `{ source, row }`.
function ranIn(rows, id, version) {
  return (rows ?? []).find((r) => r?.id === id && r.file && RAN.has(r.result) && Number(r.version) === Number(version)) ?? null;
}

function evidenceFor(projectDir, id, version) {
  for (const rel of resultFiles(projectDir)) {
    let doc;
    try { doc = JSON.parse(readText(join(projectDir, rel))); } catch { continue; }
    const row = ranIn(doc?.rows, id, version);
    if (row) return `${rel}: ${id} v${version} ${row.result}`;
  }
  return null;
}

function specVersion(projectDir, domain, id) {
  if (!domain) return null;
  const p = join(projectDir, "tests", "acceptance", domain, `${id}.spec.ts`);
  if (!existsSync(p)) return null;
  const m = /^\/\/ criterion: @\S+ v(\d+)$/m.exec(readText(p).split("\n")[0] ?? "");
  return m ? Number(m[1]) : null;
}

const inDomain = (e, domain) => !domain || !e.domain || e.domain === domain;

// Whether a run of `stage` was handed an item: it was owed by the stage in the run's domain, on
// the commit the run's branch was cut from (`base`), which is what `main` held while the run ran
// (`handedNote`). Without a base, every item in the domain.
function handedAt(projectDir, stage, { base = null, domain = null } = {}) {
  const at = base
    ? new Set(openMissingTestsAt(projectDir, base).filter((e) => e.stage === stage && inDomain(e, domain)).map((e) => e.item))
    : null;
  return (e) => inDomain(e, domain) && (!at || at.has(e.item));
}

// Who runs a test that exists and has not run: the calibration, where the project calibrates
// against a target, and verify otherwise.
function runner(config) {
  const target = config?.oracle?.target;
  let calibrates = Boolean(target);
  try { if (calibrates && config?.profile) calibrates = stagesFor(config.profile).includes("calibrate"); } catch { calibrates = false; }
  return calibrates ? { stage: "calibrate", target } : { stage: "verify" };
}

// An item moved to another stage. What the stage it leaves had kept of it goes with the move:
// the stage it reaches has kept nothing yet. `stamp` is the ruling a move made at an approval
// carries.
function moved(entry, to, why, by, at, more = {}, stamp = {}) {
  const { kept: _kept, ...rest } = entry;
  return {
    ...rest,
    ...more,
    stage: to,
    readdressed: [...(entry.readdressed ?? []), { from: entry.stage, to, why, by, ...stamp, at }],
  };
}

// Brings `.sdlc/owed.yaml` into line with the working tree, which is `main` at every caller: a
// ruling's merge, a calibration's results, a withdrawal or a re-address. `before` is the commit
// `main` was at before the merge being recorded, so a record the merge brought in is stamped
// with the ruling (`from`, `gate`, `by`) and one that was already there is stamped by the
// runner; a record the merge removed is still accounted for. `stage` is the stage whose proposal
// the merge approved, `domain` the domain it ran on, and `base` the commit its branch was cut
// from: an item is the approval's to hand back only if that run was handed it (`handedAt`).
//
// It opens an item for every record nothing accounts for, moves an item whose record the merge
// rewrote with a different owner, closes an item whose test ran at the current version, and
// hands an item whose test exists and has not run to the stage that runs it. Returns the path
// written (`null` when nothing changed) and what it did, by criterion.
export function syncMissingTests(projectDir, { before = null, from = null, stage = null, domain = null, base = null, gate = null, by = null, config = null, at = new Date().toISOString() } = {}) {
  const now = recordsIn(workingText(projectDir, NOT_TESTABLE_PATH));
  const was = before ? recordsIn(showAt(projectDir, before, NOT_TESTABLE_PATH)) : now;
  const nowById = new Map(now.map((r) => [r.id, r]));
  const wasById = new Map(was.map((r) => [r.id, r]));
  const index = indexIn(workingText(projectDir, "spec/criteria-index.json"));
  const result = { path: null, opened: [], readdressed: [], closed: [], withdrawn: [] };
  const handed = stage === WRITER ? handedAt(projectDir, stage, { base, domain }) : null;

  const stored = read(projectDir, MISSING_TEST);
  const fresh = [];
  for (const r of [...now, ...was.filter((w) => !nowById.has(w.id))]) {
    if (covered([...stored, ...fresh], r) || retired(index.get(r.id))) continue;
    const brought = before && from && JSON.stringify(wasById.get(r.id)?.version) !== JSON.stringify(r.version);
    const stamp = brought ? { from, gate, by, at } : { by: "runner", at };
    fresh.push({ ...pendingEntry(r, index), ...stamp });
  }
  if (fresh.length) {
    const { path, added } = open(projectDir, MISSING_TEST, fresh.map(({ kind: _k, closed: _c, pending: _p, ...e }) => e));
    result.path = path;
    result.opened = added.map((e) => e.item);
  }

  const run = runner(config);
  const path = rewrite(projectDir, MISSING_TEST, (list) => list.map((e) => {
    if (!isOpen(e)) return e;
    const row = index.get(e.item);
    if (retired(row)) {
      result.withdrawn.push(e.item);
      return { ...e, closed: { outcome: "withdrawn", why: retiredWhy(row), by: "runner", at } };
    }
    const record = nowById.get(e.id);
    if (record) {
      const owner = text(record.owner);
      const changed = JSON.stringify(record) !== JSON.stringify(wasById.get(e.id));
      // The writer was handed this item and its approved derivation kept the record: the
      // record says who owes what is still missing, and that is never the writer. An item the
      // approved run was not handed — another domain's, or one handed on after its branch was
      // cut — is not the approval's to move.
      if (stage === WRITER && e.stage === WRITER && handed(e)) {
        result.readdressed.push({ id: e.id, from: e.stage, to: recordOwner(record) });
        return moved(e, recordOwner(record), recordMissing(record), by ?? "runner", at, { version: record.version });
      }
      if (!owner || owner === e.stage || !changed) return e;
      result.readdressed.push({ id: e.id, from: e.stage, to: owner });
      return moved(e, owner, recordMissing(record), by ?? "runner", at, { version: record.version });
    }
    const version = index.get(e.id)?.version ?? e.version;
    const evidence = evidenceFor(projectDir, e.id, version);
    if (evidence) {
      result.closed.push(e.id);
      return { ...e, closed: { outcome: "met", why: evidence, by: "runner", at } };
    }
    if (specVersion(projectDir, e.domain ?? index.get(e.id)?.domain, e.id) === Number(version) && e.stage !== run.stage) {
      result.readdressed.push({ id: e.id, from: e.stage, to: run.stage });
      return moved(e, run.stage, `a test for v${version} exists and has not run`, "runner", at, run.target ? { target: run.target } : {});
    }
    return e;
  }));
  result.path = path ?? result.path;
  return result;
}

// The open items as the working tree holds them, the way `openMissingTestsAt` reads a commit.
export function openMissingTests(projectDir) {
  return openInTree(projectDir);
}

function openInTree(projectDir) {
  return openFrom(read(projectDir, MISSING_TEST), workingText(projectDir, NOT_TESTABLE_PATH), workingText(projectDir, "spec/criteria-index.json"));
}

// Writes an entry, stamped by the runner, for every record on file that nothing accounts for,
// so a withdrawal or a move has an entry to stand on. Nothing else about the list changes.
function materialise(projectDir, at) {
  const pending = openInTree(projectDir).filter((e) => e.pending);
  if (!pending.length) return null;
  return open(projectDir, MISSING_TEST, pending.map(({ kind: _k, closed: _c, pending: _p, ...e }) => ({ ...e, by: "runner", at }))).path;
}

// Withdraws one item, as a ruler does: with a reason, and never an item nothing has open. An
// item read from its record alone is written first, so the withdrawal has an entry to stand on.
// Returns the path written, or `null` where nothing open names the criterion.
export function withdrawMissingTest(projectDir, id, { why, by, at = new Date().toISOString() } = {}) {
  if (!text(why)) throw new Error(`withdrawing ${missingTestRef(id)} needs a reason`);
  if (!openInTree(projectDir).some((e) => e.item === id)) return null;
  materialise(projectDir, at);
  let hit = false;
  const path = rewrite(projectDir, MISSING_TEST, (list) => list.map((e) => {
    if (!isOpen(e) || e.item !== id) return e;
    hit = true;
    return { ...e, closed: { outcome: "withdrawn", why: text(why), by, at } };
  }));
  return hit ? path ?? owedPath(MISSING_TEST) : null;
}

// Every re-address line in a stage's journal, as `{ id, to, why }`. A list marker or a
// blockquote in front of the line is allowed, since a journal is prose.
export function readdressLines(journal) {
  const re = new RegExp(`^[ \\t>*+-]*re-address[ \\t]+${REF_PREFIX.replace("/", "\\/")}(\\S+)[ \\t]+to[ \\t]+(\\S+)[ \\t]*:[ \\t]*(\\S.*)$`, "gim");
  return [...String(journal ?? "").matchAll(re)].map((m) => ({ id: m[1], to: m[2], why: text(m[3]) }));
}

// Applies a stage's re-address lines to the items it owes. A line naming an item this stage
// does not owe, a stage that does not exist, or the stage that already owes it moves nothing
// and is reported. `by` is what the move is attributed to: the proposal the run opened.
//
// A run on one domain was handed only that domain's items (`handedNote`), and a line naming
// another domain's item moves nothing either.
//
// A line to a stage in `hold` moves nothing here and is returned in `held`: a gated run holds
// its hand-ons to the test writer, because what the writer needs is the run's own work, which
// reaches `main` only when the proposal is approved (`settleApprovedMissingTests`).
export function readdressMissingTests(projectDir, stage, journal, { by, at = new Date().toISOString(), hold = [], domain = null } = {}) {
  const lines = readdressLines(journal);
  const result = { path: null, readdressed: [], refused: [], held: [] };
  if (!lines.length) return result;
  const moves = new Map();
  const seen = new Set();
  const owned = new Set(openInTree(projectDir).filter((e) => e.stage === stage && inDomain(e, domain)).map((e) => e.item));
  const owes = domain ? `${stage} in ${domain}` : stage;
  for (const l of lines) {
    const ref = missingTestRef(l.id);
    if (!STAGES.includes(l.to)) result.refused.push(`${ref}: ${l.to} is not a stage`);
    else if (!owned.has(l.id)) result.refused.push(`${ref}: ${l.id} is not an open item owed by ${owes}`);
    else if (l.to === stage) result.refused.push(`${ref}: already owed by ${stage}`);
    else if (!seen.has(l.id)) {
      seen.add(l.id);
      if (hold.includes(l.to)) result.held.push({ id: l.id, to: l.to });
      else moves.set(l.id, l);
    }
  }
  if (!moves.size) return result;
  materialise(projectDir, at);
  result.path = rewrite(projectDir, MISSING_TEST, (list) => list.map((e) => {
    const m = isOpen(e) && e.stage === stage && owned.has(e.item) ? moves.get(e.item) : null;
    if (!m) return e;
    result.readdressed.push({ id: e.item, from: stage, to: m.to });
    return moved(e, m.to, m.why, by ?? stage, at);
  }));
  return result;
}

// A run's own account as its proposal page carries it: everything above the ruling appended to
// the page, so a ruler quoting a line is never read as the run saying it.
function runAccount(page) {
  const text = String(page ?? "");
  const at = text.search(/^## Ruling[ \t]*$/m);
  return at === -1 ? text : text.slice(0, at);
}

// What an approval settles about the missing tests the approved run was handed.
//
// The run was handed the items its stage owed on `main` when it ran, in its domain where it has
// one (`handedNote`); `main` does not move while a stage runs, so `base` — the commit the
// proposal branch was cut from — holds exactly that list. Each re-address line on the proposal
// page that moves an item the stage still owes is applied, stamped with the ruling: the hand-ons
// to the test writer the run held back, and any other the run's finish did not apply. An item
// the run was handed and neither hand on is kept by the stage, stamped the same way (`kept`):
// the run looked at it and could not supply what it needs, and it stays owed by the stage
// without that stage being offered a run for it again (`src/runner/next.mjs`).
//
// Applying it twice changes nothing. Returns the path written (`null` when nothing changed),
// what moved, and what was kept.
export function settleApprovedMissingTests(projectDir, { stage, proposal, gate = null, by = null, page = "", base = null, domain = null, at = new Date().toISOString() } = {}) {
  const result = { path: null, readdressed: [], kept: [] };
  if (!stage || !proposal) return result;
  const handed = new Set(base
    ? openMissingTestsAt(projectDir, base).filter((e) => e.stage === stage && inDomain(e, domain)).map((e) => e.item)
    : []);
  const lines = new Map();
  for (const l of readdressLines(runAccount(page))) {
    if (STAGES.includes(l.to) && l.to !== stage && !lines.has(l.id)) lines.set(l.id, l);
  }
  // A line moves only what the run was handed: an item in its domain, owed when its branch was cut.
  const owed = openInTree(projectDir).filter((e) => e.stage === stage && inDomain(e, domain) && (!base || handed.has(e.item)));
  if (!owed.some((e) => lines.has(e.item) || (handed.has(e.item) && e.kept?.by !== proposal))) return result;
  const live = new Set(owed.map((e) => e.item));
  const opened = materialise(projectDir, at);
  const stamp = { ...(gate ? { gate } : {}), ...(by ? { approved_by: by } : {}) };
  const path = rewrite(projectDir, MISSING_TEST, (list) => list.map((e) => {
    if (!isOpen(e) || e.stage !== stage || !live.has(e.item)) return e;
    const l = lines.get(e.item);
    if (l) {
      result.readdressed.push({ id: e.item, from: stage, to: l.to });
      return moved(e, l.to, l.why, proposal, at, {}, stamp);
    }
    if (!handed.has(e.item) || e.kept?.by === proposal) return e;
    result.kept.push(e.item);
    return { ...e, kept: { by: proposal, ...stamp, at } };
  }));
  result.path = path ?? opened;
  return result;
}

// Reverses each move an approval's merge made to an item the approved run was not handed.
//
// The approval of a run acts on what that run was handed (`handedAt`). A merge that moved an item
// out of the approved stage in another domain, or one owed only after the run's branch was cut,
// moved what the ruling never saw. Such a move is found by comparing the list on the merge with
// the list before it, and is reversed where it still stands: the item is open, still where the
// move left it, the move is its last, and nothing has kept it since. The reversal is a move of its
// own back to the approved stage, stamped by the runner, naming the proposal whose approval it
// reverts (`reverts`), and carrying the reason the item had before, since that is what the stage
// it returns to needs. An item with no record on the merge is left alone: its test exists, and
// where it is owed follows from that alone. Returns the path written (`null` when nothing changed)
// and the items restored.
export function restoreUnhanded(projectDir, { merge, stage, proposal, domain = null, at = new Date().toISOString() } = {}) {
  const result = { path: null, restored: [] };
  if (!merge || !stage || !proposal) return result;
  const base = git(["merge-base", `${merge}^1`, `${merge}^2`], projectDir);
  const handed = handedAt(projectDir, stage, { base, domain });
  const recorded = new Set(recordsIn(showAt(projectDir, merge, NOT_TESTABLE_PATH)).map((r) => r.id));
  const prior = new Map(readAt(projectDir, MISSING_TEST, `${merge}^1`).filter(isOpen).map((e) => [e.item, e]));
  const wrong = new Map();
  for (const e of readAt(projectDir, MISSING_TEST, merge)) {
    if (!isOpen(e) || handed(e) || !recorded.has(e.item)) continue;
    const moves = e.readdressed ?? [];
    const i = moves.findLastIndex((m, k) => k >= (prior.get(e.item)?.readdressed?.length ?? 0) && m.from === stage);
    if (i !== -1) wrong.set(e.item, { move: moves[i], why: moves[i - 1]?.why ?? e.why });
  }
  if (!wrong.size) return result;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  result.path = rewrite(projectDir, MISSING_TEST, (list) => list.map((e) => {
    const w = isOpen(e) && !e.kept ? wrong.get(e.item) : null;
    if (!w || e.stage !== w.move.to || !same(e.readdressed?.at(-1), w.move)) return e;
    result.restored.push(e.item);
    return moved(e, stage, w.why, "runner", at, {}, { reverts: proposal });
  }));
  return result;
}

// The open items that stop a build slice being approved: every item open on `main` naming a
// criterion the slice claims, less the ones this ruling withdraws and the ones whose test the
// slice's own verify result shows ran at the current version (the approval closes those).
export function blockingMissingTests(projectDir, { claimed = [], withdrawn = [], rows = [], rev = "main" } = {}) {
  const ids = new Set(claimed);
  const gone = new Set(withdrawn);
  const index = indexIn(workingText(projectDir, "spec/criteria-index.json"));
  return openMissingTestsAt(projectDir, rev).filter((e) => ids.has(e.item) && !gone.has(e.item)
    && !ranIn(rows, e.item, index.get(e.item)?.version ?? e.version));
}

// What a stage run is handed: the open items it owes, read from `main`, and the line that moves
// one to another stage. A stage with a domain is handed the items in its domain. `null` where
// the stage owes nothing, so an ordinary run's prompt reads exactly as it would without this.
export function handedNote(projectDir, stage, { domain, gated = false } = {}) {
  const owed = openMissingTestsAt(projectDir, "main")
    .filter((e) => e.stage === stage && inDomain(e, domain));
  if (!owed.length) return null;
  const one = owed.length === 1;
  return [
    `## Missing ${one ? "test" : "tests"} this stage owes`,
    `${one ? "A criterion was" : `${owed.length} criteria were`} recorded as untestable, and what ${one ? "its test needs is" : "their tests need is"} owed by ${stage}. `
      + `${one ? "It stays" : "Each stays"} owed until a test for the criterion runs.`,
    owed.map((e) => `- ${missingTestRef(e.item)} — ${JSON.stringify(e.readdressed?.at(-1)?.why ?? e.why)}`).join("\n"),
    "To hand one to another stage — the one that writes its test once you have supplied what it needs, or the one whose it is — "
      + "write a line of its own in your journal:\n\n"
      + "re-address missing-test/<id> to <stage>: <why>\n\n"
      + (gated
        ? `It is recorded against this run's proposal: a move to ${WRITER} when the proposal is approved, since the test writer needs what you supplied on main, and any other move when the run finishes. `
        : "It is recorded when the run finishes. ")
      + `An item you write no such line for stays owed by ${stage}, recorded as one this run could not supply; say why in your journal.`,
  ].join("\n\n");
}

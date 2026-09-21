// `tests/acceptance/redo.yaml` — `{ redo: [{ id, version, why, verb? }] }`, the list of
// criteria whose tests have to be written again even though the criteria themselves have
// not moved. `derive-tests --stale` reads it, derives those criteria, and removes the
// entries it has just answered.
//
// Two rulings write to it, and each says something different about the test it is
// replacing. `calibrate` adds an entry when the product owner rules `test-wrong <ID>`: the
// criterion is right and the test asserts the wrong thing. A gate ruling adds one when the
// ruler writes `test-overreaches <ID>` (`src/commands/rule.mjs`): the criterion is right
// and the test reaches past it, demanding a capability the criterion never asked for. Both
// carry the ruler's own words, because "write this test again" with no account of what was
// wrong with it produces the same test. Every side goes through this module so the file's
// shape is written and read in one place.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";
import { loadIndex } from "../checks/tests.mjs";
import { OVERREACH_VERB, overreachConditions } from "./criteria.mjs";

export const REDO_PATH = "tests/acceptance/redo.yaml";

function redoFile(projectDir) {
  return join(projectDir, REDO_PATH);
}

// A file that does not parse reads as no entries rather than throwing: it is one stage's
// input, not its subject, and `checkTests` is what reports a malformed file under
// `tests/acceptance/` as the failure it is.
export function readRedo(projectDir) {
  const p = redoFile(projectDir);
  if (!existsSync(p)) return [];
  let parsed;
  try { parsed = parseYaml(readText(p)); } catch { return []; }
  return Array.isArray(parsed?.redo) ? parsed.redo : [];
}

// Appends the entries whose ids are not on the list already: the first reason recorded is
// the one somebody wrote about, and a later ruling naming the same id again does not
// overwrite it. Returns the project-relative path when the file was written, so a caller
// can report exactly what it changed, or `null` when there was nothing to add.
export function addRedo(projectDir, entries) {
  if (!entries.length) return null;
  const list = readRedo(projectDir);
  const seen = new Set(list.map((r) => r?.id));
  let added = false;
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    list.push(entry);
    seen.add(entry.id);
    added = true;
  }
  if (!added) return null;
  writeText(redoFile(projectDir), stringifyYaml({ redo: list }));
  return REDO_PATH;
}

// The entries a ruling's `test-overreaches` conditions ask for, built against the
// contract the project actually holds. The version is the one the criterion carries now,
// the same version `test-wrong` records, so the writer and the person reading the file
// afterwards both know which statement the test was judged to have reached past.
//
// `verb` is on these entries and not on a `test-wrong` one, and the difference is the
// point rather than an inconsistency: both ask for the same test to be written again, and
// they say different things about why. `test-wrong` says the test got the criterion wrong;
// this says the test asked for more than the criterion, which is an instruction about what
// the replacement must *not* do. `derive-tests` words the two differently, and an entry
// with no verb on it is the older, unmarked kind.
//
// An id the contract does not hold is not filed at all and comes back in `unfiled`: a
// request naming a criterion nothing can derive would sit on the list for ever, since only
// a run that derives that id ever takes it off again.
export function overreachRedoEntries(projectDir, conditions) {
  const index = loadIndex(projectDir);
  const byId = new Map(((index && !index.parseError ? index.criteria : null) ?? []).map((c) => [c.id, c]));
  const entries = [];
  const unfiled = [];
  for (const { id, text } of overreachConditions(conditions)) {
    const c = byId.get(id);
    if (!c) { unfiled.push(id); continue; }
    entries.push({ id, version: c.version, why: text, verb: OVERREACH_VERB });
  }
  return { entries, unfiled };
}

// Drops every entry naming one of `ids`. The file is left in place holding whatever is
// still outstanding — an empty list included, since another domain's `derive-tests` run
// clearing the last entry is not a reason for the file itself to disappear.
export function removeRedo(projectDir, ids) {
  const wanted = new Set(ids);
  if (!wanted.size || !existsSync(redoFile(projectDir))) return null;
  const list = readRedo(projectDir);
  const kept = list.filter((r) => !wanted.has(r?.id));
  if (kept.length === list.length) return null;
  writeText(redoFile(projectDir), stringifyYaml({ redo: kept }));
  return REDO_PATH;
}

// The `test-wrong` ruling records naming any of `ids`, dropped from every target's
// `tests/results/<target>/applied.yaml`. A `test-wrong` ruling says the criterion is
// right and its test is not; the record of it is what marks that criterion's row as
// already ruled on, so once `derive-tests` has written the test again the record has
// outlived its answer — left in place, the freshly written test's next failure would
// come back marked `ruled` and the product owner would never be asked about it.
//
// Only the per-id record in `rulings` is removed. The gate file stays named in
// `applied`, which is what stops a ruling that has already been acted on from being
// applied to the spec a second time.
export function dropTestWrongRulings(projectDir, ids) {
  const wanted = new Set(ids);
  const resultsDir = join(projectDir, "tests", "results");
  if (!wanted.size || !existsSync(resultsDir)) return [];
  const changed = [];
  for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = `tests/results/${entry.name}/applied.yaml`;
    const abs = join(projectDir, rel);
    if (!existsSync(abs)) continue;
    let doc;
    try { doc = parseYaml(readText(abs)) ?? {}; } catch { continue; }
    const rulings = Array.isArray(doc.rulings) ? doc.rulings : [];
    // The reviewer's `product-question` sorting of the same criterion goes too: it was a
    // verdict about the test that has just been replaced, and a test written again can fail
    // for a reason the adapter owns, so it is sorted afresh rather than sent straight on.
    const kept = rulings.filter((r) => !((r?.verb === "test-wrong" || r?.verb === "product-question") && wanted.has(r?.id)));
    if (kept.length === rulings.length) continue;
    writeText(abs, stringifyYaml({ ...doc, rulings: kept }));
    changed.push(rel);
  }
  return changed;
}

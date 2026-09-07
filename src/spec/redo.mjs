// `tests/acceptance/redo.yaml` — `{ redo: [{ id, version, why }] }`, the one list two
// stages share: `calibrate` adds an entry when the product owner rules `test-wrong <ID>`
// (the criterion is right and the test is not), and `derive-tests` reads it to know which
// criteria need their tests written again even though the criteria themselves have not
// moved, then removes the entries it has just acted on. Both sides go through this module
// so the file's shape is written and read in one place.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";

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
    const kept = rulings.filter((r) => !(r?.verb === "test-wrong" && wanted.has(r?.id)));
    if (kept.length === rulings.length) continue;
    writeText(abs, stringifyYaml({ ...doc, rulings: kept }));
    changed.push(rel);
  }
  return changed;
}

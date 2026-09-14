// `tests/adapters/rebind.yaml` — `{ rebind: [{ id, target, why }] }`, the list of bindings a
// calibration found wanting. `calibrate` writes it from the reviewer's `adapter-wrong`
// verdicts when it sorts a calibration's failures, and `bind-adapter` reads the entries for
// its own target into its prompt.
//
// The sorting exists so that the product owner is only ever asked about the product. A
// failing test can be the application's fault, the criterion's, the test's — or the harness
// that drives the page. The last is a technical question with a right answer in the
// adapter's code, and it belongs to the persona that already rules on adapters
// (`docs/decisions/0008-adapter-wrong.md`).
//
// Entries are cleared by `calibrate`, not by `bind-adapter`: a returned binding has fixed
// nothing and a revise of it still needs them, so they lapse only once a calibration has run
// against an adapter that changed after they were written.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";

export const REBIND_PATH = "tests/adapters/rebind.yaml";

function rebindFile(projectDir) {
  return join(projectDir, REBIND_PATH);
}

// A file that does not parse reads as no entries, the same forgiving read `readRedo` gives
// its own: it is one stage's input rather than its subject.
export function readRebind(projectDir) {
  const p = rebindFile(projectDir);
  if (!existsSync(p)) return [];
  let parsed;
  try { parsed = parseYaml(readText(p)); } catch { return []; }
  return Array.isArray(parsed?.rebind) ? parsed.rebind : [];
}

// Entries for one target, which is what a `bind-adapter` run binding that target needs and
// all it needs: a finding about the new target's adapter says nothing about the old one's.
export function readRebindFor(projectDir, target) {
  return readRebind(projectDir).filter((e) => e?.target === target);
}

// Appends what is not already listed. A criterion may be named more than once across
// targets, so the pair of id and target is what makes an entry the same entry — and the
// first reason recorded for a pair is the one kept, since it is the one somebody wrote.
export function addRebind(projectDir, entries) {
  if (!entries.length) return null;
  const list = readRebind(projectDir);
  const seen = new Set(list.map((e) => `${e?.target} ${e?.id}`));
  let added = false;
  for (const entry of entries) {
    const key = `${entry.target} ${entry.id}`;
    if (seen.has(key)) continue;
    list.push(entry);
    seen.add(key);
    added = true;
  }
  if (!added) return null;
  writeText(rebindFile(projectDir), stringifyYaml({ rebind: list }));
  return REBIND_PATH;
}

// Drops every entry for one target naming one of `ids` — what a `bind-adapter` run does
// once it has acted on them. The file stays in place holding whatever other targets are
// still owed, an empty list included.
export function removeRebind(projectDir, target, ids) {
  const wanted = new Set(ids);
  if (!wanted.size || !existsSync(rebindFile(projectDir))) return null;
  const list = readRebind(projectDir);
  const kept = list.filter((e) => !(e?.target === target && wanted.has(e?.id)));
  if (kept.length === list.length) return null;
  writeText(rebindFile(projectDir), stringifyYaml({ rebind: kept }));
  return REBIND_PATH;
}

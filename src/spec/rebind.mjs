// `tests/adapters/rebind.yaml` — `{ rebind: [{ id, target, why }] }`, the list `calibrate`
// writes when the product owner rules `adapter-wrong <ID>`, and `bind-adapter` reads to
// know which bindings a calibration found wanting.
//
// It exists because the three verbs the calibration grammar started with could not say
// what the first full calibration of a real project mostly found. A failing row is meant
// to be one of three things — the old application really fails this, the criterion
// misdescribes it, or the test is wrong — and a fourth was in front of the product owner
// forty times over: the adapter reads the browser tab's title where the criterion means
// the page's heading, reports a control missing that the application plainly renders,
// returns an empty identifier instead of saying it could not find one. None of those is
// the product, the criterion or the test.
//
// Ruling one of them with a verb that fits badly is worse than having no verb at all:
// `defect-in-old` would make an adapter's bug an obligation on the rebuild, and
// `test-wrong` would send a sound test back for a blind rewrite that hits the very same
// binding again.
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

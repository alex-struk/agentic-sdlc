// `spec/recovery.yaml` — `{ recovery: [{ id, domain, version, why, fingerprint }] }`, the
// list of criteria a ratification ruling sent back to be recovered again. `ratify` adds an
// entry when the product owner rules `recovery-wrong <ID>` (the row does not record what
// the old application does, so there is no statement to edit), and the next `archaeology`
// run for that domain reads the entries into its prompt and is judged against them. Both
// sides go through this module so the file's shape is written and read in one place.
//
// It sits beside `tests/acceptance/redo.yaml` (`src/spec/redo.mjs`) and
// `tests/adapters/rebind.yaml` (`src/spec/rebind.mjs`) in kind: a ruling that has to be
// carried out by a stage other than the one that received it, handed over as a file rather
// than as a condition the receiving stage cannot execute. It lives under `spec/` because
// the stage that acts on it may write nowhere else.
//
// Nothing ever removes an entry. An entry is *outstanding* — still owed work — only while
// the criterion it names is still exactly the criterion that was sent back, measured by
// `criterionFingerprint`. Once archaeology has recovered the row again, the fingerprint no
// longer matches and the entry is answered by that fact alone, with no bookkeeping pass to
// forget and no window in which a replayed ruling could file the same request twice.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";
import { criterionFingerprint } from "./criteria.mjs";

export const RECOVERY_PATH = "spec/recovery.yaml";

function recoveryFile(projectDir) {
  return join(projectDir, RECOVERY_PATH);
}

// A file that does not parse reads as no entries rather than throwing, the same forgiving
// read `readRedo` and `readRebind` give their own: it is one stage's input, not its
// subject.
export function readRecovery(projectDir) {
  const p = recoveryFile(projectDir);
  if (!existsSync(p)) return [];
  let parsed;
  try { parsed = parseYaml(readText(p)); } catch { return []; }
  return Array.isArray(parsed?.recovery) ? parsed.recovery : [];
}

// Entries for one domain, which is what an `archaeology` run recovering that domain needs
// and all it needs: a request about another domain's criterion is another run's work.
export function readRecoveryFor(projectDir, domain) {
  return readRecovery(projectDir).filter((e) => e?.domain === domain);
}

// Appends what is not already listed. The same criterion can legitimately be sent back
// more than once — a re-recovery that answered the wrong question gets a second, differently
// worded request — so an entry is the same entry only when both its id and its reason match,
// and a repeat of one line files nothing. Returns the project-relative path when the file was
// written, so a caller can report exactly what it changed, or `null` when there was nothing
// to add.
export function addRecovery(projectDir, entries) {
  if (!entries.length) return null;
  const list = readRecovery(projectDir);
  const seen = new Set(list.map((e) => `${e?.id}\n${e?.why}`));
  let added = false;
  for (const entry of entries) {
    const key = `${entry.id}\n${entry.why}`;
    if (seen.has(key)) continue;
    list.push(entry);
    seen.add(key);
    added = true;
  }
  if (!added) return null;
  writeText(recoveryFile(projectDir), stringifyYaml({ recovery: list }));
  return RECOVERY_PATH;
}

// The entries still owed work, given the criteria as they stand now: the criterion is still
// in the domain file and is still, field for field, the one that was sent back. A criterion
// recovered again answers its entry by being different; one the recovery removed entirely
// answers it by being gone. At most one entry per id is returned — the most recently filed
// one — since a criterion sent back twice is one criterion out for re-recovery, and the
// latest reason is the one that describes what is wrong with it now.
export function outstandingRecoveries(entries, criteria) {
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const latest = new Map();
  for (const entry of entries) {
    const c = byId.get(entry?.id);
    if (!c || criterionFingerprint(c) !== entry.fingerprint) continue;
    latest.set(entry.id, entry);
  }
  return [...latest.values()];
}

// How many times a criterion has been sent back, counting every request ever filed for it
// rather than only the outstanding one. A second request on the same row is what says a
// re-recovery did not answer the first, so it is worth reporting even though only the
// latest one is owed.
export function recoveryRequestCount(entries, id) {
  return entries.filter((e) => e?.id === id).length;
}

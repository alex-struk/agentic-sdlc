// `spec/recovery.yaml` — `{ recovery: [{ id, domain, version, why, answered? }] }`, the
// ledger of criteria a ratification ruling sent back to be recovered again. `ratify` adds
// an entry when the product owner rules `recovery-wrong <ID>` (the row does not record
// what the old application does, so there is no statement to edit), and the next
// `archaeology` run for that domain reads the entries into its prompt, is judged against
// them, and — once every one of its checks has passed — records on each one that it
// answered it. Both sides go through this module so the file's shape is written and read
// in one place.
//
// It sits beside `tests/acceptance/redo.yaml` (`src/spec/redo.mjs`) and
// `tests/adapters/rebind.yaml` (`src/spec/rebind.mjs`) in kind: a ruling that has to be
// carried out by a stage other than the one that received it, handed over as a file rather
// than as a condition the receiving stage cannot execute. Like those two it is the
// pipeline's own bookkeeping and never an agent's to write — `archaeology` refuses a run
// that touched it, and the entry an `archaeology` run answers is stamped by the runner
// after the checks have judged the tree.
//
// Nothing is ever removed. A request is outstanding — still owed work — until an
// archaeology run has answered it, and the stamp saying so is the only thing that ends
// that. "The row is different from when it was sent back" is a weaker fact that is easy to
// mistake for this one and comes apart from it: an ordinary `spike` or `edit` changes the
// row without anybody having gone back to the old application, and a request retired that
// way would take a criterion known to be wrongly recovered out of the queue with its
// correction never made and nothing reporting it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";

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
  return entriesIn(readText(p));
}

// The ledger as one text holds it — the working tree's, or `HEAD`'s, read with `git show`
// by a caller that needs to know what the run it is judging actually started from.
export function entriesIn(text) {
  let parsed;
  try { parsed = parseYaml(text); } catch { return []; }
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
  const seen = new Set(list.map(keyOf));
  let added = false;
  for (const entry of entries) {
    if (seen.has(keyOf(entry))) continue;
    list.push(entry);
    seen.add(keyOf(entry));
    added = true;
  }
  if (!added) return null;
  writeText(recoveryFile(projectDir), stringifyYaml({ recovery: list }));
  return RECOVERY_PATH;
}

// An entry's identity: the criterion it names and the reason it was sent back for. Two
// reasons filed against one criterion are two requests, and each one is owed its own
// answer.
export function keyOf(entry) {
  return `${entry?.id}\n${entry?.why}`;
}

// True when this request has been answered — an archaeology run carried it out and stamped
// it. Nothing else sets this, and no amount of change to the criterion itself does.
export function isAnswered(entry) {
  return entry?.answered !== undefined && entry?.answered !== null;
}

// The requests still owed work, given the criteria as they stand: unanswered, and naming a
// criterion that is still in the domain file. A criterion a recovery removed altogether is
// not owed a re-recovery — there is no row to recover and nothing to ask the stage for —
// which is the one way besides the stamp that a request stops being outstanding, and it is
// a fact about the domain file rather than about any one field in it.
export function outstandingRecoveries(entries, criteria) {
  const ids = new Set(criteria.map((c) => c.id));
  return entries.filter((e) => !isAnswered(e) && ids.has(e?.id));
}

// Records, on every request `ids` names, that an archaeology run answered it: the version
// the criterion came back at, or that the recovery removed the row. Called by the
// `archaeology` stage itself once every one of its checks has passed — the runner writes
// this, never the agent, and only for a run that has already been judged to have recovered
// the rows it was asked about. Returns the project-relative path when the file was written.
export function answerRecoveries(projectDir, ids, criteriaById) {
  const wanted = new Set(ids);
  if (!wanted.size || !existsSync(recoveryFile(projectDir))) return null;
  const list = readRecovery(projectDir);
  let stamped = false;
  for (const entry of list) {
    if (isAnswered(entry) || !wanted.has(entry?.id)) continue;
    const c = criteriaById.get(entry.id);
    entry.answered = c ? { version: c.version } : { removed: true };
    stamped = true;
  }
  if (!stamped) return null;
  writeText(recoveryFile(projectDir), stringifyYaml({ recovery: list }));
  return RECOVERY_PATH;
}

// How many times a criterion has been sent back, counting every request ever filed for it
// rather than only the outstanding ones. A second request on the same row is what says a
// re-recovery did not answer the first, so it is worth reporting even after it is answered.
export function recoveryRequestCount(entries, id) {
  return entries.filter((e) => e?.id === id).length;
}

// `.sdlc/conditions.yaml` — `{ conditions: [{ ref, text, from, gate, stage, by, at, closed? }] }`,
// every plain condition a return attached to a proposal and whether a ruler has since
// accounted for it.
//
// A ruling's conditions are instructions, and the three kinds were tracked to different
// depths. An `addressed-to` line becomes a revision request and is followed from filing to
// consumption (`src/spec/revisions.mjs`); a `test-overreaches` line becomes a redo entry and
// is removed when the test is written again (`src/spec/redo.mjs`). A plain condition on a
// returned proposal had nothing: the stage revises, the revision is ruled on its own merits,
// and whether the condition was ever met is a question nobody is asked. A gate file can
// therefore assert a change the project's own files contradict, and the record looks
// complete, which is worse than the mistake it records.
//
// This is `revisions.mjs`'s shape, deliberately, because it is the same shape of problem:
// an append-only ledger a ruling writes to, marked rather than emptied when it is answered.
// It is a second file rather than a second kind of row in that one because the two are read
// by different things — a `--revise` run reads revision requests as work to start from, and
// must never be handed one of these, which is not work at all but a question about work
// already asked for.
//
// Whether a condition was met is a ruling and is never computed here. What is computed is
// whether anybody has said so.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";
import { git } from "../lib/git.mjs";

export const CONDITIONS_PATH = ".sdlc/conditions.yaml";

function conditionsFile(projectDir) {
  return join(projectDir, CONDITIONS_PATH);
}

// How a ruler names one condition to a later ruling: the proposal it was written on and its
// position in that ruling's own list, one-based, the way the list is printed everywhere. A
// reference rather than the condition's text, because a condition is a sentence and asking a
// turn to quote a sentence back byte for byte is asking it to fail.
export function conditionRef(proposal, index) {
  return `${proposal}#${index + 1}`;
}

// A file that does not parse reads as no conditions rather than throwing: it is one check's
// input, not its subject, and a check refusing to run because a bookkeeping file is
// malformed is a check stopped by something nobody can see from where they are standing.
export function readConditions(projectDir) {
  const p = conditionsFile(projectDir);
  if (!existsSync(p)) return [];
  let parsed;
  try { parsed = parseYaml(readText(p)); } catch { return []; }
  return Array.isArray(parsed?.conditions) ? parsed.conditions : [];
}

function writeConditions(projectDir, list) {
  writeText(conditionsFile(projectDir), stringifyYaml({ conditions: list }));
  return CONDITIONS_PATH;
}

// Appends the entries whose references are not on file already, returning the
// project-relative path when it wrote and `null` when there was nothing to add, so a caller
// can report exactly what it changed rather than claiming a row it did not make. A ruling
// read a second time asks for nothing new.
export function addConditions(projectDir, entries) {
  if (!entries.length) return null;
  const list = readConditions(projectDir);
  const known = new Set(list.map((c) => c?.ref));
  const added = entries.filter((e) => !known.has(e.ref));
  if (!added.length) return null;
  return writeConditions(projectDir, [...list, ...added]);
}

// The ledger as one file's text, for a caller holding a copy it did not read off disk —
// `sdlc rule` reads `main`'s through `git show` while the proposal's own branch is checked
// out, since a branch cut before a condition was filed does not carry it and a guard that
// read the checkout would refuse a reference that is perfectly good.
export function conditionsIn(text) {
  let parsed;
  try { parsed = parseYaml(text ?? ""); } catch { return []; }
  return Array.isArray(parsed?.conditions) ? parsed.conditions : [];
}

export function stillOpen(list) {
  return (list ?? []).filter((c) => c && !c.closed);
}

// The conditions nothing has accounted for yet, oldest first.
export function openConditions(projectDir) {
  return stillOpen(readConditions(projectDir));
}

// Marks one open condition as accounted for. The entry keeps everything it was filed with —
// what was asked, on which proposal, at which gate and by which seat — so the reason an
// instruction was closed survives being closed, and a row that was met reads differently
// from one that was withdrawn long after anybody remembers either.
//
// `null` where the reference names nothing open: a ruling that closes a condition which does
// not exist, or one somebody has already answered, is a ruling about nothing and the caller
// refuses it rather than recording it.
export function closeCondition(projectDir, ref, { outcome, why, by, at = new Date().toISOString() }) {
  const list = readConditions(projectDir);
  const i = list.findIndex((c) => c?.ref === ref && !c?.closed);
  if (i === -1) return null;
  list[i] = { ...list[i], closed: { outcome, why, by, at } };
  return writeConditions(projectDir, list);
}

// `main`'s ledger, read with `git show` rather than off the checkout. A ruling has the
// proposal's own branch checked out, and a branch cut before a condition was filed does not
// carry it: a guard reading the checkout would refuse a reference that is perfectly good,
// and a prompt reading the checkout would show the ruler a different list from the one its
// ruling is judged against. Both read this.
//
// An empty list where `main` has no ledger yet, or one that does not parse: this is one
// caller's input rather than its subject, the same leniency `readConditions` has.
export function openConditionsOnMain(projectDir) {
  try { return stillOpen(conditionsIn(git(["show", `main:${CONDITIONS_PATH}`], projectDir))); }
  catch { return []; }
}

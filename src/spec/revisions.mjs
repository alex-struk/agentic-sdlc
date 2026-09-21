// `.sdlc/revision-requests.yaml` —
// `{ requests: [{ stage, why, from, gate, by, at, taken?, deferred? }] }`, the standing asks
// for a stage to produce its artifact again. A ruling at one gate writes one when its
// conditions carry `addressed-to <stage>: <why>` (`src/commands/rule.mjs`); that stage's own
// `--revise` run is handed every open request addressed to it, each `why` verbatim, and
// opens one fresh proposal at the gate that stage holds.
//
// The file is the pipeline's own bookkeeping and no agent touches it. Every side goes
// through this module so its shape is written and read in one place.
//
// An entry is never removed. A request that has been taken up gains `taken`, and what it
// said stays on file: it is the only record of why an artifact its own gate had already
// approved was opened again, and a record that is deleted the moment it is acted on
// cannot answer that question afterwards. A request a run could not answer gains `deferred`
// and keeps no `taken`, so it is still open and still asked for.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";

export const REVISION_REQUESTS_PATH = ".sdlc/revision-requests.yaml";

function requestsFile(projectDir) {
  return join(projectDir, REVISION_REQUESTS_PATH);
}

// A file that does not parse reads as no requests rather than throwing: it is one stage's
// input, not its subject, and a stage refusing to run because a bookkeeping file is
// malformed is a stage stopped by something nobody can see from where they are standing.
export function readRevisionRequests(projectDir) {
  const p = requestsFile(projectDir);
  if (!existsSync(p)) return [];
  let parsed;
  try { parsed = parseYaml(readText(p)); } catch { return []; }
  return Array.isArray(parsed?.requests) ? parsed.requests : [];
}

function writeRequests(projectDir, list) {
  writeText(requestsFile(projectDir), stringifyYaml({ requests: list }));
  return REVISION_REQUESTS_PATH;
}

// The same request is not filed twice — one ruling read again asks for nothing new — where
// "the same" is the stage asked, the proposal that asked and the words it asked in.
function sameRequest(a, b) {
  return a?.stage === b?.stage && a?.from === b?.from && a?.why === b?.why;
}

// Appends the requests not already on file, returning the project-relative path when it
// wrote and `null` when there was nothing to add, so a caller can report exactly what it
// changed rather than claiming a request it did not make.
export function addRevisionRequests(projectDir, entries) {
  if (!entries.length) return null;
  const list = readRevisionRequests(projectDir);
  const added = entries.filter((e) => !list.some((r) => sameRequest(r, e)));
  if (!added.length) return null;
  return writeRequests(projectDir, [...list, ...added]);
}

// The requests addressed to one stage that nothing has taken up yet, in filing order: the
// file is the queue, appended as rulings file them, so the oldest ask is first.
export function openRevisionRequestsFor(projectDir, stage) {
  return readRevisionRequests(projectDir).filter((r) => r?.stage === stage && !r?.taken);
}

// The same requests as the round a `--revise` run answers: all of them, oldest first, with
// the ones a single ruling filed kept together.
//
// Grouping is what a ruler means by routing two conditions to one stage. They are halves of
// one observation — the work downstream showed something about this artifact, and both
// halves describe it — so an artifact that answers one of them alone can be consistent with
// neither. Between groups the order is the order they were filed in, because a request
// older than another was asked about an artifact that has since been approved again, and
// reading it first is what puts the two in the sequence they happened.
export function revisionRound(projectDir, stage) {
  const groups = new Map();
  for (const r of openRevisionRequestsFor(projectDir, stage)) {
    const key = `${r?.from ?? ""}\u0000${r?.gate ?? ""}\u0000${r?.by ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()].flat();
}

// A whole round settled in one write: every request the run answered marked `taken` at the
// same instant, every one it could not answer marked `deferred` and left open.
//
// All of it moves or none of it does. A round marked one entry at a time can be interrupted
// half way and leave a file saying one ask was answered and its other half was never asked —
// which is the state a stage handed one request out of two produces, written down. So the
// list is matched whole before anything is written, and a request that no longer matches an
// open entry (a round settled twice, a file edited underneath) writes nothing at all and
// says so by returning `null`.
//
// A deferred entry keeps its place on the list with no `taken`, so it is open, it is still
// read as a round the next time the stage is asked, and `sdlc checks` goes on reporting it.
// What it gains is the account of why the run that had it could not answer it.
export function settleRevisionRound(projectDir, { taken = [], deferred = [] } = {}, when = new Date().toISOString()) {
  if (!taken.length && !deferred.length) return null;
  const list = readRevisionRequests(projectDir);
  const used = new Set();
  const index = (request) => {
    const i = list.findIndex((e, n) => !used.has(n) && !e?.taken && sameRequest(e, request));
    if (i !== -1) used.add(i);
    return i;
  };
  const takenAt = taken.map(index);
  const deferredAt = deferred.map((d) => index(d?.request));
  if ([...takenAt, ...deferredAt].some((i) => i === -1)) return null;
  takenAt.forEach((i) => { list[i] = { ...list[i], taken: when }; });
  deferredAt.forEach((i, n) => {
    list[i] = { ...list[i], deferred: { at: when, why: deferred[n]?.why ?? "", proposal: deferred[n]?.proposal ?? "" } };
  });
  return writeRequests(projectDir, list);
}

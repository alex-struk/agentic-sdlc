// `.sdlc/revision-requests.yaml` — `{ requests: [{ stage, why, from, gate, by, at, taken? }] }`,
// the standing asks for a stage to produce its artifact again. A ruling at one gate writes
// one when its conditions carry `addressed-to <stage>: <why>` (`src/commands/rule.mjs`);
// that stage's own `--revise` run reads it, is handed `why` verbatim, and opens a fresh
// proposal at the gate that stage holds.
//
// The file is the pipeline's own bookkeeping and no agent touches it. Every side goes
// through this module so its shape is written and read in one place.
//
// An entry is never removed. A request that has been taken up gains `taken`, and what it
// said stays on file: it is the only record of why an artifact its own gate had already
// approved was opened again, and a record that is deleted the moment it is acted on
// cannot answer that question afterwards.
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

// The requests addressed to one stage that nothing has taken up yet, oldest first: a stage
// asked twice answers the older ask first, the way a queue does.
export function openRevisionRequestsFor(projectDir, stage) {
  return readRevisionRequests(projectDir).filter((r) => r?.stage === stage && !r?.taken);
}

// Marks one request as taken up, at `when`. The entry keeps everything it was filed with —
// who asked, from which proposal, at which gate and in what words — so the reason an
// approved artifact was opened again survives being acted on.
export function takeRevisionRequest(projectDir, request, when = new Date().toISOString()) {
  const list = readRevisionRequests(projectDir);
  const i = list.findIndex((r) => !r?.taken && sameRequest(r, request));
  if (i === -1) return null;
  list[i] = { ...list[i], taken: when };
  return writeRequests(projectDir, list);
}

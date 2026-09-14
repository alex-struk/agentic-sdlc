// The checks behind gate G2. A plan is answerable for two things a person cannot hold in
// their head across a hundred criteria: that the constitution was actually considered
// before the work was cut up, and that every criterion the spec accepted lands in exactly
// one slice of that work.
//
// The second is the one worth having. A criterion nobody planned for is the commonest way
// a rebuild quietly loses behaviour: it was written down, it was ratified, it has a test,
// and no slice was ever going to build it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fsx.mjs";

const PLAN_PATH = join("plan", "plan.md");
const TASKS_PATH = join("plan", "tasks.md");

// A slice heading and the line naming what it is answerable for, in the same shape the
// criteria themselves are written in (`docs/spec-format.md`) — a heading, then fields as
// list items under it — so a plan reads like the rest of the spec rather than like a
// second format somebody has to learn.
const SLICE_HEADING = /^###\s+Slice\s+(\d+)\s*·\s*(.+?)\s*$/;
const CRITERIA_FIELD = /^-\s*criteria:\s*(.*)$/;
const CRITERION_ID = /\b(?:R-\d+\.\d+|D-[a-z0-9-]+-\d+)\b/g;

export function parseTasks(text) {
  const slices = [];
  const errors = [];
  let current = null;
  const lines = String(text ?? "").split("\n");
  lines.forEach((line, i) => {
    const heading = SLICE_HEADING.exec(line);
    if (heading) {
      if (current && !current.criteria.length) errors.push(`${TASKS_PATH}: slice ${current.number} names no criteria`);
      current = { number: Number(heading[1]), title: heading[2], criteria: [], line: i + 1 };
      slices.push(current);
      return;
    }
    const field = CRITERIA_FIELD.exec(line);
    if (field && current) current.criteria.push(...(field[1].match(CRITERION_ID) ?? []));
  });
  if (current && !current.criteria.length) errors.push(`${TASKS_PATH}: slice ${current.number} names no criteria`);
  return { slices, errors };
}

// The constitution check is a section of the plan, not a separate artefact: whoever writes
// the plan has to say, in the plan, which of the constitution's rules bear on this work and
// how the plan meets them. A heading with nothing under it is the failure this catches —
// the section added to satisfy the check rather than to answer it.
export function checkPlanConstitution(projectDir) {
  const id = "plan-constitution-check";
  const path = join(projectDir, PLAN_PATH);
  if (!existsSync(path)) return { id, ok: false, messages: [`${PLAN_PATH} is missing`] };
  const lines = readText(path).split("\n");
  const start = lines.findIndex((l) => /^##\s+Constitution check\s*$/i.test(l));
  if (start === -1) return { id, ok: false, messages: [`${PLAN_PATH}: no "## Constitution check" section`] };
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  if (!body.join("").trim())
    return { id, ok: false, messages: [`${PLAN_PATH}: the "Constitution check" section is empty`] };
  return { id, ok: true, messages: [] };
}

// Every accepted criterion in exactly one slice, and every criterion a slice names actually
// accepted. Both halves matter: the first is behaviour nobody planned to build, the second
// is a slice answerable for something the spec does not say.
export function checkPlanCoverage(projectDir, acceptedIds) {
  const id = "plan-criteria-assigned";
  const path = join(projectDir, TASKS_PATH);
  if (!existsSync(path)) return { id, ok: false, messages: [`${TASKS_PATH} is missing`] };
  const { slices, errors } = parseTasks(readText(path));
  const messages = [...errors];
  if (!slices.length) messages.push(`${TASKS_PATH}: no slices; each one is a "### Slice <n> · <title>" heading`);

  const seen = new Map();
  for (const slice of slices) {
    for (const cid of slice.criteria) {
      if (seen.has(cid)) messages.push(`${TASKS_PATH}: ${cid} is in slice ${seen.get(cid)} and slice ${slice.number}; a criterion belongs to one slice`);
      else seen.set(cid, slice.number);
    }
  }

  const accepted = new Set(acceptedIds);
  for (const cid of seen.keys()) {
    if (accepted.size && !accepted.has(cid)) messages.push(`${TASKS_PATH}: ${cid} is not an accepted criterion`);
  }
  for (const cid of accepted) {
    if (!seen.has(cid)) messages.push(`${TASKS_PATH}: ${cid} is accepted and no slice builds it`);
  }
  return { id, ok: messages.length === 0, messages };
}

// A slice is vertical when it can be built, tested and shown on its own. Nothing here can
// judge that — it is exactly what the architect persona rules on at G2 — but a slice
// answerable for a single criterion, or for most of the spec at once, is worth putting in
// front of that persona rather than leaving for it to notice.
export function planShape(projectDir) {
  const path = join(projectDir, TASKS_PATH);
  if (!existsSync(path)) return { slices: [], warnings: [] };
  const { slices } = parseTasks(readText(path));
  const total = slices.reduce((n, s) => n + s.criteria.length, 0);
  const warnings = [];
  for (const s of slices) {
    if (total && s.criteria.length > Math.max(12, total / 3))
      warnings.push(`${TASKS_PATH}: slice ${s.number} carries ${s.criteria.length} of ${total} criteria; a slice that large is a phase, not a slice`);
  }
  return { slices, warnings };
}

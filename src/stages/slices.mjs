// One slice of `plan/tasks.md`, and the names the build and verify stages give its work.
// The plan's format is `parseTasks`'s (`src/checks/plan.mjs`); this only cuts one slice's
// own text out of it, so a build agent is handed the slice it is building and not the
// other forty.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fsx.mjs";
import { git, gitOk } from "../lib/git.mjs";
import { parseTasks } from "../checks/plan.mjs";

const TASKS_PATH = join("plan", "tasks.md");

export function readSlice(projectDir, number) {
  const path = join(projectDir, TASKS_PATH);
  if (!existsSync(path)) return null;
  const text = readText(path);
  const slice = parseTasks(text).slices.find((s) => s.number === Number(number));
  if (!slice) return null;
  const lines = text.split("\n");
  const start = slice.line - 1;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (/^###\s+Slice\s+\d+/.test(lines[i])) { end = i; break; }
  return { number: slice.number, title: slice.title, criteria: slice.criteria, body: lines.slice(start, end).join("\n").trim() };
}

export function buildProposalBase(number) {
  return `build-slice-${Number(number)}`;
}

export function buildProposals(projectDir, number) {
  const base = buildProposalBase(number);
  const out = gitOk(["for-each-ref", "--format=%(refname:short)", `refs/heads/proposal/${base}*`], projectDir)
    ? git(["for-each-ref", "--format=%(refname:short)", `refs/heads/proposal/${base}*`], projectDir).split("\n").filter(Boolean)
    : [];
  const re = new RegExp(`^proposal/${base}(?:-(\\d+))?$`);
  return out.map((b) => re.exec(b)).filter(Boolean)
    .map((m) => ({ name: m[0].slice("proposal/".length), k: m[1] ? Number(m[1]) : 1 }))
    .sort((a, b) => b.k - a.k).map((x) => x.name);
}

// An open build proposal is one with no gate file on its branch yet: not ruled, not
// returned, not escalated. The newest is the one a revision produced last.
export function openBuildProposal(projectDir, slice) {
  return buildProposals(projectDir, slice)
    .find((name) => !gitOk(["cat-file", "-e", `proposal/${name}:.sdlc/gates/${name}.yaml`], projectDir)) ?? null;
}

// The branch a binding of the new target runs against, for the rebind entries it is handed:
// `{ branch }`, or `{ why }` when there is no one branch to start it from. The application
// such a binding needs is on a build proposal alone until that proposal is ruled
// (`docs/decisions/0016`, `docs/decisions/0075`). An entry a verify filed names its slice; one
// that names none belongs to whichever slice claims its criterion. With no entries at all —
// a binding that only catches up with the contract — every slice in the plan is a candidate.
// Exactly one of them may have an open build proposal: one sandbox runs one application, and
// choosing between two is a person's call.
export function bindingBranch(projectDir, entries = []) {
  const slices = new Set();
  const unstamped = new Set();
  for (const e of entries) {
    if (e?.slice !== undefined && e?.slice !== null) slices.add(Number(e.slice));
    else if (e?.id) unstamped.add(e.id);
  }
  const path = join(projectDir, TASKS_PATH);
  const plan = existsSync(path) ? parseTasks(readText(path)).slices : [];
  for (const s of plan) if (s.criteria.some((id) => unstamped.has(id))) slices.add(s.number);
  const candidates = entries.length ? [...slices] : plan.map((s) => s.number);
  const open = candidates.sort((a, b) => a - b)
    .map((n) => ({ n, name: openBuildProposal(projectDir, n) })).filter((x) => x.name);
  if (open.length === 1) return { branch: `proposal/${open[0].name}` };
  if (open.length > 1) return { why: `slices ${open.map((x) => x.n).join(", ")} each have an open build proposal (${open.map((x) => `proposal/${x.name}`).join(", ")}), and which of them to bind against is a person's call` };
  if (!candidates.length) return { why: entries.length ? "no slice in plan/tasks.md claims the criteria this binding is owed for" : "plan/tasks.md names no slice" };
  return { why: `no open build proposal for slice${candidates.length === 1 ? "" : "s"} ${candidates.join(", ")}` };
}

// The spec files that exist for these criteria, in the order the criteria are claimed. A
// criterion with no spec file of its own contributes nothing, so the result is often
// shorter than `criteria` — and it is legitimately EMPTY when a slice claims only
// criteria that are not-testable, or whose tests have not been derived yet. Empty means
// "no spec file to run", never "run everything": `runSuite` reads an empty array that way
// (`src/testrun/playwright.mjs`), and only `undefined` is its no-filter value.
export function specFilesFor(projectDir, criteria) {
  const root = join(projectDir, "tests", "acceptance");
  if (!existsSync(root)) return [];
  const byId = new Map();
  for (const domain of readdirSync(root, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue;
    for (const f of readdirSync(join(root, domain.name))) {
      const m = /^(.+)\.spec\.ts$/.exec(f);
      if (m) byId.set(m[1], `tests/acceptance/${domain.name}/${f}`);
    }
  }
  return criteria.map((id) => byId.get(id)).filter(Boolean);
}

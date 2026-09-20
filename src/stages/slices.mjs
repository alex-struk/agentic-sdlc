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

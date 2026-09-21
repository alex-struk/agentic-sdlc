import { git, gitOk } from "../lib/git.mjs";
import { CRITERION_ID_PATTERN, parseDomainFile } from "../spec/criteria.mjs";

// What a ruling on derived work turns on, put in front of the ruler on purpose.
//
// A proposal that derives something from the criteria — a test suite, an adapter, a plan
// that assigns criteria to slices, a slice that claims them — is ruled by comparing what it
// produced against what the criterion says. The criterion's own text was in none of it. A
// rewritten test rescues itself by accident, because its title quotes the criterion; a
// deleted one, or a criterion recorded as untestable, appears as an id and a sentence of
// prose with the statement it is answerable to nowhere in the prompt. The ruler holds read
// tools and can go looking, but nothing names a path, so it spends its turns finding what
// the prompt should have handed it.
//
// This is `0014` applied to the criteria the way `verify-evidence.mjs` applied it to the
// suite result: read here, resolved here, and carried in a section of its own outside the
// diff's budget, so evidence a gate is decided on never depends on surviving a cap.

const ID_RE = new RegExp(`(?<![\\w-])(?:${CRITERION_ID_PATTERN})(?![\\w-])`, "g");

// Every criterion id in a piece of text, in the order it first appears and without
// repeats. The text is a proposal page, a path, or a diff hunk: an id is recognised by the
// same grammar a domain-file heading is parsed with, so a file named for its criterion, a
// header line naming it and a sentence mentioning it all read the same.
export function criterionIdsIn(text) {
  if (!text) return [];
  return [...new Set(String(text).match(ID_RE) ?? [])];
}

// A changed file whose own diff is longer than this is not read for ids. A criterion id is
// recorded by somebody deciding something about that criterion — a spec file, an
// exemption list, a plan's task table — and those are short. A file with thousands of
// changed lines is a toolchain's output, where an id that appears is being carried rather
// than decided, and reading every one of them would put the whole diff through this module
// for the sake of the few files that hold a decision.
const SCAN_LINES = 400;
// And no more than this many files are read at all, so a proposal that changes a thousand
// small files cannot turn prompt-building into a thousand `git diff` calls.
const SCAN_FILES = 200;

// The first of the three places a criterion's text is looked for, named here because it is
// also the one the quoted row does not bother to mention.
const BRANCH_INDEX = "the criteria index on this branch";

// The criteria a proposal touches, worked out from the proposal rather than from the stage
// that opened it: the ids its own page names, the ids in the paths of the files it changes
// — a spec file is named for its criterion, so a deleted one still says which — and the
// ids in the changed lines of those files, which is where an id being recorded as
// untestable, or removed from a list, is written down.
//
// `fromChanged` and `fromPage` are kept apart because they rank differently: a criterion
// whose own file this proposal changed is what the ruling is about, and one the page
// merely mentions is context. When the section has to be cut, it is cut from the second.
export function touchedCriteria(projectDir, branch, proposalText) {
  const range = `main...${branch}`;
  // `--no-renames` so a path reads as one path rather than as `a/{old => new}/b`, which
  // neither the id scan nor the per-file diff below can use.
  const numstat = gitOk(["diff", range, "--numstat", "--no-renames"], projectDir)
    ? git(["diff", range, "--numstat", "--no-renames"], projectDir) : "";
  const rows = numstat ? numstat.split("\n").filter(Boolean).map((l) => {
    const [adds, dels, ...rest] = l.split("\t");
    return { path: rest.join("\t"), lines: Number(adds) + Number(dels) };
  }) : [];

  const changed = new Set(rows.map((r) => r.path));
  const fromChanged = [];
  const add = (into, ids) => { for (const id of ids) if (!into.includes(id)) into.push(id); };

  for (const r of rows) add(fromChanged, criterionIdsIn(r.path));
  let scanned = 0;
  let unscanned = 0;
  for (const r of rows) {
    // A binary file's counts are `-`, which is `NaN` here and is not read either way.
    if (scanned >= SCAN_FILES || !(r.lines <= SCAN_LINES)) { unscanned++; continue; }
    scanned++;
    // `--unified=0` because only the changed lines say what this proposal decided; a
    // criterion id sitting in three lines of unchanged context is somebody else's work.
    const hunks = git(["diff", range, "--unified=0", "--no-renames", "--", r.path], projectDir);
    add(fromChanged, criterionIdsIn(hunks));
  }

  const fromPage = criterionIdsIn(proposalText).filter((id) => !fromChanged.includes(id));
  return { fromChanged, fromPage, changed, unscanned };
}

function indexAt(projectDir, ref) {
  const rel = "spec/criteria-index.json";
  if (!gitOk(["cat-file", "-e", `${ref}:${rel}`], projectDir)) return null;
  try {
    const doc = JSON.parse(git(["show", `${ref}:${rel}`], projectDir));
    return Array.isArray(doc?.criteria) ? doc.criteria : null;
  } catch { return null; }
}

// Every criterion on the branch's own domain files, parsed off the branch rather than off
// disk so this reads the same whether or not the branch is checked out. This is the source
// that holds a criterion the compiled index has not seen yet, which is every criterion an
// archaeology proposal minted and no `ratify` run has taken up.
function domainsAt(projectDir, ref) {
  const dir = "spec/domains";
  if (!gitOk(["ls-tree", "-r", "--name-only", ref, "--", dir], projectDir)) return [];
  const listed = git(["ls-tree", "-r", "--name-only", ref, "--", dir], projectDir);
  const out = [];
  for (const rel of listed.split("\n").filter((f) => f.endsWith(".md"))) {
    const domain = rel.slice(`${dir}/`.length).replace(/\.md$/, "");
    let text;
    try { text = git(["show", `${ref}:${rel}`], projectDir); } catch { continue; }
    for (const c of parseDomainFile(text, domain).criteria) out.push({ ...c, file: rel });
  }
  return out;
}

// Where each id's text was found, and the order the three sources are tried in.
//
// The compiled index on the branch first: it is what every stage after `ratify` reads, it
// is one read for the whole project, and it carries the criterion as the proposal's own
// branch has it. The branch's domain files next, for an id the index has not caught up
// with — a freshly minted criterion is in the file and not yet in the catalogue. `main`'s
// index last, for a branch cut before the criterion was ratified onto it.
//
// An id none of them holds is not quietly dropped. It is returned unresolved and named in
// the section, because a ruler shown a shortened list has no way to tell a criterion that
// does not exist from one the prompt could not look up.
export function resolveCriteria(projectDir, branch, ids) {
  const wanted = new Set(ids);
  const found = new Map();
  const take = (rows, source) => {
    for (const c of rows ?? []) {
      if (!wanted.has(c.id) || found.has(c.id)) continue;
      found.set(c.id, { ...c, source });
    }
  };
  if (wanted.size) take(indexAt(projectDir, branch), BRANCH_INDEX);
  if (found.size < wanted.size) take(domainsAt(projectDir, branch), "the domain files on this branch");
  if (found.size < wanted.size) take(indexAt(projectDir, "main"), "the criteria index on main");
  return {
    resolved: ids.filter((id) => found.has(id)).map((id) => found.get(id)),
    unresolved: ids.filter((id) => !found.has(id)),
  };
}

// How many criteria are quoted in full before the rest are listed by id alone, and how
// much of one criterion is quoted. Both are caps on a section that has to sit beside a
// diff, not a view on how much a ruler would like: the whole section is at most a few
// thousand characters however many criteria a proposal names, and every cut says what it
// cut and where the rest can be read.
const QUOTED = 30;
const FIELD = 400;

function clip(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > FIELD ? `${t.slice(0, FIELD)} […]` : t;
}

function quote(c) {
  // Where the text came from is said only when it did not come from the branch's own
  // catalogue. A criterion read off `main` is one this branch has not ratified, and a ruler
  // comparing derived work against it is comparing against the version upstream holds.
  const from = c.source && c.source !== BRANCH_INDEX ? ` · read from ${c.source}` : "";
  const head = `- **${c.id}** · v${c.version} · ${c.confidence ?? "confidence unrecorded"} · state: ${c.state ?? "unrecorded"} · \`${c.file ?? "file unrecorded"}\`${from}`;
  const lines = [head];
  const statement = clip(c.statement);
  lines.push(`  ${statement || "(this criterion has no statement recorded)"}`);
  // Given/when/then is what a derived test is actually written against, so where a
  // criterion carries it, it is the part of the row a ruling on a test turns on.
  const gwt = [["given", c.given], ["when", c.when], ["then", c.then]].filter(([, v]) => v);
  for (const [k, v] of gwt) lines.push(`  - ${k}: ${clip(v)}`);
  return lines.join("\n");
}

// The section a ruling is given for the criteria its proposal touches. Bounded by
// construction: the criteria whose own files this proposal changed are quoted first, the
// ones its page only mentions after them, at most `QUOTED` in full and the remainder by id
// with a line saying where to read them.
//
// A criterion defined in a file this proposal itself changes is named and not quoted. Its
// text is the diff — the proposal's own output, ordered first in it — and quoting it here
// would be the same text a second time, which is why the proposal page and the verify
// result are left out of the diff for their part.
export function formatCriteriaEvidence({ fromChanged, fromPage, changed, resolved, unresolved, unscanned = 0 }) {
  const total = fromChanged.length + fromPage.length;
  if (!total) return "";

  const by = new Map(resolved.map((c) => [c.id, c]));
  const order = [...fromChanged, ...fromPage];
  const inDiff = order.filter((id) => by.has(id) && changed?.has(by.get(id).file));
  const quotable = order.filter((id) => by.has(id) && !changed?.has(by.get(id).file));

  const lines = [
    "## The criteria this proposal touches",
    "",
    `${total} criterion(s) are named by this proposal: ${fromChanged.length} by the files it changes and`,
    `${fromPage.length} by its page alone. Their text is quoted here rather than left to be looked up,`,
    "because a ruling on work derived from a criterion is a comparison against what that",
    "criterion says, and a spec this proposal deletes leaves nothing on the branch to read it",
    "from. This section is outside the diff's budget and is never cut by it.",
    "",
  ];

  for (const id of quotable.slice(0, QUOTED)) lines.push(quote(by.get(id)));

  if (quotable.length > QUOTED) {
    const rest = quotable.slice(QUOTED);
    lines.push("",
      `${rest.length} further criterion(s) are named by this proposal and not quoted here, so that this`,
      `section cannot spend the budget the diff needs: ${rest.join(", ")}.`,
      "Read them in `spec/criteria-index.json`, or in `spec/domains/` on this branch.");
  }

  if (inDiff.length) {
    lines.push("",
      `${inDiff.length} of them are defined in files this proposal itself changes, so their text is in the`,
      `diff below rather than quoted twice: ${inDiff.join(", ")}.`);
  }

  if (unresolved.length) {
    lines.push("",
      `${unresolved.length} of them could not be resolved to any criterion text on this branch or on main:`,
      `${unresolved.join(", ")}. That is a gap in what you have been shown, not a statement that`,
      "these criteria do not exist. If the ruling turns on one of them, return the proposal saying so.");
  }

  if (unscanned) {
    lines.push("",
      `${unscanned} changed file(s) were not read for criterion ids, being too long or too many to read for`,
      "that — machine-written output, usually. If one of them decides something about a criterion,",
      "the criterion is missing from the list above. The diff below says which files changed.");
  }

  return lines.join("\n");
}

// The whole of it in one call, for a caller that has a project, a branch and a proposal
// page and wants the section or nothing. An empty string means the proposal names no
// criteria at all — an intent proposal, a policy proposal — and nothing is added to the
// prompt, rather than a heading over an empty list.
export function criteriaEvidenceFor(projectDir, branch, proposalText) {
  const touched = touchedCriteria(projectDir, branch, proposalText);
  const { resolved, unresolved } = resolveCriteria(projectDir, branch, [...touched.fromChanged, ...touched.fromPage]);
  return formatCriteriaEvidence({ ...touched, resolved, unresolved });
}

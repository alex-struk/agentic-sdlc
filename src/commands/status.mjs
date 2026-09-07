import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { readJournal } from "../runner/journal.mjs";
import { COMMANDS } from "../cli.mjs";
import { STATES, orderDomains } from "../spec/criteria.mjs";
import { coverage, readNotTestable } from "../checks/tests.mjs";
import { followUpState } from "../stages/shared.mjs";

// Every value a results row's `result` field can hold (`src/testrun/playwright.mjs`),
// in the fixed order the board and the results page always report them in.
const RESULT_VALUES = ["pass", "fail", "unbound", "stale", "not-testable"];

// ISO 8601 week: Thursday of the same week decides the week-numbering year, which is
// what makes the last days of December (or first days of January) land in the correct
// week rather than the calendar year's own week 1/52.
function isoWeek(at) {
  const d = new Date(at);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Sampling is a per-(gate, ISO week) cap on agent-held rulings: the first N by `at`
// (chronological, not display order) are marked, so which rulings get sampled does not
// depend on how the table happens to be sorted for reading.
function computeSampled(gates, cfg) {
  const byGateWeek = new Map();
  for (const g of gates) {
    if (g.held_by !== "agent") continue;
    const key = `${g.gate}|${isoWeek(g.at)}`;
    if (!byGateWeek.has(key)) byGateWeek.set(key, []);
    byGateWeek.get(key).push(g);
  }
  const sampled = new Set();
  for (const [key, list] of byGateWeek) {
    const gateName = key.slice(0, key.indexOf("|"));
    const n = cfg?.policy?.gates?.[gateName]?.human_sample_per_week ?? 0;
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    for (const g of list.slice(0, n)) sampled.add(g);
  }
  return sampled;
}

// Costs are summed, and a sum of floats prints as 0.30000000000000004 often enough to
// matter on a page people read. Six decimal places is far below a cent and well inside
// what any single turn reports.
function money(n) {
  return Math.round(n * 1e6) / 1e6;
}

function parseFrontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!m) return { front: {}, body: text };
  return { front: parse(m[1]) ?? {}, body: m[2] };
}

// A GitHub-flavoured Markdown table built from a column-array header and one array of
// cells per row, rather than joining strings by hand at each call site: that is what
// keeps an empty column list (no target directories yet) from leaving a dangling
// `| ... |  |` with a phantom trailing column, since the separator row is always derived
// from `headerCols.length` rather than from joining a possibly-empty list of its own.
function mdTable(headerCols, rowsCols) {
  return [`| ${headerCols.join(" | ")} |`, `| ${headerCols.map(() => "---").join(" | ")} |`,
    ...rowsCols.map((cols) => `| ${cols.join(" | ")} |`)].join("\n");
}

// The target directories under `tests/results/`, sorted — `calibrate --target <t>`
// writes one, so this is also the list of targets the site has anything to say about.
// Sorted (not chronological, not config-ordered) since nothing elects an order for them:
// a project adds a target by running calibration against it, not by declaring it.
function resultTargets(projectDir) {
  const dir = join(projectDir, "tests", "results");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function readResultsFile(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readText(path)); } catch { return null; }
}

// `<covered>/<accepted>`, with a not-testable count folded in when the domain has any —
// blank when the domain has neither a spec file nor a not-testable entry, since a bare
// `0/0` would misread as "nothing accepted" rather than "coverage not run yet".
function testsColumn(projectDir, domain) {
  const domainDir = join(projectDir, "tests", "acceptance", domain);
  const hasSpecFile = existsSync(domainDir) && readdirSync(domainDir).some((f) => f.endsWith(".spec.ts"));
  const { covered, missing, notTestable } = coverage(projectDir, domain);
  if (!hasSpecFile && notTestable.length === 0) return "";
  const accepted = covered.length + missing.length + notTestable.length;
  const nt = notTestable.length ? ` (n/t ${notTestable.length})` : "";
  return `${covered.length}/${accepted}${nt}`;
}

// A results file's rows, or an empty list when it has none the site can read. `latest.json`
// is written by `calibrate` but read here from disk, where it can be anything — truncated
// by an interrupted write, hand-edited, or an older shape entirely — and a `rows` that is
// not an array would otherwise take the whole site build down with it.
function resultRows(latest) {
  return Array.isArray(latest?.rows) ? latest.rows : [];
}

// `<n> pass · <n> fail · <n> unbound · <n> stale` across this domain's rows in one
// target's `latest.json` — `not-testable` rows are left out, since a not-testable
// criterion is already accounted for in the `tests` column and counting it again here
// would double-report it. Blank when the target has no results file at all yet, which is
// a different claim from every count being zero (a results file that simply has no row
// for this domain still prints zeros, honestly reporting "ran, found nothing here").
function resultCountsColumn(latest, domain) {
  if (!latest) return "";
  const rows = resultRows(latest).filter((r) => r?.domain === domain);
  return ["pass", "fail", "unbound", "stale"].map((k) => `${rows.filter((r) => r.result === k).length} ${k}`).join(" · ");
}

// A criterion's `test` cell on its domain page: the spec file's path relative to
// `tests/` when `coverage` found one, the not-testable reason when it is recorded
// instead, or `—` for a criterion coverage has nothing to say about (not accepted yet,
// or accepted but missing both).
function testCell(cov, notTestableEntries, domain, id) {
  if (cov.covered.includes(id)) return `acceptance/${domain}/${id}.spec.ts`;
  if (cov.notTestable.includes(id)) {
    const entry = notTestableEntries.find((e) => e?.id === id);
    return `not testable: ${entry?.reason ?? ""}`;
  }
  return "—";
}

// A criterion's cell in one target's column: the row's own result, with the ruling verb
// appended when a calibration ruling already answered it, or blank when the target's
// results carry no row for this criterion at all (never run against it, or a domain
// nobody has derived tests for yet).
function targetCell(latest, id) {
  const row = resultRows(latest).find((r) => r?.id === id);
  if (!row) return "";
  return row.ruled ? `${row.result} (ruled: ${row.ruled})` : row.result;
}

export function buildSite(projectDir) {
  projectDir = resolve(projectDir);
  const { config: cfg, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  // The site is a report on the project, so a configuration problem is reported rather
  // than raised: the gate log and the run log are still worth generating without it.
  for (const e of errors) console.warn(`warning: .sdlc/config.yaml: ${e}`);
  if (!cfg) throw new Error(`cannot build the site: .sdlc/config.yaml did not parse`);
  const idxPath = join(projectDir, "spec", "criteria-index.json");
  const criteria = (existsSync(idxPath) ? JSON.parse(readText(idxPath)).criteria : []) ?? [];

  // The coverage board is one row per domain. `config.project.domains` always
  // contributes a row — so a project with no criteria yet still shows its configured
  // domains at zero rather than an empty table — plus any domain a criterion names that
  // the config does not (the index can be ahead of a config edit). `criteria/<domain>.md`
  // is narrower: written only for a domain that actually has criteria in the index,
  // since a page listing nothing would be pure noise.
  const configuredDomains = Array.isArray(cfg?.project?.domains) ? cfg.project.domains : null;
  const criteriaDomains = [...new Set(criteria.map((c) => c.domain).filter((d) => d !== undefined))];
  const boardDomains = orderDomains(configuredDomains, [...new Set([...(configuredDomains ?? []), ...criteriaDomains])]);
  const pageDomains = orderDomains(configuredDomains, criteriaDomains);

  const rows = boardDomains.map((domain) => {
    const inDomain = criteria.filter((c) => c.domain === domain);
    const stateCounts = STATES.map((s) => inDomain.filter((c) => c.state === s).length);
    const openQuestions = inDomain.filter((c) => c.confidence === "open").length;
    return { domain, stateCounts, openQuestions, total: inDomain.length };
  });
  const totals = {
    stateCounts: STATES.map((_, i) => rows.reduce((sum, r) => sum + r.stateCounts[i], 0)),
    openQuestions: rows.reduce((sum, r) => sum + r.openQuestions, 0),
    total: rows.reduce((sum, r) => sum + r.total, 0),
  };
  // One `tests` column (blind-coverage progress) plus one column per target directory
  // under `tests/results/` (calibration progress against that target) — generalised over
  // the target list rather than hard-coded to `old`, so a later `new` target grows the
  // board a column with no code change here.
  const targets = resultTargets(projectDir);
  const latestByTarget = new Map(targets.map((t) => [t, readResultsFile(join(projectDir, "tests", "results", t, "latest.json"))]));
  const coverageHeader = ["Domain", ...STATES, "open questions", "total", "tests", ...targets];
  const coverageRows = rows.map((r) => [
    r.domain, ...r.stateCounts, r.openQuestions, r.total,
    testsColumn(projectDir, r.domain), ...targets.map((t) => resultCountsColumn(latestByTarget.get(t), r.domain)),
  ]);
  const totalsRow = ["**Totals**", ...totals.stateCounts, totals.openQuestions, totals.total, "", ...targets.map(() => "")];
  const coverageLines = ["## Coverage", "", mdTable(coverageHeader, [...coverageRows, totalsRow]), ""];

  // One page per domain that appears in the index, one section per criterion: the
  // heading names id/version/confidence/state, then the statement and whichever of
  // given/when/then, cites (recovered criteria only — an authored criterion carries no
  // citations), reconciliation, replaces/superseded-by and notes are actually set. The
  // bullet order matches `serialiseDomainFile`'s domain-file format, minus `tier` (a
  // reviewer field the coverage board has no use for) and `state` (already in the
  // heading, not repeated as a bullet here).
  const criteriaPages = pageDomains.map((domain) => {
    const inDomain = criteria.filter((c) => c.domain === domain);
    const cov = coverage(projectDir, domain);
    const notTestableEntries = readNotTestable(projectDir);
    const testsTable = mdTable(["id", "test", ...targets], inDomain.map((c) =>
      [c.id, testCell(cov, notTestableEntries, domain, c.id), ...targets.map((t) => targetCell(latestByTarget.get(t), c.id))]));
    const blocks = inDomain.map((c) => {
      const lines = [`### ${c.id} · v${c.version} · ${c.confidence} · ${c.state}`, "", c.statement];
      for (const cite of c.cites ?? []) lines.push(`- cites: ${cite.line !== undefined ? `${cite.path}:${cite.line}` : cite.path}`);
      if (c.reconciliation) lines.push(`- reconciliation: ${c.reconciliation}`);
      if (c.given) lines.push(`- given: ${c.given}`);
      if (c.when) lines.push(`- when: ${c.when}`);
      if (c.then) lines.push(`- then: ${c.then}`);
      if (c.replaces) lines.push(`- replaces: ${c.replaces}`);
      if (c.supersededBy) lines.push(`- superseded-by: ${c.supersededBy}`);
      for (const note of c.notes ?? []) lines.push(`- note: ${note}`);
      return lines.join("\n");
    });
    return [`site/criteria/${domain}.md`, [`# ${domain}`, "## Tests", testsTable, ...blocks].join("\n\n") + "\n"];
  });

  const gatesDir = join(projectDir, ".sdlc", "gates");
  const gates = existsSync(gatesDir) ? readdirSync(gatesDir).filter((f) => f.endsWith(".yaml")).map((f) => ({ name: f.replace(/\.yaml$/, ""), ...parse(readText(join(gatesDir, f))) })) : [];
  gates.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const sampled = computeSampled(gates, cfg);
  // `Cost` is what the ruling turn itself cost. A human ruling has no turn to measure
  // and its cell is blank, which is not the same claim as $0 — an agent ruling that
  // genuinely cost nothing (a mandatory escalation, a mock) does print $0.
  const rulingsCost = money(gates.reduce((sum, g) => sum + (Number(g.cost) || 0), 0));
  const gatesMd = ["# Gate log", "", "| When | Proposal | Gate | Verdict | By | Held | Cost | Sample |", "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...gates.map((g) => `| ${g.at} | ${g.name} | ${g.gate} | ${g.verdict} | ${g.by} | ${g.held_by === "agent" ? "agent-held, unsampled" : "human"} | ${g.cost === undefined ? "" : `$${g.cost}`} | ${sampled.has(g) ? "sample" : ""} |`), ""].join("\n");

  const runsDir = join(projectDir, ".sdlc", "runs");
  const runs = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith(".md")).sort().reverse().map((f) => readText(join(runsDir, f))) : [];
  const runsMd = ["# Run log", "", ...runs].join("\n");

  // One section per target: every dated results file `calibrate` wrote against it
  // (`latest.json` and `applied.yaml` excluded — the first is a duplicate of the newest
  // dated file, and the second is calibration's own bookkeeping, not a run record),
  // newest first, plus whether a calibration ruling is still open for that target. No
  // targets at all — a project that has never run `calibrate` — gets a page saying so
  // rather than an empty "## " heading with nothing under it.
  const resultsMd = targets.length === 0 ? "# Results\n\nThere are no results yet.\n" :
    ["# Results", "", ...targets.map((target) => {
      const dir = join(projectDir, "tests", "results", target);
      const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}(-\d+)?\.json$/.test(f));
      const entries = files.map((f) => {
        const data = readResultsFile(join(dir, f)) ?? {};
        const rows = Array.isArray(data.rows) ? data.rows : [];
        return { file: f, at: data.at ?? "", counts: RESULT_VALUES.map((k) => rows.filter((r) => r.result === k).length) };
      }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const table = mdTable(["file", "at", ...RESULT_VALUES], entries.map((e) => [e.file, e.at, ...e.counts]));
      const { open } = followUpState(projectDir, `calibrate-${target}`);
      const proposalLine = open ? `Open calibration proposal: ${open}.` : "no calibration ruling open.";
      return [`## ${target}`, "", table, "", proposalLine].join("\n");
    }), ""].join("\n\n");

  const journal = readJournal(projectDir);
  const journalCost = money(journal.reduce((sum, e) => sum + (Number(e.cost) || 0), 0));
  const journalMd = ["# Journal", "", ...journal.slice().reverse().flatMap((e) => {
    const num = (e.file.match(/^(\d+)/) ?? [, ""])[1];
    const date = e.at ? String(e.at).slice(0, 10) : "";
    return [`## ${num} · ${e.stage} · ${date}`, "", `cost $${e.cost} · turns ${e.turns}`, "", e.body.trim(), ""];
  })].join("\n");

  // Every proposal gets a page regardless of whether it has been ruled: an open
  // proposal (no gate file yet) is exactly the case a reader most wants to see, since
  // it names who the site is waiting on.
  const proposalsDir = join(projectDir, ".sdlc", "proposals");
  const proposalNames = existsSync(proposalsDir) ? readdirSync(proposalsDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort() : [];
  const gateByName = new Map(gates.map((g) => [g.name, g]));
  const proposalPages = proposalNames.map((name) => {
    const { front, body } = parseFrontMatter(readText(join(proposalsDir, `${name}.md`)));
    const holder = cfg?.policy?.gates?.[front.gate]?.holder ?? "";
    const rows = [["gate", front.gate ?? ""], ["opened", front.opened ?? ""]];
    if (front.tier) rows.push(["tier", front.tier]);
    rows.push(["holder", holder]);
    const table = ["| Field | Value |", "| --- | --- |", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
    const gateFile = gateByName.get(name);
    // The `## Ruling` section, when present, was appended straight into the proposal
    // page by the ruling agent path (see rule.mjs `appendRulingSection`), so it is
    // already part of `body` and needs no extra text here — only the three cases where
    // the page itself is silent about its own outcome need one.
    let tail = null;
    if (/^## Ruling/m.test(body)) tail = null;
    else if (!gateFile) tail = `_Open, waiting for ${holder}_`;
    else if (gateFile.verdict === "escalated") tail = `_Escalated to ${gateFile.escalate_to}: ${gateFile.rationale}_`;
    else tail = `_Ruled: ${gateFile.verdict} by ${gateFile.by}_`;
    const parts = [table, body.trim()];
    if (tail) parts.push(tail);
    return [`site/proposals/${name}.md`, parts.join("\n\n") + "\n", name];
  });
  const openProposals = proposalNames.filter((name) => !gateByName.has(name)).length;
  const agentRulings = gates.filter((g) => g.held_by === "agent" && g.verdict !== "escalated").length;
  const openEscalations = gates.filter((g) => g.verdict === "escalated").length;

  // No generation timestamp: the site is committed by whatever run or ruling regenerated
  // it, so git already dates it, and a timestamp would make every rebuild a diff — which
  // is what turns `sdlc status` on an unchanged project into a dirty tree.
  const index = [`# ${cfg.project.name} — state`, "", `Profile: ${cfg.profile}`, "",
    ...coverageLines,
    "## Pages", "",
    "- [Journal](journal.md)", "- [Gates](gates.md)", "- [Runs](runs.md)", "- [Results](results.md)",
    ...proposalPages.map(([, , name]) => `- [${name}](proposals/${name}.md)`), "",
    "## Criteria", "",
    ...pageDomains.map((domain) => `- [${domain}](criteria/${domain}.md)`), "",
    "## Totals", "",
    `- Journal cost: $${journalCost}`,
    `- Rulings cost: $${rulingsCost}`,
    `- Total cost: $${money(journalCost + rulingsCost)}`,
    `- Agent-held rulings: ${agentRulings}`,
    `- Open escalations: ${openEscalations}`,
    `- Open proposals: ${openProposals}`, ""].join("\n");

  const pages = [["site/index.md", index], ["site/gates.md", gatesMd], ["site/runs.md", runsMd], ["site/results.md", resultsMd], ["site/journal.md", journalMd],
    ...proposalPages.map(([p, t]) => [p, t]), ...criteriaPages];
  for (const [p, t] of pages) writeText(join(projectDir, p), t);
  return { pages: pages.map(([p]) => p) };
}

COMMANDS.status = async ({ pos }) => { const r = buildSite(pos[0] ?? process.cwd()); console.log(r.pages.join("\n")); return 0; };

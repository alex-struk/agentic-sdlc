// The site's data model: one read of the project on disk, shaped into plain values that
// every renderer shares. Nothing here formats anything — a Markdown cell and an HTML
// pip disagree about presentation and agree about the numbers, and that agreement is
// only cheap while the numbers are computed once, here.
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { readText } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { readJournal } from "../runner/journal.mjs";
import { STATES, orderDomains } from "../spec/criteria.mjs";
import { coverage, readNotTestable } from "../checks/tests.mjs";
import { followUpState } from "../stages/shared.mjs";

// Every value a results row's `result` field can hold (`src/testrun/playwright.mjs`),
// in the fixed order the board and the results page always report them in.
export const RESULT_VALUES = ["pass", "fail", "unbound", "stale", "not-testable"];

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
export function money(n) {
  return Math.round(n * 1e6) / 1e6;
}

export function parseFrontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!m) return { front: {}, body: text };
  return { front: parse(m[1]) ?? {}, body: m[2] };
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

// A results file's rows, or an empty list when it has none the site can read. `latest.json`
// is written by `calibrate` but read here from disk, where it can be anything — truncated
// by an interrupted write, hand-edited, or an older shape entirely — and a `rows` that is
// not an array would otherwise take the whole site build down with it.
export function resultRows(latest) {
  return Array.isArray(latest?.rows) ? latest.rows : [];
}

export function collect(projectDir) {
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
  // the config does not (the index can be ahead of a config edit). `criteria/<domain>`
  // is narrower: written only for a domain that actually has criteria in the index,
  // since a page listing nothing would be pure noise.
  const configuredDomains = Array.isArray(cfg?.project?.domains) ? cfg.project.domains : null;
  const criteriaDomains = [...new Set(criteria.map((c) => c.domain).filter((d) => d !== undefined))];
  const boardDomains = orderDomains(configuredDomains, [...new Set([...(configuredDomains ?? []), ...criteriaDomains])]);
  const pageDomains = orderDomains(configuredDomains, criteriaDomains);

  const notTestable = readNotTestable(projectDir);
  const domains = boardDomains.map((name) => {
    const inDomain = criteria.filter((c) => c.domain === name);
    const domainDir = join(projectDir, "tests", "acceptance", name);
    const hasSpecFile = existsSync(domainDir) && readdirSync(domainDir).some((f) => f.endsWith(".spec.ts"));
    return {
      name,
      criteria: inDomain,
      stateCounts: STATES.map((s) => inDomain.filter((c) => c.state === s).length),
      openQuestions: inDomain.filter((c) => c.confidence === "open").length,
      total: inDomain.length,
      coverage: coverage(projectDir, name),
      hasSpecFile,
    };
  });
  const totals = {
    stateCounts: STATES.map((_, i) => domains.reduce((sum, d) => sum + d.stateCounts[i], 0)),
    openQuestions: domains.reduce((sum, d) => sum + d.openQuestions, 0),
    total: domains.reduce((sum, d) => sum + d.total, 0),
  };

  // One `tests` column (blind-coverage progress) plus one column per target directory
  // under `tests/results/` (calibration progress against that target) — generalised over
  // the target list rather than hard-coded to `old`, so a later `new` target grows the
  // board a column with no code change here.
  const targets = resultTargets(projectDir);
  const latest = new Map(targets.map((t) => [t, readResultsFile(join(projectDir, "tests", "results", t, "latest.json"))]));
  const resultFiles = new Map(targets.map((target) => {
    const dir = join(projectDir, "tests", "results", target);
    const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}(-\d+)?\.json$/.test(f));
    return [target, files.map((f) => {
      const data = readResultsFile(join(dir, f)) ?? {};
      const rows = Array.isArray(data.rows) ? data.rows : [];
      return { file: f, at: data.at ?? "", counts: RESULT_VALUES.map((k) => rows.filter((r) => r.result === k).length) };
    }).sort((a, b) => String(b.at).localeCompare(String(a.at)))];
  }));
  const openCalibration = new Map(targets.map((t) => [t, followUpState(projectDir, `calibrate-${t}`).open ?? null]));

  const gatesDir = join(projectDir, ".sdlc", "gates");
  const gates = existsSync(gatesDir)
    ? readdirSync(gatesDir).filter((f) => f.endsWith(".yaml")).map((f) => ({ name: f.replace(/\.yaml$/, ""), ...parse(readText(join(gatesDir, f))) }))
    : [];
  gates.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const sampled = computeSampled(gates, cfg);

  const runsDir = join(projectDir, ".sdlc", "runs");
  const runs = existsSync(runsDir)
    ? readdirSync(runsDir).filter((f) => f.endsWith(".md")).sort().reverse().map((f) => ({ file: f, text: readText(join(runsDir, f)) }))
    : [];

  const journal = readJournal(projectDir);

  // Every proposal gets a page regardless of whether it has been ruled: an open
  // proposal (no gate file yet) is exactly the case a reader most wants to see, since
  // it names who the site is waiting on.
  const proposalsDir = join(projectDir, ".sdlc", "proposals");
  const proposalNames = existsSync(proposalsDir)
    ? readdirSync(proposalsDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort()
    : [];
  const gateByName = new Map(gates.map((g) => [g.name, g]));
  const proposals = proposalNames.map((name) => {
    const { front, body } = parseFrontMatter(readText(join(proposalsDir, `${name}.md`)));
    const holder = cfg?.policy?.gates?.[front.gate]?.holder ?? "";
    const ruling = gateByName.get(name) ?? null;
    // The `## Ruling` section, when present, was appended straight into the proposal
    // page by the ruling agent path (see rule.mjs `appendRulingSection`), so it is
    // already part of `body` and needs no extra text here — only the three cases where
    // the page itself is silent about its own outcome need one.
    const hasRulingSection = /^## Ruling/m.test(body);
    return { name, front, body, holder, ruling, hasRulingSection, open: !ruling };
  });

  // A returned proposal is not waiting on a person, so it never appears as `open`, but the
  // work it belongs to is still blocked: the stage has to run again and win a fresh
  // ruling. A return counts as still-standing when no later proposal sharing its stem
  // (the name with any trailing `-<n>` removed, which is how a revision is named) has
  // since been approved. Without this the site would report "nothing is waiting" for a
  // project whose next move is a revision, which is the opposite of the truth.
  const stemOf = (name) => name.replace(/-\d+$/, "");
  const approvedStems = new Set(gates.filter((g) => g.verdict === "approve").map((g) => stemOf(g.name)));
  const returned = gates
    .filter((g) => g.verdict === "return" && !approvedStems.has(stemOf(g.name)))
    .filter((g, i, all) => all.findIndex((o) => stemOf(o.name) === stemOf(g.name)) === i);

  const journalCost = money(journal.reduce((sum, e) => sum + (Number(e.cost) || 0), 0));
  const rulingsCost = money(gates.reduce((sum, g) => sum + (Number(g.cost) || 0), 0));

  return {
    projectDir,
    config: cfg,
    project: { name: cfg.project.name, profile: cfg.profile },
    criteria, boardDomains, pageDomains, domains, totals, notTestable,
    targets, latest, resultFiles, openCalibration,
    gates, sampled, runs, journal, proposals, returned,
    costs: { journal: journalCost, rulings: rulingsCost, total: money(journalCost + rulingsCost) },
    counts: {
      agentRulings: gates.filter((g) => g.held_by === "agent" && g.verdict !== "escalated").length,
      openEscalations: gates.filter((g) => g.verdict === "escalated").length,
      openProposals: proposals.filter((p) => p.open).length,
    },
  };
}

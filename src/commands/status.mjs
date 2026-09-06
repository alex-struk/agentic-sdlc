import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { readJournal } from "../runner/journal.mjs";
import { COMMANDS } from "../cli.mjs";

const STATES = ["proposed", "accepted", "implemented", "verified", "monitored"];

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

function parseFrontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!m) return { front: {}, body: text };
  return { front: parse(m[1]) ?? {}, body: m[2] };
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
  const counts = Object.fromEntries(STATES.map((s) => [s, criteria.filter((c) => c.state === s).length]));

  const gatesDir = join(projectDir, ".sdlc", "gates");
  const gates = existsSync(gatesDir) ? readdirSync(gatesDir).filter((f) => f.endsWith(".yaml")).map((f) => ({ name: f.replace(/\.yaml$/, ""), ...parse(readText(join(gatesDir, f))) })) : [];
  gates.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const sampled = computeSampled(gates, cfg);
  const gatesMd = ["# Gate log", "", "| When | Proposal | Gate | Verdict | By | Held | Sample |", "| --- | --- | --- | --- | --- | --- | --- |",
    ...gates.map((g) => `| ${g.at} | ${g.name} | ${g.gate} | ${g.verdict} | ${g.by} | ${g.held_by === "agent" ? "agent-held, unsampled" : "human"} | ${sampled.has(g) ? "sample" : ""} |`), ""].join("\n");

  const runsDir = join(projectDir, ".sdlc", "runs");
  const runs = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith(".md")).sort().reverse().map((f) => readText(join(runsDir, f))) : [];
  const runsMd = ["# Run log", "", ...runs].join("\n");

  const journal = readJournal(projectDir);
  const journalCost = journal.reduce((sum, e) => sum + (Number(e.cost) || 0), 0);
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

  const index = [`# ${cfg.project.name} — state`, "", `Profile: ${cfg.profile} · generated ${new Date().toISOString()}`, "",
    "## Coverage", "", "| State | Criteria |", "| --- | --- |", ...STATES.map((s) => `| ${s} | ${counts[s]} |`), "",
    `Total criteria: ${criteria.length}`, "",
    "## Pages", "",
    "- [Journal](journal.md)", "- [Gates](gates.md)", "- [Runs](runs.md)",
    ...proposalPages.map(([, , name]) => `- [${name}](proposals/${name}.md)`), "",
    "## Totals", "",
    `- Journal cost: $${journalCost}`,
    `- Agent-held rulings: ${agentRulings}`,
    `- Open escalations: ${openEscalations}`,
    `- Open proposals: ${openProposals}`, ""].join("\n");

  const pages = [["site/index.md", index], ["site/gates.md", gatesMd], ["site/runs.md", runsMd], ["site/journal.md", journalMd],
    ...proposalPages.map(([p, t]) => [p, t])];
  for (const [p, t] of pages) writeText(join(projectDir, p), t);
  return { pages: pages.map(([p]) => p) };
}

COMMANDS.status = async ({ pos }) => { const r = buildSite(pos[0] ?? process.cwd()); console.log(r.pages.join("\n")); return 0; };

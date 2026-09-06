import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";
import { COMMANDS } from "../cli.mjs";

const STATES = ["proposed", "accepted", "implemented", "verified", "monitored"];

export function buildSite(projectDir) {
  projectDir = resolve(projectDir);
  const cfg = parse(readText(join(projectDir, ".sdlc", "config.yaml")));
  const idxPath = join(projectDir, "spec", "criteria-index.json");
  const criteria = existsSync(idxPath) ? JSON.parse(readText(idxPath)).criteria : [];
  const counts = Object.fromEntries(STATES.map((s) => [s, criteria.filter((c) => c.state === s).length]));
  const index = [`# ${cfg.project.name} — state`, "", `Profile: ${cfg.profile} · generated ${new Date().toISOString()}`, "",
    "## Coverage", "", "| State | Criteria |", "| --- | --- |", ...STATES.map((s) => `| ${s} | ${counts[s]} |`), "",
    `Total criteria: ${criteria.length}`, "", "See [gates](gates.md) · [runs](runs.md)", ""].join("\n");

  const gatesDir = join(projectDir, ".sdlc", "gates");
  const gates = existsSync(gatesDir) ? readdirSync(gatesDir).filter((f) => f.endsWith(".yaml")).map((f) => ({ name: f.replace(/\.yaml$/, ""), ...parse(readText(join(gatesDir, f))) })) : [];
  gates.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const gatesMd = ["# Gate log", "", "| When | Proposal | Gate | Verdict | By | Held |", "| --- | --- | --- | --- | --- | --- |",
    ...gates.map((g) => `| ${g.at} | ${g.name} | ${g.gate} | ${g.verdict} | ${g.by} | ${g.held_by === "agent" ? "agent-held, unsampled" : "human"} |`), ""].join("\n");

  const runsDir = join(projectDir, ".sdlc", "runs");
  const runs = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith(".md")).sort().reverse().map((f) => readText(join(runsDir, f))) : [];
  const runsMd = ["# Run log", "", ...runs].join("\n");

  const pages = [["site/index.md", index], ["site/gates.md", gatesMd], ["site/runs.md", runsMd]];
  for (const [p, t] of pages) writeText(join(projectDir, p), t);
  return { pages: pages.map(([p]) => p) };
}

COMMANDS.status = async ({ pos }) => { const r = buildSite(pos[0] ?? process.cwd()); console.log(r.pages.join("\n")); return 0; };

import { join } from "node:path";
import { existsSync } from "node:fs";
import { readText } from "../lib/fsx.mjs";
import { git } from "../lib/git.mjs";
import { runChecks } from "../checks/index.mjs";
import { formatChecks } from "../commands/checks.mjs";

// The diff of files outside app/ is the reviewer's evidence, not a transcript to
// reproduce in full: a proposal that touches a lot of generated or vendored text would
// otherwise blow the prompt budget for no gain, so it is capped and the cut is marked.
const DIFF_CAP = 20000;

export function readPersonaBrief(projectDir, persona) {
  const p = join(projectDir, ".sdlc", "personas", `${persona}.md`);
  if (!existsSync(p)) throw new Error(`no persona brief for ${persona}`);
  return readText(p);
}

export async function buildPersonaPrompt(projectDir, name, persona, { tier }) {
  const brief = readPersonaBrief(projectDir, persona);
  const proposalPath = join(projectDir, ".sdlc", "proposals", `${name}.md`);
  const proposal = readText(proposalPath);

  const branch = `proposal/${name}`;
  const stat = git(["diff", `main...${branch}`, "--stat"], projectDir);
  let outside = git(["diff", `main...${branch}`, "--", ".", ":!app"], projectDir);
  if (outside.length > DIFF_CAP) outside = `${outside.slice(0, DIFF_CAP)}\n[truncated]`;

  const results = await runChecks(projectDir);
  const checksText = formatChecks(results);

  return [
    `# Ruling request: ${name}`,
    "",
    "You are ruling on this proposal as the persona described below. Read the proposal, the",
    "diff and the checks, then rule.",
    "",
    `## Persona brief: ${persona}`,
    "",
    brief.trim(),
    "",
    "## Proposal",
    "",
    proposal.trim(),
    "",
    "## Tier",
    "",
    tier,
    "",
    `## Diff summary (main...${branch})`,
    "",
    stat || "(no changes)",
    "",
    "## Diff outside app/",
    "",
    outside || "(no changes outside app/)",
    "",
    "## Checks",
    "",
    checksText,
    "",
    `Finish with one fenced \`\`\`json block: {"verdict": "approve"|"return"|"escalate", "rationale": "...", "conditions": [...]}. Nothing after the block.`,
  ].join("\n");
}

export function parseVerdict(text) {
  const re = /```json\s*([\s\S]*?)```/g;
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (last === null) throw new Error("no verdict block in persona reply");
  let parsed;
  try { parsed = JSON.parse(last); } catch (e) { throw new Error(`bad verdict block: ${e.message}`); }
  if (!["approve", "return", "escalate"].includes(parsed.verdict)) throw new Error(`bad verdict: ${parsed.verdict}`);
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
  if (!rationale.trim()) throw new Error("verdict has no rationale");
  return { verdict: parsed.verdict, rationale, conditions: parsed.conditions ?? [] };
}

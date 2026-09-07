import { join } from "node:path";
import { existsSync } from "node:fs";
import { readText } from "../lib/fsx.mjs";
import { git } from "../lib/git.mjs";
import { runChecks } from "../checks/index.mjs";
import { formatChecks } from "../commands/checks.mjs";

// The diff of files outside app/ is the reviewer's evidence, not a transcript to
// reproduce in full: a proposal that touches a lot of generated or vendored text would
// otherwise blow the prompt budget for no gain, so it is capped and the cut is marked.
const DIFF_CAP = 60000;

// Paths whose diff is never evidence for a ruling. `site/` is the regenerated state
// site, `.sdlc/runs/` the run record and `.sdlc/journal/` the stage's own journal entry
// — all three are derived from the very work being ruled on, all three change on every
// run, and between them they can be larger than everything the persona actually needs to
// read. Excluded by pathspec so they never enter the budget at all. `app/` is excluded
// for a different reason: the personas that hold the spec-side gates rule on the spec,
// not on an implementation.
const DIFF_EXCLUDE = [":!app", ":!site", ":!.sdlc/runs", ":!.sdlc/journal"];

// The stage's own output, first — the whole point of the ruling. Without this the diff
// is ordered however git lists paths (alphabetically), so a G1 archaeology proposal
// whose domain file sorts late could have that file, the one thing being ruled on, cut
// off by the cap while `.gitattributes` and a contract stub made it in. Longest prefix
// wins, so `spec/domains/` outranks `spec/` rather than tying with it.
const PRIORITY_PATHS = {
  G0: ["intent/"],
  G1: ["spec/domains/", "spec/"],
};

// Orders `files` so that anything under one of `prefixes` comes first, in the order the
// prefixes are given, and everything else keeps the order git listed it in.
export function orderDiffPaths(files, prefixes = []) {
  const rank = (f) => {
    let best = prefixes.length;
    for (let i = 0; i < prefixes.length; i++) if (f.startsWith(prefixes[i])) { best = Math.min(best, i); }
    return best;
  };
  return files
    .map((f, i) => ({ f, i, r: rank(f) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.f);
}

// The diff, one file at a time in `orderDiffPaths` order, concatenated until the cap is
// reached. Per file rather than in one `git diff` call because git orders its own output
// by path and ignores the order of the pathspec it was given, and the order is the whole
// point: the cap has to fall on the least important file, not on whichever one happens to
// sort last. A file whose own diff would overflow the budget is still started, so the
// reader sees its header and its opening hunks rather than nothing at all, and the cut is
// marked with what was left out.
function orderedDiff(projectDir, branch, gate) {
  const range = `main...${branch}`;
  const listed = git(["diff", range, "--name-only", "--", ".", ...DIFF_EXCLUDE], projectDir);
  const files = orderDiffPaths(listed ? listed.split("\n").filter(Boolean) : [], PRIORITY_PATHS[gate] ?? []);
  const parts = [];
  let used = 0;
  let cut = 0;
  for (const f of files) {
    if (used >= DIFF_CAP) { cut += 1; continue; }
    const one = git(["diff", range, "--", f], projectDir);
    if (!one) continue;
    const room = DIFF_CAP - used;
    if (one.length <= room) { parts.push(one); used += one.length; }
    else { parts.push(`${one.slice(0, room)}\n[truncated]`); used = DIFF_CAP; }
  }
  if (cut) parts.push(`[${cut} further changed file(s) not shown]`);
  return parts.join("\n");
}

export function readPersonaBrief(projectDir, persona) {
  const p = join(projectDir, ".sdlc", "personas", `${persona}.md`);
  if (!existsSync(p)) throw new Error(`no persona brief for ${persona}`);
  return readText(p);
}

export async function buildPersonaPrompt(projectDir, name, persona, { tier, gate = null }) {
  const brief = readPersonaBrief(projectDir, persona);
  const proposalPath = join(projectDir, ".sdlc", "proposals", `${name}.md`);
  const proposal = readText(proposalPath);

  const branch = `proposal/${name}`;
  const stat = git(["diff", `main...${branch}`, "--stat"], projectDir);
  const outside = orderedDiff(projectDir, branch, gate);

  // `criteria-index` is skipped here: it compares the live domain files on this
  // proposal's own branch against `spec/criteria-index.json`, which only `ratify`
  // regenerates. An archaeology proposal legitimately adds fresh `D-` criteria no
  // `ratify` run has seen yet, so once any domain in the project has been ratified once
  // — the point at which the index file starts existing at all — every later
  // archaeology proposal would show it as stale for criteria that were never meant to
  // be in it, a false failure that has nothing to do with whether this proposal is
  // sound (see `runChecks`'s own comment on `opts.skip`).
  const results = await runChecks(projectDir, { skip: ["criteria-index"] });
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
    "## Diff of the proposal's own output",
    "",
    "The stage's own output comes first. `app/`, the generated state site, the run record",
    "and the journal are left out — they are derived from the work being ruled on, not",
    "evidence about it.",
    "",
    outside || "(no changes to show)",
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

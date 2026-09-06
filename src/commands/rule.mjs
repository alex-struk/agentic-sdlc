import { join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { git, gitOk, assertCleanTree, stagePaths } from "../lib/git.mjs";
import { readText, writeText } from "../lib/fsx.mjs";
import { loadConfig, parseConfig } from "../config/load.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { buildPersonaPrompt, parseVerdict, readPersonaBrief } from "../runner/persona.mjs";
import { runAgent } from "../runner/executor.mjs";
import { buildSite } from "./status.mjs";
import { COMMANDS } from "../cli.mjs";

const SDLC_AUTHOR = ["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost"];

function mergeApproved(projectDir, branch, message) {
  git(["checkout", "-q", "main"], projectDir);
  try {
    git([...SDLC_AUTHOR, "merge", "-q", "--no-ff", "-m", message, branch], projectDir);
  } catch (e) {
    // A failed merge leaves main mid-merge, which is the worst place to stop: the
    // ruling is recorded, main is unbuildable, and nothing says why. Unwind it, put the
    // caller back on the proposal branch, and name the files a person has to reconcile.
    const conflicted = gitOk(["diff", "--name-only", "--diff-filter=U"], projectDir)
      ? git(["diff", "--name-only", "--diff-filter=U"], projectDir) : "";
    git(["merge", "--abort"], projectDir);
    git(["checkout", "-q", branch], projectDir);
    const files = conflicted ? `\nconflicted files:\n  ${conflicted.split("\n").join("\n  ")}` : "";
    throw new Error(`merging ${branch} into main failed; main was left unchanged and you are back on ${branch}.${files}\n${e.message}`);
  }
}

// The gate file's body differs by who ruled: a human writes a free-text `note`, an
// agent writes a `rationale` block plus the `conditions` it attached to the verdict.
// Building the text in one place keeps both shapes consistent (same key order, same
// block-scalar convention) without either caller knowing about the other's fields.
function gateFileText({ gate, verdict, by, heldBy, note, rationale, conditions }) {
  let text = `gate: ${gate}\nverdict: ${verdict}\nby: ${by}\nheld_by: ${heldBy}\n`;
  if (rationale !== undefined) {
    const block = rationale.split("\n").map((l) => (l ? `  ${l}` : "")).join("\n");
    text += `rationale: |\n${block}\n`;
    const list = conditions ?? [];
    text += list.length ? `conditions:\n${list.map((c) => `  - ${JSON.stringify(c)}`).join("\n")}\n` : `conditions: []\n`;
  } else {
    text += `note: ${JSON.stringify(note ?? "")}\n`;
  }
  text += `at: ${new Date().toISOString()}\n`;
  return text;
}

// Shared by the human path and the agent-approve/return path: write the gate file,
// append the run record, stage exactly those paths (plus the proposal page when the
// caller already appended a `## Ruling` section to it), commit, and merge on approve.
function commitRuling(projectDir, { name, branch, gate, verdict, by, heldBy, note, rationale, conditions, proposalPath, proposalAppended }) {
  const gatePath = join(".sdlc", "gates", `${name}.yaml`);
  writeText(join(projectDir, gatePath), gateFileText({ gate, verdict, by, heldBy, note, rationale, conditions }));
  const runPath = appendRun(projectDir, `rule ${name} ${verdict} at ${gate} by ${by} (${heldBy})`);
  const paths = [gatePath, relative(projectDir, runPath)];
  if (proposalAppended) paths.push(relative(projectDir, proposalPath));
  stagePaths(projectDir, paths);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} ${verdict} by ${by}`], projectDir);
  if (verdict === "approve") mergeApproved(projectDir, branch, `merge: ${name} approved at ${gate} by ${by}`);
}

function writeEscalation(projectDir, { name, gate, by, escalateTo, rationale }) {
  const gatePath = join(".sdlc", "gates", `${name}.yaml`);
  const block = rationale.split("\n").map((l) => (l ? `  ${l}` : "")).join("\n");
  writeText(join(projectDir, gatePath),
    `gate: ${gate}\nverdict: escalated\nby: ${by}\nheld_by: agent\nescalate_to: ${escalateTo ?? ""}\nrationale: |\n${block}\nat: ${new Date().toISOString()}\n`);
  const runPath = appendRun(projectDir, `rule ${name} escalated at ${gate} to ${escalateTo ?? "?"} by ${by}`);
  stagePaths(projectDir, [gatePath, relative(projectDir, runPath)]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} escalated to ${escalateTo ?? "?"}`], projectDir);
}

function appendRulingSection(text, { verdict, by, rationale, conditions = [] }) {
  const cond = conditions.length ? conditions.map((c) => `- ${c}`).join("\n") : "none";
  return `${text}\n## Ruling\n\n**Verdict:** ${verdict}\n**By:** ${by}\n\n${rationale}\n\n**Conditions:**\n${cond}\n`;
}

function openGate(projectDir, name) {
  const branch = `proposal/${name}`;
  if (!gitOk(["rev-parse", "--verify", branch], projectDir)) throw new Error(`no proposal branch ${branch}`);
  git(["checkout", "-q", branch], projectDir);
  const proposalPath = join(projectDir, ".sdlc", "proposals", `${name}.md`);
  const proposalText = existsSync(proposalPath) ? readText(proposalPath) : null;
  const gateMatch = proposalText ? proposalText.match(/^gate:\s*(\S+)/m) : null;
  if (!gateMatch) throw new Error(`proposal ${name} has no gate line`);
  const gate = gateMatch[1];
  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);
  const g = config.policy.gates[gate];
  if (!g) throw new Error(`gate ${gate} is not in policy`);
  return { branch, proposalPath, proposalText, gate, g, config };
}

export function rule(projectDir, name, verdict, { by, note = "" }) {
  projectDir = resolve(projectDir);
  if (!["approve", "return"].includes(verdict)) throw new Error("verdict must be approve or return");
  if (!by) throw new Error("rule needs --by <role or agent:persona>");
  assertCleanTree(projectDir, "rule");
  const { branch, gate, g } = openGate(projectDir, name);
  const allowed = [g.holder, g.escalate_to].filter(Boolean);
  if (!allowed.includes(by)) throw new Error(`${by} is not a holder of ${gate} (allowed: ${allowed.join(", ")})`);
  const heldBy = by.startsWith("agent:") ? "agent" : "human";
  commitRuling(projectDir, { name, branch, gate, verdict, by, heldBy, note });
  buildSite(projectDir);
  return { gate, verdict, heldBy };
}

// The agent path: no human types --by approve|return. A persona brief is handed to a
// short-lived agent turn along with the proposal, the diff and the checks, and the
// verdict it comes back with is trusted the same way a human's --by is trusted — phase 0
// has no authentication either way (see docs/decisions/0003).
export async function ruleByAgent(projectDir, name, { persona }) {
  projectDir = resolve(projectDir);
  assertCleanTree(projectDir, "rule");
  const { branch, proposalPath, proposalText, gate, g, config } = openGate(projectDir, name);
  const by = `agent:${persona}`;
  // Persona agents cannot rule gates they do not hold: unlike a human, an agent is never
  // allowed to act as the escalation target, so only an exact match on `holder` passes.
  if (g.holder !== by) throw new Error(`${by} is not a holder of ${gate} (allowed: ${g.holder})`);

  const brief = readPersonaBrief(projectDir, persona);
  const tierMatch = proposalText.match(/^tier:\s*(\S+)/m);
  const tier = tierMatch ? tierMatch[1] : config.policy.default_tier;

  // Mandatory escalation happens before the persona is ever asked: a HIGH/CRITICAL item,
  // or a persona whose brief always defers on this gate, never gets a chance to rule.
  const mandatoryReason = ["HIGH", "CRITICAL"].includes(tier) ? `tier ${tier}`
    : brief.includes("always escalate") ? `persona brief for ${persona} says always escalate`
      : null;

  if (mandatoryReason) {
    const rationale = `mandatory escalation: ${mandatoryReason}`;
    writeEscalation(projectDir, { name, gate, by, escalateTo: g.escalate_to, rationale });
    buildSite(projectDir);
    return { verdict: "escalate", rationale, escalated: true };
  }

  const prompt = await buildPersonaPrompt(projectDir, name, persona);
  const result = await runAgent({ cwd: projectDir, prompt, stage: "rule", maxTurns: 12 });
  const { verdict, rationale, conditions } = parseVerdict(result.text);

  if (verdict === "escalate") {
    writeEscalation(projectDir, { name, gate, by, escalateTo: g.escalate_to, rationale });
    buildSite(projectDir);
    return { verdict, rationale, escalated: true };
  }

  // The ruling has to land in the proposal page's own commit, not a follow-up one, so
  // it is appended and written before `commitRuling` stages and commits.
  writeText(proposalPath, appendRulingSection(proposalText, { verdict, by, rationale, conditions }));
  commitRuling(projectDir, { name, branch, gate, verdict, by, heldBy: "agent", rationale, conditions, proposalPath, proposalAppended: true });
  buildSite(projectDir);
  return { verdict, rationale, escalated: false };
}

// `sdlc rule --pending`: every open proposal branch whose gate is agent-held, ruled in
// the order its branch was created, with no human invocation needed per proposal.
export async function rulePending(projectDir) {
  projectDir = resolve(projectDir);
  const branches = gitOk(["for-each-ref", "--format=%(refname:short)", "--sort=creatordate", "refs/heads/proposal/*"], projectDir)
    ? git(["for-each-ref", "--format=%(refname:short)", "--sort=creatordate", "refs/heads/proposal/*"], projectDir).split("\n").filter(Boolean)
    : [];
  const results = [];
  for (const branch of branches) {
    const name = branch.slice("proposal/".length);
    // Already ruled: the ruling commit put a gate file on this branch regardless of
    // verdict (approve, return or escalate), so its presence is the "still open" test.
    if (gitOk(["cat-file", "-e", `${branch}:.sdlc/gates/${name}.yaml`], projectDir)) continue;
    let proposalText;
    try { proposalText = git(["show", `${branch}:.sdlc/proposals/${name}.md`], projectDir); } catch { continue; }
    const gateMatch = proposalText.match(/^gate:\s*(\S+)/m);
    if (!gateMatch) continue;
    let configText;
    try { configText = git(["show", `${branch}:.sdlc/config.yaml`], projectDir); } catch { continue; }
    const { config, errors } = parseConfig(configText);
    if (errors.length) continue;
    const g = config.policy.gates[gateMatch[1]];
    if (!g || !g.holder?.startsWith("agent:")) continue;
    const persona = g.holder.slice("agent:".length);
    const r = await ruleByAgent(projectDir, name, { persona });
    results.push({ name, ...r });
    console.log(r.escalated ? `${name}: escalated to ${g.escalate_to}` : `${name}: ${r.verdict} at ${gateMatch[1]}`);
  }
  return results;
}

COMMANDS.rule = async ({ pos, flags }) => {
  if (flags.pending) { await rulePending(process.cwd()); return 0; }
  if (typeof flags.by === "string" && flags.by.startsWith("agent:")) {
    const r = await ruleByAgent(process.cwd(), pos[0], { persona: flags.by.slice("agent:".length) });
    console.log(r.escalated ? `${pos[0]}: escalated (${r.rationale})` : `${pos[0]}: ${r.verdict}`);
    return 0;
  }
  const r = rule(process.cwd(), pos[0], pos[1], { by: flags.by, note: flags.note ?? "" });
  console.log(`${pos[0]}: ${r.verdict} at ${r.gate}`); return 0;
};

import { join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { git, gitOk, assertCleanTree, stagePaths, stageSite } from "../lib/git.mjs";
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

// A literal block scalar's indentation is normally inferred from its first non-blank
// line, which breaks the moment a rationale's own first line starts with whitespace:
// the parser reads that whitespace as part of the declared indentation, then a later
// line indented less than that (including a plain 2-space continuation line) falls
// outside the block and is parsed as a sibling of `rationale:` — invalid YAML. `|2-`
// pins the indentation to exactly the two spaces this function adds and strips the
// scalar's own trailing newline, so the parsed value is always exactly `text` back,
// regardless of what its first line looks like.
function blockScalar(text) {
  return text.split("\n").map((l) => (l ? `  ${l}` : "")).join("\n");
}

// The gate file's body differs by who ruled and how: a human writes a free-text
// `note`; an agent approving or returning writes a `rationale` block plus the
// `conditions` it attached to the verdict; an escalation (mandatory or agent-decided)
// writes a `rationale` and an `escalate_to`, with no conditions. Building the text in
// one place keeps all three shapes consistent (same key order, same block-scalar
// convention) without any caller knowing about another's fields.
//
// `metrics` is what a ruling turn cost — the same three numbers a stage's journal entry
// records, so the state site can total what the pipeline spent on rulings alongside
// what it spent on stages. Every agent path passes it, including a mandatory escalation
// that never asked the persona anything (cost 0, no session); a human ruling has no
// turn to measure and the keys are left out of its file entirely.
function gateFileText({ gate, verdict, by, heldBy, note, rationale, conditions, escalateTo, metrics }) {
  let text = `gate: ${gate}\nverdict: ${verdict}\nby: ${by}\nheld_by: ${heldBy}\n`;
  if (escalateTo !== undefined) text += `escalate_to: ${escalateTo ?? ""}\n`;
  if (rationale !== undefined) {
    text += `rationale: |2-\n${blockScalar(rationale)}\n`;
    if (conditions !== undefined) {
      const list = conditions ?? [];
      text += list.length ? `conditions:\n${list.map((c) => `  - ${JSON.stringify(c)}`).join("\n")}\n` : `conditions: []\n`;
    }
  } else {
    text += `note: ${JSON.stringify(note ?? "")}\n`;
  }
  if (metrics) {
    const { cost = 0, turns = 0, session = "" } = metrics;
    text += `cost: ${cost}\nturns: ${turns}\nsession: ${JSON.stringify(session)}\n`;
  }
  text += `at: ${new Date().toISOString()}\n`;
  return text;
}

// The state site is rebuilt and folded into the commit a ruling just made — the merge
// commit on `main` for an approval, the plain ruling commit otherwise — via `--amend`
// rather than a trailing uncommitted diff or a second commit. Doing it here, after any
// merge, also means an approval's site reflects `main`'s complete gate history: a
// proposal branch built and carried its own site through the merge, cross-branch
// regeneration (each side producing fresh, always-different content) would conflict
// on every concurrent approval.
function commitSite(projectDir) {
  buildSite(projectDir);
  stageSite(projectDir);
  git([...SDLC_AUTHOR, "commit", "-q", "--amend", "--no-edit"], projectDir);
}

// Shared by the human path and the agent-approve/return path: write the gate file,
// append the run record, stage exactly those paths (plus the proposal page when the
// caller already appended a `## Ruling` section to it), commit, merge on approve, and
// fold the rebuilt site into that same commit.
function commitRuling(projectDir, { name, branch, gate, verdict, by, heldBy, note, rationale, conditions, metrics, proposalPath, proposalAppended }) {
  const gatePath = join(".sdlc", "gates", `${name}.yaml`);
  writeText(join(projectDir, gatePath), gateFileText({ gate, verdict, by, heldBy, note, rationale, conditions, metrics }));
  const runPath = appendRun(projectDir, `rule ${name} ${verdict} at ${gate} by ${by} (${heldBy})`);
  const paths = [gatePath, relative(projectDir, runPath)];
  if (proposalAppended) paths.push(relative(projectDir, proposalPath));
  stagePaths(projectDir, paths);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} ${verdict} by ${by}`], projectDir);
  if (verdict === "approve") mergeApproved(projectDir, branch, `merge: ${name} approved at ${gate} by ${by}`);
  commitSite(projectDir);
}

function writeEscalation(projectDir, { name, gate, by, escalateTo, rationale, metrics }) {
  const gatePath = join(".sdlc", "gates", `${name}.yaml`);
  writeText(join(projectDir, gatePath), gateFileText({ gate, verdict: "escalated", by, heldBy: "agent", escalateTo, rationale, metrics }));
  const runPath = appendRun(projectDir, `rule ${name} escalated at ${gate} to ${escalateTo ?? "?"} by ${by}`);
  stagePaths(projectDir, [gatePath, relative(projectDir, runPath)]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} escalated to ${escalateTo ?? "?"}`], projectDir);
  commitSite(projectDir);
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
  // An agent-held gate with nowhere to escalate is a broken policy, not a ruling this
  // agent can be trusted with — checked before the persona brief is even read, since
  // every path below (mandatory escalation, an `escalate` verdict) needs `escalate_to`.
  if (!g.escalate_to) throw new Error(`gate ${gate} has an agent holder but no escalate_to`);

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
    // No persona turn ran, so the ruling cost nothing — recorded as zero rather than
    // omitted, so every agent-held gate file carries the same three keys.
    writeEscalation(projectDir, { name, gate, by, escalateTo: g.escalate_to, rationale, metrics: { cost: 0, turns: 0, session: "" } });
    return { verdict: "escalate", rationale, escalated: true };
  }

  const prompt = await buildPersonaPrompt(projectDir, name, persona, { tier });
  const result = await runAgent({ cwd: projectDir, prompt, stage: "rule", maxTurns: 12 });
  // A ruling is a read-only turn: the agent is asked for a verdict, not permitted to
  // change the project. Checked before the verdict is even parsed, so a verdict text
  // that looks fine cannot mask files the turn left behind — and left in place (not
  // reset) so the tampering is still there for a person to see.
  assertCleanTree(projectDir, "rule: the ruling agent modified the working tree");
  const { verdict, rationale, conditions } = parseVerdict(result.text);
  const metrics = { cost: result.cost, turns: result.turns, session: result.sessionId };

  if (verdict === "escalate") {
    writeEscalation(projectDir, { name, gate, by, escalateTo: g.escalate_to, rationale, metrics });
    return { verdict, rationale, escalated: true };
  }

  // The ruling has to land in the proposal page's own commit, not a follow-up one, so
  // it is appended and written before `commitRuling` stages and commits.
  writeText(proposalPath, appendRulingSection(proposalText, { verdict, by, rationale, conditions }));
  commitRuling(projectDir, { name, branch, gate, verdict, by, heldBy: "agent", rationale, conditions, metrics, proposalPath, proposalAppended: true });
  return { verdict, rationale, escalated: false, ...metrics };
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
    // One proposal's agent turn misbehaving (a bad verdict block, an escalation with no
    // target) must not take the rest of the batch down with it: the failure is recorded
    // — printed here and written to the run record — and the loop moves on to the next
    // branch rather than throwing out of `rulePending` entirely. A *tampered working
    // tree* is different: `git checkout -q main` succeeds even with uncommitted changes
    // present whenever the file is identical on both branches, so switching branches
    // here would carry the tampering onto `main` silently, and every later proposal in
    // the batch would then fail its own `assertCleanTree` with a message that points at
    // the wrong ruling. So when the tree is left dirty, the batch stops instead: no
    // checkout, no run-record commit (there is nothing clean to commit it onto), just
    // the failure already pushed above plus a `stopped` marker on the returned summary,
    // leaving the caller on the offending proposal branch with the tampering visible.
    try {
      const r = await ruleByAgent(projectDir, name, { persona });
      results.push({ name, ...r });
      console.log(r.escalated ? `${name}: escalated to ${g.escalate_to}` : `${name}: ${r.verdict} at ${gateMatch[1]}`);
    } catch (e) {
      results.push({ name, failed: true, error: e.message });
      console.log(`${name}: failed — ${e.message}`);
      if (git(["status", "--porcelain"], projectDir)) {
        const stopped = `${name}: working tree dirty after the ruling agent's turn; inspect and clean before continuing`;
        console.log(stopped);
        results.stopped = stopped;
        return results;
      }
      gitOk(["checkout", "-q", "main"], projectDir);
      try {
        const runPath = appendRun(projectDir, `rule --pending ${name}: failed — ${e.message}`);
        stagePaths(projectDir, [relative(projectDir, runPath)]);
        if (git(["diff", "--cached", "--name-only"], projectDir)) {
          git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(--pending): ${name} failed`], projectDir);
        }
      } catch { /* the failure is already in `results` and printed; recording it is best-effort */ }
    }
  }
  return results;
}

COMMANDS.rule = async ({ pos, flags }) => {
  if (flags.pending) { await rulePending(process.cwd()); return 0; }
  if (typeof flags.by === "string" && flags.by.startsWith("agent:")) {
    // An agent rules through its own turn, not a typed verdict: a verdict positional
    // alongside an `agent:` holder is refused rather than quietly dispatched to the
    // agent path with the typed verdict discarded.
    if (pos[1]) throw new Error("an agent holder rules through its own turn; omit the verdict, or rule as a human role");
    const r = await ruleByAgent(process.cwd(), pos[0], { persona: flags.by.slice("agent:".length) });
    console.log(r.escalated ? `${pos[0]}: escalated (${r.rationale})` : `${pos[0]}: ${r.verdict}`);
    return 0;
  }
  const r = rule(process.cwd(), pos[0], pos[1], { by: flags.by, note: flags.note ?? "" });
  console.log(`${pos[0]}: ${r.verdict} at ${r.gate}`); return 0;
};

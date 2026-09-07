import { join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { git, gitOk, assertCleanTree, stagePaths, stageSite, currentBranch, SDLC_AUTHOR } from "../lib/git.mjs";
import { readText, writeText } from "../lib/fsx.mjs";
import { loadConfig, parseConfig } from "../config/load.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { buildPersonaPrompt, parseVerdict, readPersonaBrief } from "../runner/persona.mjs";
import { runAgent, endedBecause, turnsFor, DEFAULT_MAX_TURNS } from "../runner/executor.mjs";
import { buildSite } from "./status.mjs";
import { CONDITION_GRAMMAR, unparsedConditions } from "../spec/criteria.mjs";
import { COMMANDS } from "../cli.mjs";

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
function gateFileText({ gate, verdict, by, heldBy, note, rationale, conditions, unparsed, escalateTo, metrics }) {
  let text = `gate: ${gate}\nverdict: ${verdict}\nby: ${by}\nheld_by: ${heldBy}\n`;
  if (escalateTo !== undefined) text += `escalate_to: ${escalateTo ?? ""}\n`;
  if (rationale !== undefined) {
    text += `rationale: |2-\n${blockScalar(rationale)}\n`;
    if (conditions !== undefined) {
      const list = conditions ?? [];
      text += list.length ? `conditions:\n${list.map((c) => `  - ${JSON.stringify(c)}`).join("\n")}\n` : `conditions: []\n`;
      // Written only when there are some. A gate file carrying this key is a ruling whose
      // conditions the ratification grammar could not read even after the persona was
      // asked again, and `ratify` refuses to act on it — the lines are kept verbatim so a
      // person can see exactly what was meant and correct it in place.
      if (unparsed?.length) text += `unparsed_conditions:\n${unparsed.map((c) => `  - ${JSON.stringify(c)}`).join("\n")}\n`;
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

// The state site is a tracked artifact of `main` and of nothing else: every page is
// regenerated whole from the whole project, so a site carried on a proposal branch
// conflicts with every other open proposal's on the way in. Stages that hold a gate
// therefore build no site (`src/runner/finish-stage.mjs`), and rulings own it.
//
// An approval has already merged onto `main` by the time this runs, so the rebuilt site
// is folded into that merge commit with `--amend` rather than trailing behind it as a
// second commit or an uncommitted diff. The site it produces reflects `main`'s complete
// gate history, this ruling included.
function amendSiteOntoMergeCommit(projectDir) {
  buildSite(projectDir);
  stageSite(projectDir);
  git([...SDLC_AUTHOR, "commit", "-q", "--amend", "--no-edit"], projectDir);
}

// A return or an escalation leaves its ruling commit on the proposal branch, where it
// belongs — nothing about it has been accepted. The site still gets regenerated, on
// `main`, so the pages stay current with whatever `main` actually holds; when that turns
// out to be unchanged, nothing is committed. The caller is put back on the branch it was
// on, so a returned proposal is still checked out for whoever has to act on it.
function regenerateSiteOnMain(projectDir, reason) {
  const branch = currentBranch(projectDir);
  if (branch !== "main") git(["checkout", "-q", "main"], projectDir);
  try {
    buildSite(projectDir);
    stageSite(projectDir);
    if (git(["diff", "--cached", "--name-only"], projectDir)) {
      git([...SDLC_AUTHOR, "commit", "-q", "-m", `chore(site): regenerate after ${reason}`], projectDir);
    }
  } finally {
    if (branch !== "main") git(["checkout", "-q", branch], projectDir);
  }
}

// Shared by the human path and the agent-approve/return path: write the gate file,
// append the run record, stage exactly those paths (plus the proposal page when the
// caller already appended a `## Ruling` section to it), commit, merge on approve, and
// fold the rebuilt site into that same commit.
function commitRuling(projectDir, { name, branch, gate, verdict, by, heldBy, note, rationale, conditions, unparsed, metrics, proposalPath, proposalAppended }) {
  const gatePath = join(".sdlc", "gates", `${name}.yaml`);
  writeText(join(projectDir, gatePath), gateFileText({ gate, verdict, by, heldBy, note, rationale, conditions, unparsed, metrics }));
  const runPath = appendRun(projectDir, `rule ${name} ${verdict} at ${gate} by ${by} (${heldBy})`);
  const paths = [gatePath, relative(projectDir, runPath)];
  if (proposalAppended) paths.push(relative(projectDir, proposalPath));
  stagePaths(projectDir, paths);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} ${verdict} by ${by}`], projectDir);
  if (verdict === "approve") {
    mergeApproved(projectDir, branch, `merge: ${name} approved at ${gate} by ${by}`);
    amendSiteOntoMergeCommit(projectDir);
  } else {
    regenerateSiteOnMain(projectDir, `${name} ${verdict}`);
  }
}

function writeEscalation(projectDir, { name, gate, by, escalateTo, rationale, metrics }) {
  const gatePath = join(".sdlc", "gates", `${name}.yaml`);
  writeText(join(projectDir, gatePath), gateFileText({ gate, verdict: "escalated", by, heldBy: "agent", escalateTo, rationale, metrics }));
  const runPath = appendRun(projectDir, `rule ${name} escalated at ${gate} to ${escalateTo ?? "?"} by ${by}`);
  stagePaths(projectDir, [gatePath, relative(projectDir, runPath)]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} escalated to ${escalateTo ?? "?"}`], projectDir);
  regenerateSiteOnMain(projectDir, `${name} escalated`);
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

// What to say a ruling turn failed for. The turn's own text when it has any; otherwise
// the CLI's account of how the session ended (`endedBecause` — "hit the turn cap", say),
// and only then a fixed line, so a failure is never reported as an empty string.
function rulingFailure(result) {
  if (result.text?.trim()) return result.text.trim();
  const ended = endedBecause(result.raw);
  return ended ? `the ruling turn reported failure with no output; the session ${ended}`
    : "the ruling turn reported failure with no output";
}

// How many turns a ruling turn may take. Most rulings read a proposal and a diff and
// answer, so a dozen turns is plenty and keeps a runaway persona cheap. A G1 ruling is
// different in kind: it has to read a whole domain file and rule on every criterion in
// it, one condition line each, and a domain of fifty criteria whose citations the
// persona wants to check does not fit in twelve turns — the ruling then fails at the
// cap having written nothing. It runs with the stage default instead. Either ceiling is
// overridden by `policy.budgets.rule`, read the same way a stage's budget is.
export function rulingTurns(config, gate) {
  return turnsFor(config, "rule", gate === "G1" ? DEFAULT_MAX_TURNS : 12);
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
    // Matched case-insensitively: a brief is prose, and the phrase reads as naturally at
    // the start of a bullet ("Always escalate a platform-article change") as inside one.
    : brief.toLowerCase().includes("always escalate") ? `persona brief for ${persona} says always escalate`
      : null;

  if (mandatoryReason) {
    const rationale = `mandatory escalation: ${mandatoryReason}`;
    // No persona turn ran, so the ruling cost nothing — recorded as zero rather than
    // omitted, so every agent-held gate file carries the same three keys.
    writeEscalation(projectDir, { name, gate, by, escalateTo: g.escalate_to, rationale, metrics: { cost: 0, turns: 0, session: "" } });
    return { verdict: "escalate", rationale, escalated: true };
  }

  const prompt = await buildPersonaPrompt(projectDir, name, persona, { tier, gate });
  // A ruling reads and answers; it never writes. The tool list says so up front rather
  // than relying on the clean-tree check below to catch a turn that wrote anyway: the
  // read-only git commands are there because a persona legitimately wants to look
  // further into the branch than the diff the prompt already carries.
  //
  // A ruling turn is read-only and cheap, and a failed one is often transient — a
  // dropped connection, a rate limit — so one automatic retry is attempted before the
  // whole ruling is abandoned. Only one: a turn that fails twice is failing for a reason
  // retrying will not fix, and `rule --pending` running a batch must not turn one broken
  // proposal into an unbounded loop.
  const runRuling = (text) => runAgent({ cwd: projectDir, prompt: text, stage: "rule", maxTurns: rulingTurns(config, gate),
    allowedTools: ["Read", "Grep", "Glob", "Bash(git diff*)", "Bash(git log*)", "Bash(git status*)"] });

  // One turn, its failure retried once, and the verdict read out of whatever came back.
  // The clean-tree check sits inside this rather than after it: a ruling is a read-only
  // turn, and a verdict text that looks fine must not be allowed to mask files the turn
  // left behind. The edit is left in place (not reset) so the tampering stays visible.
  const askOnce = async (text) => {
    let result = await runRuling(text);
    if (!result.ok) {
      console.warn(`warning: the ruling turn for ${name} failed (${rulingFailure(result)}); retrying once`);
      result = await runRuling(text);
    }
    // A turn that reports failure has no verdict to read, and its own text is the only
    // account of why — except when it has no text at all, which is exactly when a person
    // most needs one, so the CLI's own account of how the session ended stands in.
    // Checked before `parseVerdict`, whose "no verdict block in persona reply" would
    // otherwise be the error a person sees for what is actually a failed session.
    if (!result.ok) throw new Error(`ruling agent turn failed after one retry: ${rulingFailure(result)}`);
    assertCleanTree(projectDir, "rule: the ruling agent modified the working tree");
    return { ...parseVerdict(result.text), metrics: { cost: result.cost, turns: result.turns, session: result.sessionId } };
  };

  let { verdict, rationale, conditions, metrics } = await askOnce(prompt);

  // At G1 a condition is not commentary, it is an instruction `ratify` will execute
  // against the domain file, so a line the ratification grammar cannot read is a silently
  // dropped ruling on a criterion. The persona is asked again, once, with its own
  // unreadable lines quoted back and the grammar restated — which is the whole fix in the
  // ordinary case, since these are formatting slips rather than disagreements. Anything
  // still unreadable after that is written to the gate file under `unparsed_conditions`
  // and the ruling proceeds: the verdict was reached and the reasoning is worth keeping,
  // and `ratify` refuses to act on that gate file until a person fixes the lines.
  let unparsed = gate === "G1" && verdict !== "escalate" ? unparsedConditions(conditions) : [];
  if (unparsed.length) {
    const again = [
      prompt,
      "",
      "## Your previous reply had conditions I could not read",
      "",
      `You ruled ${verdict}. These condition lines do not match the ratification grammar, so nothing`,
      "would be applied for them:",
      "",
      ...unparsed.map((c) => `- ${JSON.stringify(c)}`),
      "",
      CONDITION_GRAMMAR,
      "",
      "Rule again. Keep the conditions that were fine exactly as they were, rewrite these in the",
      "grammar above, and finish with the JSON block as before.",
    ].join("\n");
    ({ verdict, rationale, conditions, metrics } = await askOnce(again));
    unparsed = verdict === "escalate" ? [] : unparsedConditions(conditions);
    if (unparsed.length) console.warn(`warning: ${name}: ${unparsed.length} condition line(s) still unreadable after one re-prompt; recorded as unparsed_conditions`);
  }

  if (verdict === "escalate") {
    writeEscalation(projectDir, { name, gate, by, escalateTo: g.escalate_to, rationale, metrics });
    return { verdict, rationale, escalated: true };
  }

  // The ruling has to land in the proposal page's own commit, not a follow-up one, so
  // it is appended and written before `commitRuling` stages and commits.
  writeText(proposalPath, appendRulingSection(proposalText, { verdict, by, rationale, conditions }));
  commitRuling(projectDir, { name, branch, gate, verdict, by, heldBy: "agent", rationale, conditions, unparsed, metrics, proposalPath, proposalAppended: true });
  return { verdict, rationale, unparsed, escalated: false, ...metrics };
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

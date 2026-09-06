import { join, relative, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { git, assertCleanTree, stageAll } from "../lib/git.mjs";
import { writeText } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { stageFor, skillText } from "../stages/registry.mjs";
import { materialise, collect } from "../runner/workspace.mjs";
import { runAgent } from "../runner/executor.mjs";
import { writeRunState } from "../runner/run-state.mjs";
import { writeJournal } from "../runner/journal.mjs";
import { finishStage, checkProposalNotOpen, commitProposalStillOpen } from "../runner/finish-stage.mjs";
import { COMMANDS } from "../cli.mjs";

const SDLC_AUTHOR = ["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost"];

// `config.policy.budgets[<stage>]` is documented as a token count, but `runAgent`'s
// `maxTurns` wants a turn count and there is no token-to-turn conversion yet (that is
// its own later task). A configured value under 1000 is small enough to read as a turn
// count already — a token budget for a whole stage would run into the thousands — so
// it is used directly, clamped to 200; anything at or above 1000 is a token count we
// cannot yet translate, so it falls back to the same default of 40 turns as no budget
// at all.
// Warned names, so a run that calls `turnsFor` more than once for the same stage says
// this once rather than once per call.
const warnedBudgets = new Set();

export function turnsFor(config, name) {
  const budget = config.policy?.budgets?.[name];
  if (budget && budget < 1000) return Math.min(budget, 200);
  // A token-sized budget is configured, understood, and then ignored. Saying so out
  // loud is the difference between "this stage is capped where I set it" and the truth,
  // which is that it is capped at the default.
  if (budget && !warnedBudgets.has(name)) {
    warnedBudgets.add(name);
    console.warn(`warning: policy.budgets.${name} is ${budget}, which reads as a token budget; there is no token-to-turn conversion yet, so ${name} runs with the default of 40 turns`);
  }
  return 40;
}

// An agent turn can come back having failed — an error result from the CLI, the turn
// limit reached — and what it says about that is the only account of it there is.
// Running post-checks on a turn that already reported failure would replace that
// account with a second, less informative one ("app/PROBE.md is missing"), so the run
// stops here and records the turn's own text the same way a post-check failure is
// recorded: a journal entry and a run-record line, committed on their own, with
// whatever the session left in the working tree untouched for a person to look at.
function agentTurnFailed(projectDir, stage, r) {
  const reason = r.text?.trim() ? r.text : "the agent turn reported failure with no output";
  const journal = writeJournal(projectDir, {
    stage: stage.name,
    title: `${stage.name}: agent turn failed`,
    body: reason,
    metrics: { cost: r.cost, turns: r.turns, session: r.sessionId },
  });
  const runPath = appendRun(projectDir, `run ${stage.name}: agent turn failed`);
  stageAll(projectDir, [relative(projectDir, journal), relative(projectDir, runPath)]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `stage(${stage.name}): agent turn failed`], projectDir);
  return { ok: false, journal, messages: [reason] };
}

export async function runStage(projectDir, name, { slice, domain, dryRun = false, again = false } = {}) {
  projectDir = resolve(projectDir);
  assertCleanTree(projectDir, "run");
  const stage = stageFor(name);
  if (!stage.implemented) throw new Error(`stage ${name} is not implemented yet`);

  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);
  const ctx = { slice, domain, config };

  const pre = stage.preChecks(projectDir, ctx);
  const preFail = pre.filter((r) => !r.ok);
  if (preFail.length) {
    // The pre-check failure itself has to land in the run record on disk, same as any
    // other run outcome — otherwise the next `sdlc run` dies at `assertCleanTree` on the
    // uncommitted record this one left behind.
    const runPath = appendRun(projectDir, `run ${name}: pre-checks failed`);
    stageAll(projectDir, [relative(projectDir, runPath)]);
    git([...SDLC_AUTHOR, "commit", "-q", "-m", `run(${name}): pre-checks failed`], projectDir);
    return { ok: false, messages: preFail.flatMap((r) => r.messages) };
  }

  // `again` is accepted here only for CLI symmetry with `resume --again`; it does not
  // change anything below — `resume` is the one place a re-run decision gets made.
  void again;

  const openProposal = checkProposalNotOpen(projectDir, stage, ctx);
  if (openProposal) return commitProposalStillOpen(projectDir, name, openProposal);

  const ws = materialise(projectDir, stage.workspace);
  try {
    const skillDir = mkdtempSync(join(tmpdir(), `sdlc-skill-${name}-`));
    try {
      // The skill text an agent turn reads is stage- and run-specific, so it is written
      // to its own scratch file rather than reused from disk.
      const skillPath = join(skillDir, "SKILL.md");
      writeText(skillPath, skillText(name));

      const prompt = stage.prompt(ctx);
      if (dryRun) {
        console.log(prompt);
        console.log(`skill: ${skillPath}`);
        return { ok: true, dryRun: true };
      }

      // Written only once the dry-run return above is behind us: a dry run makes no
      // change of any kind, so nothing should exist for `sdlc resume` to find.
      const state = { stage: name, ctx: { slice, domain }, startedAt: new Date().toISOString(), phase: "agent" };
      writeRunState(projectDir, state);

      const r = await runAgent({ cwd: ws.dir, prompt, systemPromptFile: skillPath, stage: name, maxTurns: turnsFor(config, name) });
      if (!r.ok) return agentTurnFailed(projectDir, stage, r);

      if (ws.mode !== "project") collect(projectDir, ws.dir, stage.collect);

      return await finishStage(projectDir, stage, ctx, r);
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  } finally {
    ws.cleanup();
  }
}

COMMANDS.run = async ({ pos, flags }) => {
  const r = await runStage(process.cwd(), pos[0], {
    slice: flags.slice !== undefined ? Number(flags.slice) : undefined,
    domain: flags.domain,
    dryRun: !!flags["dry-run"],
    again: !!flags.again,
  });
  if (r.dryRun) return 0;
  if (!r.ok) { console.error(`run ${pos[0]}: failed\n  ${(r.messages ?? []).join("\n  ")}`); return 1; }
  console.log(`run ${pos[0]}: ok${r.proposal ? ` (opened ${r.proposal.branch})` : ""}`);
  return 0;
};

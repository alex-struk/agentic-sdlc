import { join, relative, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { git, assertCleanTree, assertOnMain, stageAll, SDLC_AUTHOR } from "../lib/git.mjs";
import { writeText } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { stageFor, skillText } from "../stages/registry.mjs";
import { materialise, collect } from "../runner/workspace.mjs";
import { runAgent, endedBecause, turnsFor, writeMcpConfig } from "../runner/executor.mjs";
import { writeRunState } from "../runner/run-state.mjs";
import { writeJournal } from "../runner/journal.mjs";
import { finishStage, finishDeterministicNoOp, checkProposalNotOpen, commitProposalStillOpen } from "../runner/finish-stage.mjs";
import { COMMANDS } from "../cli.mjs";

// Re-exported for the tests and any caller that reaches it by way of `run`.
export { turnsFor };

// An agent turn can come back having failed — an error result from the CLI, the turn
// limit reached — and what it says about that is the only account of it there is.
// Running post-checks on a turn that already reported failure would replace that
// account with a second, less informative one ("app/PROBE.md is missing"), so the run
// stops here and records the turn's own text the same way a post-check failure is
// recorded: a journal entry and a run-record line, committed on their own, with
// whatever the session left in the working tree untouched for a person to look at.
function agentTurnFailed(projectDir, stage, r) {
  // `endedBecause` reads the CLI's own `subtype` rather than comparing `num_turns`
  // against the cap: a session that reports the cap's worth of turns may have finished
  // normally, and one cut short may report fewer, so the count is not evidence either
  // way. The subtype is.
  const ended = endedBecause(r.raw);
  const reason = r.text?.trim() ? r.text
    : ended ? `the agent turn reported failure with no output; the session ${ended}`
      : "the agent turn reported failure with no output";
  const body = ended && r.text?.trim() ? `${reason}\n\nThe session ${ended}.` : reason;
  const journal = writeJournal(projectDir, {
    stage: stage.name,
    title: `${stage.name}: agent turn failed`,
    body,
    metrics: { cost: r.cost, turns: r.turns, session: r.sessionId },
  });
  const runPath = appendRun(projectDir, `run ${stage.name}: agent turn failed`);
  stageAll(projectDir, [relative(projectDir, journal), relative(projectDir, runPath)]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `stage(${stage.name}): agent turn failed`], projectDir);
  return { ok: false, journal, messages: [reason] };
}

// A stage may have one more thing to do once its own work is committed: `ratify`'s
// closing loop opens a G1 proposal over whatever it could not mint (see its `followUp` in
// `src/stages/registry.mjs`). Run after the commit has landed on `main` so the proposal
// branches off a `main` that already holds this run's work, and only on success — there
// is nothing to follow up on a run that failed. A stage that declares no `followUp`, and
// a `followUp` that decides there is nothing to ask, both leave the result untouched.
function followUp(projectDir, stage, ctx, result) {
  if (!stage.followUp) return result;
  const opened = stage.followUp(projectDir, ctx);
  if (!opened) return result;
  return { ...result, proposal: opened };
}

export async function runStage(projectDir, name, { slice, domain, target, stale = false, dryRun = false, again = false, revise = false } = {}) {
  projectDir = resolve(projectDir);
  assertCleanTree(projectDir, "run");
  assertOnMain(projectDir, "run");
  const stage = stageFor(name);
  if (!stage.implemented) throw new Error(`stage ${name} is not implemented yet`);

  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);
  // `revise` and `dryRun` ride on `ctx` (rather than being passed as separate arguments)
  // so a stage's own pre-checks — `archaeology`'s `checkRevisionSource` in particular —
  // can tell a dry run from a real one without `runStage` having to special-case any one
  // stage's side effects itself.
  const ctx = { slice, domain, target, stale, config, revise, dryRun };
  // `stage.workspace` may be a plain string or a function of `config` — resolved once,
  // here, so every later use (`materialise`, the run-state a crashed session leaves for
  // `resume` to read, the dry-run print below) sees the same resolved mode rather than
  // each re-deriving it from a possibly-impure function.
  const wsMode = typeof stage.workspace === "function" ? stage.workspace(config) : stage.workspace;

  const pre = stage.preChecks(projectDir, ctx);
  // A pre-check can pass and still have something to say — a turn ceiling that looks too
  // low for the work in front of it, say. Printed before anything is spent, so the person
  // running the stage sees it while there is still time to change the setting.
  for (const r of pre) for (const w of r.warnings ?? []) console.warn(`warning: ${w}`);
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

  // `agent: false` (`ratify` and `calibrate`) means there is no agent turn at all: the
  // stage's work is mechanical and deterministic, so `stage.execute(projectDir, ctx)` runs in
  // process, in the project's own working tree, in place of materialising a workspace and
  // spawning `runAgent`. Nothing is spawned, so there is no crash mid-turn for `sdlc
  // resume` to pick up and `.sdlc/run-state.json` is never written for this path.
  // `finishStage` is still the one place that decides whether a run's output is worth a
  // journal entry and a commit — reached here with a synthesised agent result standing in
  // for a real one. When `execute` reports it had no work of its own to do, the run
  // finishes through `finishDeterministicNoOp` instead: unlike an agent turn, running
  // `execute` twice against unchanged input is expected to change nothing, so there is no
  // turn to journal — but the post-checks still run and whatever `execute` regenerated on
  // its way past (the criteria index and the spec page, derived from every domain file in
  // the project rather than just this run's own) is still committed.
  if (stage.agent === false) {
    if (dryRun) {
      console.log(`stage ${name}: agent: false — runs stage.execute(projectDir, ctx) directly, no agent session`);
      return { ok: true, dryRun: true };
    }
    // Awaited: `execute` is synchronous for `ratify` and returns a promise for
    // `calibrate`, which has to start the oracle and run a suite before it has anything
    // to report. Awaiting a plain object is the same object back.
    const { text, changed } = await stage.execute(projectDir, ctx);
    // `text` is carried on the no-op return too — there is no journal entry for this
    // path, so this is the only place `execute`'s account of "already ratified" reaches
    // anyone; `COMMANDS.run` prints it below.
    const finished = (!changed || changed.length === 0)
      ? finishDeterministicNoOp(projectDir, stage, ctx, text)
      : await finishStage(projectDir, stage, ctx, { text, cost: 0, turns: 0, sessionId: "deterministic" });
    return finished.ok ? followUp(projectDir, stage, ctx, finished) : finished;
  }

  // A revise run's own pre-check (`checkRevisionSource`/`checkDeriveTestsRevisionSource`
  // in `registry.mjs`) stashes the returned branch's own commit on `ctx.revision` before
  // this runs. A stage that also declares `revisionOverlayPaths` (only `derive-tests`
  // today) gets those paths overlaid into its workspace from that commit, on top of the
  // ordinary `HEAD` archive every run builds — the returned branch's own version of just
  // the domain under revision, not a whole workspace built from a commit that may be well
  // behind `main` by now. A stage with no `ctx.revision` or no `revisionOverlayPaths` sees
  // no change: `materialise` archives from `HEAD` alone, as it always has.
  //
  // A stage that also declares `revisionOverlayMerge` names, among those same paths, which
  // ones are shared by every domain rather than owned by the one under revision —
  // `derive-tests`'s own `tests/acceptance/not-testable.yaml` — so `materialise` merges
  // them instead of letting the returned branch's content replace `HEAD`'s wholesale.
  const overlay = ctx.revision?.branchCommit && stage.revisionOverlayPaths
    ? {
      ref: ctx.revision.branchCommit,
      paths: stage.revisionOverlayPaths(ctx.domain),
      merge: stage.revisionOverlayMerge?.(projectDir, ctx.domain),
    }
    : undefined;
  const ws = materialise(projectDir, wsMode, overlay ? { overlay } : {});
  try {
    const skillDir = mkdtempSync(join(tmpdir(), `sdlc-skill-${name}-`));
    try {
      // The skill text an agent turn reads is stage- and run-specific, so it is written
      // to its own scratch file rather than reused from disk.
      const skillPath = join(skillDir, "SKILL.md");
      writeText(skillPath, skillText(name));

      const prompt = stage.prompt(ctx);
      const mcpServers = stage.mcp?.(ctx, config);
      const envVars = stage.env?.(ctx, config);
      if (dryRun) {
        console.log(prompt);
        console.log(`skill: ${skillPath}`);
        console.log(`workspace: ${wsMode}`);
        // `prepare` writes real files, so it does not run on a dry run at all — this is
        // the only account of it a dry run gives, and only for a stage that has one.
        if (stage.prepare) console.log("prepare: skipped on dry run");
        if (mcpServers) console.log(`mcp: ${Object.keys(mcpServers).join(", ")}`);
        // Names only, never values: a dry run is printed to a terminal (or captured in a
        // log) and `env` exists precisely to carry things like API keys into the session.
        if (envVars && Object.keys(envVars).length) console.log(`env: ${Object.keys(envVars).join(", ")}`);
        return { ok: true, dryRun: true };
      }

      // `stage.prepare` writes generated files into the workspace before the agent turn
      // sees it — the derive-tests and bind-adapter stages this runner now serves both
      // need something already sitting in the workspace for the agent to work from. It
      // runs after the dry-run return above (a dry run must write nothing) and before
      // `.sdlc/run-state.json` exists, so a failure here is reported exactly like a
      // failing pre-check: there is no agent turn to resume, so nothing agent-shaped
      // should be recorded.
      if (stage.prepare) {
        try {
          stage.prepare(ws.dir, ctx, config);
        } catch (e) {
          const runPath = appendRun(projectDir, `run ${name}: prepare failed`);
          stageAll(projectDir, [relative(projectDir, runPath)]);
          git([...SDLC_AUTHOR, "commit", "-q", "-m", `run(${name}): prepare failed`], projectDir);
          return { ok: false, messages: [e.message] };
        }
      }

      // `stage.mcp` names MCP servers the agent turn is allowed to reach — written
      // (`writeMcpConfig`) to its own scratch file, removed with the rest of `skillDir`
      // in the `finally` below, rather than to a project path, since it is run-specific
      // and never any stage's own output. `--strict-mcp-config` (always passed) means
      // this file is the *only* source of servers for the session; a stage that
      // declares none passes no `mcpConfig` at all, and the session reaches none.
      const mcpConfig = writeMcpConfig(skillDir, mcpServers);

      // Written only once the dry-run return above is behind us: a dry run makes no
      // change of any kind, so nothing should exist for `sdlc resume` to find.
      const state = { stage: name, ctx: { slice, domain, target, stale, revise }, startedAt: new Date().toISOString(), phase: "agent" };
      writeRunState(projectDir, state);

      const r = await runAgent({
        cwd: ws.dir, prompt, systemPromptFile: skillPath, stage: name, maxTurns: turnsFor(config, name),
        mcpConfig, allowedTools: stage.allowedTools, env: envVars,
      });
      if (!r.ok) return agentTurnFailed(projectDir, stage, r);

      // `stage.collect` may be a plain array or, like `stage.workspace` above, a function
      // — `derive-tests` narrows it on a revise run to the same paths its workspace
      // overlaid (plus `tests/generated`, always regenerated from `HEAD`'s own contract by
      // `prepare`), so a revise run's writeback can never carry another domain's tests or
      // the shared bookkeeping files back out of the workspace, even before
      // `derive-tests-scope` gets a chance to judge the tree.
      const collectPaths = typeof stage.collect === "function" ? stage.collect(ctx) : stage.collect;
      if (ws.mode !== "project") collect(projectDir, ws.dir, collectPaths);

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
    target: flags.target,
    stale: !!flags.stale,
    dryRun: !!flags["dry-run"],
    again: !!flags.again,
    revise: !!flags.revise,
  });
  if (r.dryRun) return 0;
  if (!r.ok) { console.error(`run ${pos[0]}: failed\n  ${(r.messages ?? []).join("\n  ")}`); return 1; }
  if (r.text) console.log(r.text);
  console.log(`run ${pos[0]}: ok${r.proposal ? ` (opened ${r.proposal.branch})` : ""}`);
  return 0;
};

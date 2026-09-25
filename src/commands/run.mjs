import { join, relative, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { git, assertCleanTree, assertOnMain, stageAll, SDLC_AUTHOR } from "../lib/git.mjs";
import { writeText } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { stageFor, skillText } from "../stages/registry.mjs";
import { materialise, collect, workspaceScopeNote, workspaceScopeViolations } from "../runner/workspace.mjs";
import { runAgent, endedBecause, preflightAuth, turnsFor, writeMcpConfig } from "../runner/executor.mjs";
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

// How many discarded paths a message names before it stops counting. Long enough that a
// real edit — a file or two, or a directory's worth — is named in full, short enough that
// a session which rewrote a whole tree does not bury the sentence that says what happened.
const DROPPED_SHOWN = 20;

// A turn that produced work the stage has no way to deliver. The agent did what it was
// asked, said so in its journal text, and the paths it wrote are ones the workspace takes
// back from nobody: torn down with the workspace, absent from the branch, and described as
// done by every page downstream. The run stops here and names them.
//
// Recorded the way a post-check failure is — a journal entry carrying the agent's own text
// and this account, plus a run-record line, both committed, with whatever the stage COULD
// deliver left in the working tree for a person to look at. No fix turn: the work is in a
// workspace that is about to be removed and there is nothing in the project to repair.
function workOutsideCollect(projectDir, stage, r, ws, collectPaths, dropped) {
  const shown = dropped.slice(0, DROPPED_SHOWN);
  const more = dropped.length - shown.length;
  const out = collectPaths.length ? collectPaths.join(", ") : "nothing";
  const message = [
    `${stage.name} wrote ${dropped.length} path(s) its workspace does not collect, so the work would have been discarded:`,
    ...shown.map((p) => `  ${p}`),
    more > 0 ? `  … and ${more} more` : null,
    `This stage delivers ${out}; everything else its ${ws.mode} workspace carries is there to be read.`,
    "Nothing was proposed. Either the work belongs to a stage that does deliver those paths, or this stage's collect list is wrong.",
  ].filter(Boolean).join("\n");
  const journal = writeJournal(projectDir, {
    stage: stage.name,
    title: `${stage.name}: work written where it is not collected`,
    body: [r.text, message].filter(Boolean).join("\n\n"),
    metrics: { cost: r.cost, turns: r.turns, session: r.sessionId },
  });
  const runPath = appendRun(projectDir, `run ${stage.name}: work written where it is not collected`);
  stageAll(projectDir, [relative(projectDir, journal), relative(projectDir, runPath)]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `stage(${stage.name}): work written where it is not collected`], projectDir);
  return { ok: false, journal, dropped, messages: [message] };
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

export async function runStage(projectDir, name, { slice, domain, target, stale = false, dryRun = false, again = false, revise = false, skipSuite = false } = {}) {
  projectDir = resolve(projectDir);
  assertCleanTree(projectDir, "run");
  assertOnMain(projectDir, "run");
  const stage = stageFor(name);
  if (!stage.implemented) throw new Error(`stage ${name} is not implemented yet`);

  // The structural half of "a dry run writes nothing": `dryRunHead` is `main`'s commit
  // before anything below runs, and `assertDryRunUntouched` (called at every point this
  // function can return while `dryRun` is true) re-reads it and the tree's status,
  // throwing loudly if either moved. It does not stop a write from happening — nothing
  // outside git itself can — but it means a future change that lets one slip in ahead of
  // a dry-run return breaks a test immediately, in this function, with a message that
  // says what happened, rather than landing a stray commit on a real project's `main`
  // for someone to find later. It cannot see a mutation outside the working tree and the
  // current branch — a branch created or deleted elsewhere in the repository, a file
  // written outside `projectDir` — which is why the writes below are also fixed at their
  // source rather than left for this to catch.
  const dryRunHead = dryRun ? git(["rev-parse", "HEAD"], projectDir) : null;
  function assertDryRunUntouched() {
    assertCleanTree(projectDir, `run ${name} --dry-run`);
    const head = git(["rev-parse", "HEAD"], projectDir);
    if (head !== dryRunHead) {
      throw new Error(`run ${name} --dry-run: HEAD moved from ${dryRunHead} to ${head} — a dry run must commit nothing`);
    }
  }

  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);
  // `revise` and `dryRun` ride on `ctx` (rather than being passed as separate arguments)
  // so a stage's own pre-checks — `archaeology`'s `checkRevisionSource` in particular —
  // can tell a dry run from a real one without `runStage` having to special-case any one
  // stage's side effects itself.
  // `projectDir` rides on `ctx` too, so a stage's `prompt` can read what the project
  // already knows before the workspace exists — `archaeology` reads the re-recovery
  // requests a ratification ruling filed for its domain (`spec/recovery.yaml`) this way.
  // `finishStage` adds the same field before calling `stage.proposal`, which is where
  // every other reader of it already gets it.
  const ctx = { slice, domain, target, stale, config, revise, dryRun, skipSuite, projectDir };
  // `stage.workspace` may be a plain string or a function of `config` — resolved once,
  // here, so every later use (`materialise`, the run-state a crashed session leaves for
  // `resume` to read, the dry-run print below) sees the same resolved mode rather than
  // each re-deriving it from a possibly-impure function.
  const wsMode = typeof stage.workspace === "function" ? stage.workspace(config) : stage.workspace;
  // `stage.collect` may be a plain array or, like `stage.workspace` above, a function —
  // `derive-tests` narrows it on a revise run to the same paths its workspace overlaid
  // (plus `tests/generated`, always regenerated from `HEAD`'s own contract by `prepare`),
  // so a revise run's writeback can never carry another domain's tests or the shared
  // bookkeeping files back out of the workspace. Resolved here, before anything is spent,
  // because the workspace is built around it: what a stage collects is the only part of
  // its workspace that is writable, and everything else the mode carries is sealed
  // against the difference this pair used to be free to express.
  const collectPaths = typeof stage.collect === "function" ? stage.collect(ctx) : (stage.collect ?? []);
  // A stage may add read-only context for one run on top of its mode's standing list. It is
  // how a run that narrows its collect set keeps the rest of the tree in front of the agent:
  // `derive-tests --revise` delivers one domain out of a suite it has to read whole, and the
  // siblings and shared bookkeeping files it must not change come in here.
  const contextPaths = stage.context?.(ctx) ?? [];

  // Checked on every run rather than only in the suite, because the stage that gets this
  // wrong is the one somebody adds later without running the tests. It reads two
  // declarations and touches nothing, so it costs a run that is about to spend an agent
  // turn nothing at all, and it refuses before any of it is spent.
  const scope = workspaceScopeViolations(name, wsMode, collectPaths, contextPaths);
  if (scope.length) throw new Error(scope.join("\n"));

  const pre = stage.preChecks(projectDir, ctx);
  // A pre-check can pass and still have something to say — a turn ceiling that looks too
  // low for the work in front of it, say. Printed before anything is spent, so the person
  // running the stage sees it while there is still time to change the setting.
  for (const r of pre) for (const w of r.warnings ?? []) console.warn(`warning: ${w}`);
  const preFail = pre.filter((r) => !r.ok);
  if (preFail.length) {
    const messages = preFail.flatMap((r) => r.messages);
    // A dry run reports exactly what a real run's pre-check failure reports — the same
    // messages, the same `ok: false` — and nothing else: no run record, no commit. What
    // made this a defect once is that the record below used to be written on every path,
    // dry run included, so three read-only pre-flight checks against a real project left
    // stray commits on its `main`. `assertDryRunUntouched` is the belt this return is
    // already the suspenders for.
    if (dryRun) {
      assertDryRunUntouched();
      return { ok: false, messages };
    }
    // The pre-check failure itself has to land in the run record on disk, same as any
    // other run outcome — otherwise the next `sdlc run` dies at `assertCleanTree` on the
    // uncommitted record this one left behind.
    const runPath = appendRun(projectDir, `run ${name}: pre-checks failed`);
    stageAll(projectDir, [relative(projectDir, runPath)]);
    git([...SDLC_AUTHOR, "commit", "-q", "-m", `run(${name}): pre-checks failed`], projectDir);
    return { ok: false, messages };
  }

  // `again` is accepted here only for CLI symmetry with `resume --again`; it does not
  // change anything below — `resume` is the one place a re-run decision gets made.
  void again;

  const openProposal = checkProposalNotOpen(projectDir, stage, ctx);
  if (openProposal) {
    const r = commitProposalStillOpen(projectDir, name, openProposal, { dryRun });
    if (dryRun) assertDryRunUntouched();
    return r;
  }

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
      assertDryRunUntouched();
      return { ok: true, dryRun: true };
    }
    // Awaited: `execute` is synchronous for `ratify` and returns a promise for
    // `calibrate`, which has to start the oracle and run a suite before it has anything
    // to report. Awaiting a plain object is the same object back.
    // `notPassed` is how a stage reports a run that did its own work correctly and found
    // that the thing it was asked about did not pass — verify's returned, escalated and
    // unbound verdicts. It is carried out to `COMMANDS.run` below, which is what decides
    // the trailer and the exit code; it never changes what the stage wrote, and a stage
    // that leaves it unset is reported exactly as before.
    const { text, changed, notPassed } = await stage.execute(projectDir, ctx);
    // `text` is carried on the no-op return too — there is no journal entry for this
    // path, so this is the only place `execute`'s account of "already ratified" reaches
    // anyone; `COMMANDS.run` prints it below.
    const outcome = (!changed || changed.length === 0)
      ? finishDeterministicNoOp(projectDir, stage, ctx, text)
      : await finishStage(projectDir, stage, ctx, { text, cost: 0, turns: 0, sessionId: "deterministic" });
    const finished = notPassed ? { ...outcome, notPassed } : outcome;
    return finished.ok ? followUp(projectDir, stage, ctx, finished) : finished;
  }

  // A revise run's own pre-check (`checkRevisionSource`/`checkDeriveTestsRevisionSource`
  // in `registry.mjs`) stashes the returned branch's own commit on `ctx.revision` before
  // this runs. A stage that also declares `revisionOverlayPaths`
  // (`derive-tests` and `bind-adapter`) gets those paths overlaid into its workspace from that commit, on top of the
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
      paths: stage.revisionOverlayPaths(ctx),
      merge: stage.revisionOverlayMerge?.(projectDir, ctx.domain),
    }
    : undefined;
  // `materialise` is not called here: building a workspace is itself a write — an
  // ephemeral mode archives the committed tree with `git archive`, and `with-sources`
  // (`ensureSources`) clones the old application's whole repository into
  // `<projectDir>/sources` the first time it runs — and none of it is needed to print
  // what a dry run prints. It is called below, once the dry-run return and the sign-in
  // check are both behind us.
  const skillDir = mkdtempSync(join(tmpdir(), `sdlc-skill-${name}-`));
  try {
    // The skill text an agent turn reads is stage- and run-specific, so it is written
    // to its own scratch file rather than reused from disk.
    const skillPath = join(skillDir, "SKILL.md");
    writeText(skillPath, skillText(name, projectDir));

    // The scope note is appended by the runner rather than written into any stage's own
    // prompt, so it is generated from the same two declarations the runner enforces and
    // one cannot drift from the other. A stage prompt that lists something read out of a
    // read-only path — the criteria a slice claims, read from the plan — is then followed
    // by the statement that the path is not this stage's to change.
    const scopeNote = workspaceScopeNote(wsMode, collectPaths, contextPaths);
    const prompt = [stage.prompt(ctx), scopeNote].filter(Boolean).join("\n\n");
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
      assertDryRunUntouched();
      return { ok: true, dryRun: true };
    }

    // Whether this machine can sign in at all, asked before the stage rather than
    // discovered inside it. A stage session is capable of running for the better part
    // of an hour, and a credential already too old to refresh fails the same way at the
    // end of that as at the start, having spent the entire budget to find out. A
    // one-turn session against the same config home, the same binary and the same flags
    // answers it for a fraction of a cent. What it cannot answer is whether the
    // credential will still be good when a long stage finishes — nothing can, so a
    // failure inside the turn still has to explain itself, which is what the advice
    // carried on `runAgent`'s own result is for.
    //
    // Checked before `materialise` below for the same reason it is checked before
    // everything else that costs something: a session that cannot sign in should not
    // first pay for a workspace — an archive of the committed tree, or a clone of the
    // whole old application — that a failed turn would throw away.
    //
    // Recorded and committed like a failed `prepare`: a run that stopped before its
    // agent turn is a run, and leaving no trace of it is how "nothing happened" gets
    // confused with "nothing was attempted".
    try {
      await preflightAuth();
    } catch (e) {
      const runPath = appendRun(projectDir, `run ${name}: authentication check failed`);
      stageAll(projectDir, [relative(projectDir, runPath)]);
      git([...SDLC_AUTHOR, "commit", "-q", "-m", `run(${name}): authentication check failed`], projectDir);
      return { ok: false, messages: [e.message] };
    }

    const ws = materialise(projectDir, wsMode, { collect: collectPaths, context: contextPaths, ...(overlay ? { overlay } : {}) });
    try {
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
      // in the outer `finally` below, rather than to a project path, since it is
      // run-specific and never any stage's own output. `--strict-mcp-config` (always
      // passed) means this file is the *only* source of servers for the session; a
      // stage that declares none passes no `mcpConfig` at all, and the session reaches
      // none.
      const mcpConfig = writeMcpConfig(skillDir, mcpServers);

      // Written only once the dry-run return above is behind us: a dry run makes no
      // change of any kind, so nothing should exist for `sdlc resume` to find.
      const state = { stage: name, ctx: { slice, domain, target, stale, revise }, startedAt: new Date().toISOString(), phase: "agent" };
      writeRunState(projectDir, state);

      // The workspace as the session first sees it, after `prepare` has generated whatever
      // it generates and before the agent has touched anything. Everything the mode carries
      // that this run will not collect is digested here and read again below.
      ws.seal();

      const r = await runAgent({
        cwd: ws.dir, prompt, systemPromptFile: skillPath, stage: name, maxTurns: turnsFor(config, name, stage.defaultTurns),
        mcpConfig, allowedTools: stage.allowedTools, env: envVars,
      });
      if (!r.ok) return agentTurnFailed(projectDir, stage, r);

      const recollect = () => collect(projectDir, ws.dir, collectPaths);
      if (ws.mode !== "project") recollect();

      // Read after the collect, so whatever the agent produced that this stage CAN deliver
      // is already in the working tree for a person to look at, exactly as a post-check
      // failure leaves it. What is reported here is the rest: work the agent wrote where
      // the stage has no way to deliver it, which would otherwise be dropped by the
      // workspace's teardown while the journal and the proposal page went on describing it
      // as done. The run stops and names the paths.
      const dropped = ws.drift();
      if (dropped.length) return workOutsideCollect(projectDir, stage, r, ws, collectPaths, dropped);

      // `workspaceDir` and `recollect` are what let a post-check failure in a workspace
      // stage earn the same one repair turn an in-place stage gets: the turn runs in the
      // workspace, and its output is collected back before the post-checks are judged
      // again. A stage that worked in the project directory passes neither and repairs
      // there, as it always has.
      return await finishStage(projectDir, stage, ctx, r,
        ws.mode === "project" ? {} : { workspaceDir: ws.dir, recollect });
    } finally {
      ws.cleanup();
    }
  } finally {
    rmSync(skillDir, { recursive: true, force: true });
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
    skipSuite: !!flags["skip-suite"],
  });
  if (r.dryRun) return 0;
  if (!r.ok) { console.error(`run ${pos[0]}: failed\n  ${(r.messages ?? []).join("\n  ")}`); return 1; }
  if (r.text) console.log(r.text);
  // A run can be recorded correctly and still not have passed, and the two must not read
  // alike. `run verify: ok` over a slice whose criteria were never exercised is the one
  // line a script, a CI step or a person scanning the last line of the output will take
  // as success, and the exit code said the same thing — the defect decisions 0012 and
  // 0017 each fixed one instance of. The trailer names the verdict instead, and the exit
  // is non-zero.
  if (r.notPassed) { console.error(`run ${pos[0]}: ${r.notPassed}`); return 1; }
  console.log(`run ${pos[0]}: ok${r.proposal ? ` (opened ${r.proposal.branch})` : ""}`);
  return 0;
};

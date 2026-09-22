import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { writeText } from "../lib/fsx.mjs";
import { git, gitOk, changedPaths, stageAll, stageSite, SDLC_AUTHOR } from "../lib/git.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { writeJournal } from "./journal.mjs";
import { propose } from "../commands/propose.mjs";
import { buildSite } from "../commands/status.mjs";
import { readRunState, writeRunState, clearRunState } from "./run-state.mjs";
import { endedBecause, runAgent, turnsFor, writeMcpConfig } from "./executor.mjs";
import { skillText } from "../stages/registry.mjs";
import { settleRequestedRevision } from "../stages/proposals.mjs";
import { IN_PLACE_MODES } from "./workspace.mjs";

// A stage's own commit-and-journal subject: a plain string for most stages, or (`ratify`,
// `archaeology`) a function of `ctx` for one whose subject folds in something only known
// once the stage actually runs against a domain — `ratify applications`, `archaeology
// applications (revise)`, not just the bare stage name.
function resolveTitle(stage, ctx) {
  return typeof stage.title === "function" ? stage.title(ctx) : stage.title ?? stage.name;
}

// A stage that opened a proposal on a previous run and has not been ruled yet is not
// safe to run again under the same name: `propose`'s own `git checkout -q -b` refuses
// to recreate a branch that already exists. Called three ways: by `runStage`, before a
// workspace is even materialised, with the name a real run would open; by `resume`, the
// same way, before it calls `finishStage` directly; and by `finishStage` itself, below,
// as a late safety net against a name only knowable after the agent has run.
// `stage.proposal` is called with an empty `agentText` so a stage whose recommendation
// quotes the agent's journal (every gated stage today) still gets a real name back,
// since the name itself never depends on `agentText`; `projectDir` is added to `ctx` so
// a stage whose name depends on a file that does not exist yet (`intent`, before the
// agent has written one) can still derive a candidate from something already on disk
// (`intent/brief.md`'s own heading) rather than returning `null` outright.
// Whether a proposal branch carries its own `return` ruling — the shape a returned or
// escalated proposal has, since only an approval's gate file ever reaches `main`.
function returnRecordedOnBranch(projectDir, name, branch) {
  const gatePath = `.sdlc/gates/${name}.yaml`;
  if (!gitOk(["cat-file", "-e", `${branch}:${gatePath}`], projectDir)) return false;
  try {
    return (parseYaml(git(["show", `${branch}:${gatePath}`], projectDir)) ?? {}).verdict === "return";
  } catch {
    return false;
  }
}

export function checkProposalNotOpen(projectDir, stage, ctx) {
  if (!stage.gate) return null;
  const p = stage.proposal({ ...ctx, projectDir, agentText: "" });
  if (!p?.name) return null;
  const branch = `proposal/${p.name}`;
  if (!gitOk(["rev-parse", "--verify", branch], projectDir)) return null;
  // A `--revise` run exists to consume exactly this branch: one whose return was recorded
  // on its own commit and nowhere else, which is why the check below reports it as open at
  // all. The stage's own revision-source pre-check reads that ruling and renames the
  // branch out of the way, so the name it still holds here is not a collision to refuse —
  // it is the thing being revised. Without this a returned proposal whose next name is its
  // own is unrevisable, and the only way forward is a full re-run of the stage.
  if (ctx.revise && returnRecordedOnBranch(projectDir, p.name, branch)) return null;
  const gatePath = join(projectDir, ".sdlc", "gates", `${p.name}.yaml`);
  if (existsSync(gatePath)) {
    // Already ruled: its verdict is either merged into `main` (approve) or recorded on
    // its own commit (return, escalate), so the branch itself is spent — kept around
    // only because nothing ever deletes one. Left in place, it would still block the
    // next run that opens a proposal under this same name: `propose`'s `git checkout -b`
    // refuses to recreate a branch that already exists. Deleted here with the safe form
    // (`-d`, which itself refuses anything not fully merged into the current branch) so
    // an approved proposal's spent branch clears the way silently.
    //
    // A dry run reports the same "not open" a real run would find, without deleting
    // anything: pruning the spent branch is the real run's own bookkeeping, and a
    // preview that performed it would no longer be read-only.
    if (ctx.dryRun) return null;
    if (gitOk(["branch", "-d", branch], projectDir)) return null;
    // `-d` refused, so the branch holds commits `main` does not — which for a ruled
    // proposal means a `return` or an `escalate`, whose ruling commit lives only on the
    // branch. Force-deleting it would throw that ruling away, and leaving it while
    // reporting nothing would let the run reach `propose` and die there on a branch it
    // cannot recreate, having already spent an agent turn. Reported as open instead, so
    // the run is refused up front and a person decides what to do with the branch.
    return p.name;
  }
  return p.name;
}

// The commit shape for a pre-flight block: no agent has run yet (or, for `resume`, none
// is going to), so there is nothing agent-shaped to journal — only the run record, the
// same way a pre-check failure is recorded. Shared by `runStage`'s and `resume`'s own
// pre-flight calls to `checkProposalNotOpen` so the message and commit read identically
// no matter which one caught it.
//
// `dryRun` reports the identical message without writing anything: a dry run inspects
// what a run would find, and this is one of the things it can find, but recording that
// is the real run's job. Neither `resume` (which has no dry-run mode of its own) nor
// `finishStage`'s own late check (reached only once a real run is already under way)
// ever pass it.
export function commitProposalStillOpen(projectDir, stageName, openProposal, { dryRun = false } = {}) {
  const message = `proposal ${openProposal} is still open; rule it (or delete the branch) before running ${stageName} again`;
  if (dryRun) return { ok: false, messages: [message] };
  const runPath = appendRun(projectDir, `run ${stageName}: proposal ${openProposal} still open`);
  stageAll(projectDir, [relative(projectDir, runPath)]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `run(${stageName}): proposal still open`], projectDir);
  return { ok: false, messages: [message] };
}

// The commit shape for a post-checks failure: a journal entry (the agent's own text
// plus what failed) and a run-record line, both committed; everything else the agent
// left in the working tree stays untracked, for a person to inspect. Shared between an
// actual post-check failure and `finishStage`'s own late open-proposal check below,
// since the second is reported the same way the ruling calls for.
function commitPostCheckFailure(projectDir, stage, agentResult, messages) {
  // A failed run costs exactly what a successful one does, and its metrics are the only
  // record of that: without them the state site's totals undercount every run that did
  // not pass, which is the population most worth knowing the cost of. `endedBecause`
  // adds the CLI's own account of how the session ended, so a post-check failure caused
  // by an agent that never got to finish reads as that rather than as bad work.
  const ended = endedBecause(agentResult.raw);
  const body = [agentResult.text, ended && `The session ${ended}.`, messages.join("\n")]
    .filter(Boolean).join("\n\n");
  const journal = writeJournal(projectDir, {
    stage: stage.name,
    title: `${stage.name}: post-checks failed`,
    body,
    metrics: { cost: agentResult.cost, turns: agentResult.turns, session: agentResult.sessionId },
  });
  const runPath = appendRun(projectDir, `run ${stage.name}: post-checks failed`);
  stageAll(projectDir, [relative(projectDir, journal), relative(projectDir, runPath)]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `stage(${stage.name}): post-checks failed`], projectDir);
  return { ok: false, journal, messages };
}

// `IN_PLACE_MODES` (`src/runner/workspace.mjs`) names the workspace modes whose agent
// works directly in the project directory — the same set `sdlc resume` uses to decide
// whether an interrupted run's output survived. A stage resolved to one of these is
// exactly the case where a post-check failure still has something worth asking the
// agent to repair: its files are sitting right there in `projectDir`, and postChecks
// always read `projectDir` regardless of workspace mode. `spec-only` and
// `blind-adapter` build a temporary workspace that is still on disk at this point —
// `runStage`'s `finally` only removes it once `finishStage` returns — but postChecks
// never look inside it, and only the paths named in `stage.collect` were copied back
// into `projectDir`, so there is nothing full enough there to hand a second turn.
// Those stages are simply re-run.

// The one-shot repair prompt: the original task, exactly what failed, and an explicit
// instruction to fix only that rather than start over — a second turn that quietly
// redoes the whole task could just as easily introduce a new failure as clear the old
// one. Carrying the task alongside the failures gives the repair the same context the
// first turn had, rather than leaving it to guess.
function fixTurnPrompt(taskPrompt, messages) {
  return `The task you were given:\n${taskPrompt}\n\nYour output failed these checks:\n${messages.join("\n")}\n\nFix exactly what they name — change nothing else, and do not start the task over. Finish with a one-paragraph journal addition saying what you changed.`;
}

// Runs the stage's agent once more, with the same skill file and MCP servers as the first
// turn and a prompt naming exactly what failed. `cwd` is the project directory for a stage
// that worked there, and the stage's own workspace for one that did not — never the
// project directory in that second case, because a blind stage repaired in the project
// would be handed the application source its whole workspace exists to keep from it. Capped at
// 40 turns (a repair is smaller than the original task) and at the stage's own ceiling,
// whichever is lower — a stage configured with a tighter budget than 40 keeps that
// budget for its fix turn too.
async function runFixTurn(cwd, stage, ctx, messages) {
  const skillDir = mkdtempSync(join(tmpdir(), `sdlc-fix-${stage.name}-`));
  try {
    const skillPath = join(skillDir, "SKILL.md");
    writeText(skillPath, skillText(stage.name));
    // Mirrors `run`'s own mcp-file handling (`writeMcpConfig`, shared from
    // `./executor.mjs`): a stage whose first turn reached MCP servers should not lose
    // them on its fix turn. The scratch file lives in this same `skillDir`, cleaned up
    // alongside the skill file below.
    const mcpConfig = writeMcpConfig(skillDir, stage.mcp?.(ctx, ctx.config));
    return await runAgent({
      cwd,
      prompt: fixTurnPrompt(stage.prompt(ctx), messages),
      systemPromptFile: skillPath,
      stage: stage.name,
      maxTurns: Math.min(40, turnsFor(ctx.config, stage.name)),
      mcpConfig,
      allowedTools: stage.allowedTools,
      env: stage.env?.(ctx, ctx.config),
    });
  } finally {
    rmSync(skillDir, { recursive: true, force: true });
  }
}

// The regenerated-files line for a no-op run: a count, plus the distinct top-level
// directories the regenerated files landed in, rather than every path. A deterministic
// stage can regenerate derived artifacts by the hundreds on a project of any size, and
// this line is also what the state site publishes as `site/runs.md` and `runs.html` — the
// one page whose whole purpose is a scannable chronology, not a place for a single run to
// bury it under an enumeration. The full list is still recoverable from the commit's own
// diff, which is where it belongs.
function regeneratedLine(stageName, changed) {
  const dirs = [...new Set(changed.map((p) => p.split("/")[0]))].sort();
  const noun = changed.length === 1 ? "file" : "files";
  return `run ${stageName}: regenerated ${changed.length} ${noun} in ${dirs.join(", ")}`;
}

// The finish path for a deterministic stage (`agent: false`) that found its own work
// already done. Post-checks still run — they judge the working tree, and this stage
// regenerated derived artifacts before returning even though it wrote no work of its own
// — and whatever regenerating left dirty is committed with the run record.
//
// What is deliberately absent is a journal entry. A journal entry is the account of a
// turn, and no turn happened: manufacturing one on every re-run would fill the journal
// with entries saying nothing happened. So the run record carries the line, the commit
// carries the regenerated files, and a run that regenerated nothing at all commits
// nothing and returns having written nothing.
export function finishDeterministicNoOp(projectDir, stage, ctx, text) {
  const post = stage.postChecks(projectDir, ctx);
  const postFail = post.filter((r) => !r.ok);
  if (postFail.length) {
    return commitPostCheckFailure(projectDir, stage, { text }, postFail.flatMap((r) => r.messages));
  }

  // Built first to find out whether there is anything to commit at all: the site is
  // derived from the same artifacts this stage regenerates, so it is part of the answer
  // rather than something added afterwards. A run that finds nothing dirty here writes no
  // run record either — appending one would itself make the tree dirty and turn every
  // no-op into a commit.
  buildSite(projectDir);
  const changed = changedPaths(projectDir).filter((p) => p !== ".sdlc/run-state.json");
  if (changed.length === 0) return { ok: true, changed: [], text };

  // The run record goes in before the second build, so the run log page the site carries
  // includes this run's own line rather than going stale the moment it is committed.
  appendRun(projectDir, regeneratedLine(stage.name, changed));
  buildSite(projectDir);
  const stagedBySite = stageSite(projectDir);
  const batch = changedPaths(projectDir)
    .filter((p) => p !== ".sdlc/run-state.json")
    .filter((p) => !stagedBySite.includes(p) && !(stagedBySite.includes("site") && p.startsWith("site/")));
  stageAll(projectDir, batch);
  const title = resolveTitle(stage, ctx);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `stage(${stage.name}): ${title} (regenerated)`], projectDir);
  return { ok: true, changed, text };
}

// Post-checks through the final commit and site build — steps 9-12 of `sdlc run`.
// Both `runStage` (right after a real agent turn) and `resume` (after a crash, with a
// stand-in agent result) land here, so a stage has exactly one place deciding whether
// its work is good enough to commit. `state` is not a parameter: both callers have
// already made sure `.sdlc/run-state.json` exists (`runStage` wrote it before the
// agent ran; `resume` read it to find `stage`/`ctx` before calling here), so it is
// re-read rather than threaded through, and rewritten at each phase change.
export async function finishStage(projectDir, stage, ctx, agentResult, { workspaceDir, recollect } = {}) {
  const state = readRunState(projectDir) ?? { stage: stage.name, ctx, startedAt: new Date().toISOString() };
  state.phase = "post-checks";
  writeRunState(projectDir, state);

  let post = stage.postChecks(projectDir, ctx);
  let postFail = post.filter((r) => !r.ok);

  // `result` is what actually gets journalled and committed: `agentResult` unchanged
  // when post-checks passed first try, or `agentResult` folded together with a second
  // turn's once a fix turn ran. `usedFixTurn` only records which happened, for the
  // run-record line below.
  let result = agentResult;
  let usedFixTurn = false;

  if (postFail.length) {
    const wsMode = typeof stage.workspace === "function" ? stage.workspace(ctx.config) : stage.workspace;
    // One fix turn per run: a stage in an in-place workspace, on a run that has not
    // already spent its fix turn (`state.fixTurnUsed`, which survives a post-checks
    // failure on disk so a later `sdlc resume --again` sees it and does not loop), never
    // on a dry run (which reports what it would do and changes nothing, so there is no
    // failure here for it to repair), and only when the stage actually spawns an agent.
    // `ratify` and `calibrate` (`agent: false`) resolve to workspace `"project"` too, but
    // there is no session here to run a repair with: `ratify` declares no `skill` at all
    // (`skillText` would throw trying to read one), and `calibrate` drives a deterministic
    // test suite rather than free-form work, so handing either one an unrestricted agent
    // turn is never right, whatever the workspace mode says.
    // A stage that worked in the project directory is repaired there. One that worked in
    // its own workspace is repaired in that workspace, which is still on disk at this
    // point (`runStage`'s `finally` removes it only once this function returns) and is
    // exactly as blind as it was for the first turn; whatever the repair writes is then
    // collected back into the project the same way the first turn's output was, so the
    // post-checks below judge the same tree they judged the first time.
    const repairDir = IN_PLACE_MODES.has(wsMode) ? projectDir : workspaceDir;
    const eligible = Boolean(repairDir) && stage.agent !== false && !ctx.dryRun && !state.fixTurnUsed;
    if (!eligible) {
      // Only the journal and the run record are staged: the agent's other files stay in
      // the working tree, untracked, so a person can see exactly what it produced.
      return commitPostCheckFailure(projectDir, stage, agentResult, postFail.flatMap((r) => r.messages));
    }

    const firstMessages = postFail.flatMap((r) => r.messages);
    // Marked used, and persisted, before the turn runs: a fix turn that itself crashes
    // mid-session still leaves `fixTurnUsed: true` on disk, so a resume of that crash
    // does not spend a second one.
    state.fixTurnUsed = true;
    writeRunState(projectDir, state);

    const fix = await runFixTurn(repairDir, stage, ctx, firstMessages);
    if (repairDir !== projectDir) recollect?.();
    result = {
      text: `${agentResult.text}\n\n## Fix turn\n\n${fix.text}`,
      cost: (agentResult.cost ?? 0) + (fix.cost ?? 0),
      turns: (agentResult.turns ?? 0) + (fix.turns ?? 0),
      sessionId: agentResult.sessionId,
      raw: agentResult.raw,
    };
    usedFixTurn = true;

    post = stage.postChecks(projectDir, ctx);
    postFail = post.filter((r) => !r.ok);
    if (postFail.length) {
      const secondMessages = postFail.flatMap((r) => r.messages);
      return commitPostCheckFailure(projectDir, stage, result, [...firstMessages, ...secondMessages]);
    }
    // Post-checks pass now: fall through into the same success path a first-try pass
    // takes, using `result` (the folded-together text and metrics) in place of the
    // original `agentResult` from here on.
  }

  // A safety net for a stage whose proposal name is only knowable after the run
  // (`intent`, keyed on the file the agent just wrote): whichever caller got here —
  // `runStage`'s own pre-flight, run before the agent turn, or `resume`'s identical one,
  // run before `finishStage` is even called — may have had nothing to check yet, since
  // neither can see a file the agent has not written. Checked again now, with the
  // stage's real proposal name, before `propose` gets anywhere near its own doomed
  // `git checkout -q main` / `git checkout -q -b <branch>` — and reported the same way
  // any other post-check failure is, since by this point the agent has already run and
  // left files worth preserving.
  const openProposal = checkProposalNotOpen(projectDir, stage, ctx);
  if (openProposal) {
    const message = `proposal ${openProposal} is still open; rule it (or delete the branch) before running ${stage.name} again`;
    return commitPostCheckFailure(projectDir, stage, result, [message]);
  }

  const journal = writeJournal(projectDir, {
    stage: stage.name,
    title: resolveTitle(stage, ctx),
    body: result.text,
    metrics: { cost: result.cost, turns: result.turns, session: result.sessionId },
  });
  appendRun(projectDir, usedFixTurn
    ? `run ${stage.name}: ok after a fix turn, cost ${result.cost}, turns ${result.turns}`
    : `run ${stage.name}: ok, cost ${result.cost}, turns ${result.turns}`);

  // The state site is a tracked artifact of `main` and of nothing else. A gated stage's
  // work lands on a `proposal/<name>` branch, and every page of the site is regenerated
  // whole from the whole project, so two proposals open at once each carry a different
  // complete site: merging the second one conflicts on every page, for content neither
  // proposal is about. So a gated stage builds no site at all, and regenerating it is the
  // ruling's job, on `main`, after the merge (`docs/stages/rule.md`).
  //
  // A gate-less stage commits straight to `main`, so it builds and stages the site here.
  // Staging it (which un-ignores it first on a project whose `.gitignore` still hides it)
  // means `changedPaths()` below reports the freshly written `site/*.md` files the same
  // as any other change, so they are committed alongside the journal and run record. The
  // returned list is exactly what it staged (a subset of ["site", ".gitignore"]) and is
  // used below to keep those paths out of this function's own `stageAll` batch — naming
  // an already-staged, still-ignored `site` again there would make `stageAll` refuse the
  // whole batch.
  let stagedBySite = [];
  if (!stage.gate) {
    buildSite(projectDir);
    stagedBySite = stageSite(projectDir);
  }
  // `.sdlc/run-state.json` is this run's own scratch and is never part of a stage's
  // commit. A project that has it ignored never shows it here at all; one that does not
  // would otherwise commit a half-finished run's bookkeeping into the stage's own
  // record, so it is dropped from the list by name either way.
  const changed = changedPaths(projectDir).filter((p) => p !== ".sdlc/run-state.json");

  let proposal = null;
  if (stage.gate) {
    // No `stageSite` ran on this path, so `changed` is exactly the stage's own output
    // plus the journal and run record, and every path in it belongs in the proposal.
    // `agentText` is added alongside whatever `postChecks` already stashed on `ctx`
    // (the same object, so a stage's own `ctx.intentFile`-style side effect above still
    // reaches `proposal` through the spread) rather than passed as a separate argument,
    // so a `proposal(ctx)` written before this existed keeps working unchanged.
    //
    // `projectDir` is passed explicitly because it was missing here and present on the
    // dry-run path above, which is why every stage that needs it to choose a name
    // precomputes that name in `preChecks` and treats the call here as a fallback that
    // never fires. A `proposal(ctx)` may rely on it.
    // `account` is set only by `resume`, and only when the interrupted run's own journal
    // entry is still on disk: the journal above records what THIS run did, which for a
    // resume is nothing, while the proposal describes the WORK, which the recovered
    // account is. Keeping them apart stops a run that is resumed twice from copying the
    // whole account into the journal again each time, and stops a gate's ruler being
    // handed a proposal that says the runner lost it.
    const account = result.account ?? result.text;
    const p = stage.proposal({ ...ctx, projectDir, agentText: account });
    const { branch } = propose(projectDir, p.name, {
      gate: stage.gate, question: p.question, recommendation: p.recommendation, page: account, paths: changed,
    });
    proposal = { name: p.name, gate: stage.gate, branch };
  } else {
    // `changed` still carries whatever `stageSite` already staged above — `.gitignore`,
    // and every `site/*` file if the site itself needed staging — so those are filtered
    // back out here rather than named a second time in a plain `git add -A` batch.
    const batch = changed.filter((p) => !stagedBySite.includes(p)
      && !(stagedBySite.includes("site") && p.startsWith("site/")));
    stageAll(projectDir, batch);
    const title = resolveTitle(stage, ctx);
    git([...SDLC_AUTHOR, "commit", "-q", "-m", `stage(${stage.name}): ${title}`], projectDir);
  }

  // A run opened by requests addressed to this stage spends them here and nowhere earlier.
  // The checkout is back on `main` and the tree is clean by this point on either path
  // above, so the ledger moves in a commit of its own, the way `0024` files one: what the
  // run answered is marked taken, all of it at once, and what the run said it could not
  // answer stays open with the reason against it. A run that never got this far — refused
  // by a later pre-check, failed by its post-checks, lost mid-session — leaves every
  // request exactly where it found it, because an ask marked answered is an ask nothing
  // raises again.
  settleRequestedRevision(projectDir, stage.name, ctx, result.text, proposal?.name ?? null);

  clearRunState(projectDir);
  return { ok: true, proposal, journal, cost: result.cost, turns: result.turns };
}

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { git, gitOk, changedPaths, stageAll, stageSite, SDLC_AUTHOR } from "../lib/git.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { writeJournal } from "./journal.mjs";
import { propose } from "../commands/propose.mjs";
import { buildSite } from "../commands/status.mjs";
import { readRunState, writeRunState, clearRunState } from "./run-state.mjs";
import { endedBecause } from "./executor.mjs";

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
export function checkProposalNotOpen(projectDir, stage, ctx) {
  if (!stage.gate) return null;
  const p = stage.proposal({ ...ctx, projectDir, agentText: "" });
  if (!p?.name) return null;
  const branch = `proposal/${p.name}`;
  if (!gitOk(["rev-parse", "--verify", branch], projectDir)) return null;
  const gatePath = join(projectDir, ".sdlc", "gates", `${p.name}.yaml`);
  if (existsSync(gatePath)) {
    // Already ruled: its verdict is either merged into `main` (approve) or recorded on
    // its own commit (return, escalate), so the branch itself is spent — kept around
    // only because nothing ever deletes one. Left in place, it would still block the
    // next run that opens a proposal under this same name: `propose`'s `git checkout -b`
    // refuses to recreate a branch that already exists. Deleted here with the safe form
    // (`-d`, which itself refuses anything not fully merged into the current branch) so
    // an approved proposal's spent branch clears the way silently.
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
export function commitProposalStillOpen(projectDir, stageName, openProposal) {
  const message = `proposal ${openProposal} is still open; rule it (or delete the branch) before running ${stageName} again`;
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
  appendRun(projectDir, `run ${stage.name}: regenerated ${changed.join(", ")}`);
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
export async function finishStage(projectDir, stage, ctx, agentResult) {
  const state = readRunState(projectDir) ?? { stage: stage.name, ctx, startedAt: new Date().toISOString() };
  state.phase = "post-checks";
  writeRunState(projectDir, state);

  const post = stage.postChecks(projectDir, ctx);
  const postFail = post.filter((r) => !r.ok);
  if (postFail.length) {
    // Only the journal and the run record are staged: the agent's other files stay in
    // the working tree, untracked, so a person can see exactly what it produced.
    return commitPostCheckFailure(projectDir, stage, agentResult, postFail.flatMap((r) => r.messages));
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
    return commitPostCheckFailure(projectDir, stage, agentResult, [message]);
  }

  const journal = writeJournal(projectDir, {
    stage: stage.name,
    title: resolveTitle(stage, ctx),
    body: agentResult.text,
    metrics: { cost: agentResult.cost, turns: agentResult.turns, session: agentResult.sessionId },
  });
  appendRun(projectDir, `run ${stage.name}: ok, cost ${agentResult.cost}, turns ${agentResult.turns}`);

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
    const p = stage.proposal({ ...ctx, agentText: agentResult.text });
    const { branch } = propose(projectDir, p.name, {
      gate: stage.gate, question: p.question, recommendation: p.recommendation, page: agentResult.text, paths: changed,
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

  clearRunState(projectDir);
  return { ok: true, proposal, journal, cost: agentResult.cost, turns: agentResult.turns };
}

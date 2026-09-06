import { relative } from "node:path";
import { git, changedPaths, stageAll } from "../lib/git.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { writeJournal } from "./journal.mjs";
import { propose } from "../commands/propose.mjs";
import { buildSite } from "../commands/status.mjs";
import { readRunState, writeRunState, clearRunState } from "./run-state.mjs";

const SDLC_AUTHOR = ["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost"];

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
    const messages = postFail.flatMap((r) => r.messages);
    const journal = writeJournal(projectDir, {
      stage: stage.name,
      title: `${stage.name}: post-checks failed`,
      body: `${agentResult.text}\n\n${messages.join("\n")}`,
    });
    const runPath = appendRun(projectDir, `run ${stage.name}: post-checks failed`);
    // Only the journal and the run record are staged: the agent's other files stay in
    // the working tree, untracked, so a person can see exactly what it produced.
    stageAll(projectDir, [relative(projectDir, journal), relative(projectDir, runPath)]);
    git([...SDLC_AUTHOR, "commit", "-q", "-m", `stage(${stage.name}): post-checks failed`], projectDir);
    return { ok: false, journal, messages };
  }

  const journal = writeJournal(projectDir, {
    stage: stage.name,
    title: stage.name,
    body: agentResult.text,
    metrics: { cost: agentResult.cost, turns: agentResult.turns, session: agentResult.sessionId },
  });
  appendRun(projectDir, `run ${stage.name}: ok, cost ${agentResult.cost}, turns ${agentResult.turns}`);

  buildSite(projectDir);
  // The site is regenerated on every successful run so it is always current on disk,
  // and it is a tracked artifact: `changedPaths()` reflects `git status --porcelain`,
  // so the freshly written `site/*.md` files are picked up here the same as any other
  // change and staged and committed below alongside the journal and run record.
  const changed = changedPaths(projectDir);

  let proposal = null;
  if (stage.gate) {
    const p = stage.proposal(ctx);
    const { branch } = propose(projectDir, p.name, {
      gate: stage.gate, question: p.question, recommendation: p.recommendation, page: agentResult.text, paths: changed,
    });
    proposal = { name: p.name, gate: stage.gate, branch };
  } else {
    stageAll(projectDir, changed);
    git([...SDLC_AUTHOR, "commit", "-q", "-m", `stage(${stage.name}): ${stage.title ?? stage.name}`], projectDir);
  }

  clearRunState(projectDir);
  return { ok: true, proposal, journal, cost: agentResult.cost, turns: agentResult.turns };
}

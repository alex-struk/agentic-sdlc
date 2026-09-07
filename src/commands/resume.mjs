import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.mjs";
import { readRunState } from "../runner/run-state.mjs";
import { stageFor } from "../stages/registry.mjs";
import { finishStage, checkProposalNotOpen, commitProposalStillOpen } from "../runner/finish-stage.mjs";
import { IN_PLACE_MODES } from "../runner/workspace.mjs";
import { COMMANDS } from "../cli.mjs";

export async function resume(projectDir, { again = false } = {}) {
  projectDir = resolve(projectDir);
  const state = readRunState(projectDir);
  if (!state) { console.log("nothing to resume"); return 0; }

  const stage = stageFor(state.stage);

  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);
  // `stage.workspace` may be a function of `config` — resolved here the same way
  // `runStage` resolves it, so a resumed run and a fresh one agree on which mode a stage
  // actually used.
  const wsMode = typeof stage.workspace === "function" ? stage.workspace(config) : stage.workspace;

  // `spec-only` and `blind-adapter` build a temporary workspace that the interrupted
  // run's own `finally` already removed, so there is nothing left of what their agent
  // produced: judging the project directory instead would run the stage's post-checks
  // against files that stage never touched, and either pass or fail for reasons that
  // have nothing to do with the interrupted run. Re-running the stage is the only honest
  // way to continue those.
  //
  // `project` and `with-sources` both work in the project directory itself
  // (`materialise` returns `projectDir` for each), so whatever the interrupted agent
  // wrote is still on disk and is exactly what post-checks should judge. The only thing
  // `with-sources` adds is the read-only checkout at `sources/old`, which `ensureSources`
  // materialises and nothing here removes.
  if (!IN_PLACE_MODES.has(wsMode)) {
    console.log(`resume cannot continue a ${wsMode} stage; run it again`);
    return 1;
  }

  if (state.phase === "agent" && !again) {
    console.log(`run ${state.stage}: the agent step was interrupted before finishing; pass --again to continue with post-checks anyway`);
    return 1;
  }

  const ctx = { ...state.ctx, config };

  // `resume` has no agent turn of its own to run, but it still lands on `finishStage`,
  // which can open a proposal — so the same pre-flight `sdlc run` performs before its
  // own agent turn belongs here too, before spending a post-checks judgment on files
  // that would only get thrown away by a blocked proposal a moment later.
  const openProposal = checkProposalNotOpen(projectDir, stage, ctx);
  if (openProposal) {
    const r = commitProposalStillOpen(projectDir, state.stage, openProposal);
    console.log(`run ${state.stage}: failed\n  ${r.messages.join("\n  ")}`);
    return 1;
  }

  // The agent step is not re-run here even with --again: there is no session to
  // resume it from, only the files (if any) it left behind before the process died.
  // Post-checks judge those files exactly as they would judge a fresh agent turn.
  const agentResult = { text: "(resumed; agent output unavailable)", cost: 0, turns: 0, sessionId: "" };
  const r = await finishStage(projectDir, stage, ctx, agentResult);
  return r.ok ? 0 : 1;
}

COMMANDS.resume = async ({ flags }) => resume(process.cwd(), { again: !!flags.again });

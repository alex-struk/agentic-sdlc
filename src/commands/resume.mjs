import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.mjs";
import { readRunState } from "../runner/run-state.mjs";
import { stageFor } from "../stages/registry.mjs";
import { finishStage } from "../runner/finish-stage.mjs";
import { COMMANDS } from "../cli.mjs";

export async function resume(projectDir, { again = false } = {}) {
  projectDir = resolve(projectDir);
  const state = readRunState(projectDir);
  if (!state) { console.log("nothing to resume"); return 0; }

  if (state.phase === "agent" && !again) {
    console.log(`run ${state.stage}: the agent step was interrupted before finishing; pass --again to continue with post-checks anyway`);
    return 1;
  }

  const stage = stageFor(state.stage);
  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);
  const ctx = { ...state.ctx, config };
  // The agent step is not re-run here even with --again: there is no session to
  // resume it from, only the files (if any) it left behind before the process died.
  // Post-checks judge those files exactly as they would judge a fresh agent turn.
  const agentResult = { text: "(resumed; agent output unavailable)", cost: 0, turns: 0, sessionId: "" };
  const r = await finishStage(projectDir, stage, ctx, agentResult);
  return r.ok ? 0 : 1;
}

COMMANDS.resume = async ({ flags }) => resume(process.cwd(), { again: !!flags.again });

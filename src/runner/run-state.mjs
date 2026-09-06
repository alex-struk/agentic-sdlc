import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readText, writeText } from "../lib/fsx.mjs";

// `.sdlc/run-state.json` records which stage a run is on and how far it got, so a
// process that dies mid-stage (crash, closed terminal, killed job) leaves something
// `sdlc resume` can pick up rather than a working tree nobody can explain. It is
// project-local scratch, not a project artifact, so the project template's
// `.gitignore` keeps it untracked.
function statePath(projectDir) {
  return join(projectDir, ".sdlc", "run-state.json");
}

export function readRunState(projectDir) {
  const p = statePath(projectDir);
  if (!existsSync(p)) return null;
  return JSON.parse(readText(p));
}

export function writeRunState(projectDir, state) {
  writeText(statePath(projectDir), JSON.stringify(state, null, 2) + "\n");
}

export function clearRunState(projectDir) {
  const p = statePath(projectDir);
  if (existsSync(p)) unlinkSync(p);
}

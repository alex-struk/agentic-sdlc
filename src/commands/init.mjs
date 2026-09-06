import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, gitOk } from "../lib/git.mjs";
import { readText, writeText } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { resolvePacks, installPacks } from "./packs.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { DEFAULT_NAMES } from "../checks/egress.mjs";
import { COMMANDS } from "../cli.mjs";
import { PIPELINE_ROOT } from "./new.mjs";

export async function init(projectDir = process.cwd()) {
  projectDir = resolve(projectDir);
  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);

  const pipelineCommit = gitOk(["rev-parse", "HEAD"], PIPELINE_ROOT) ? git(["rev-parse", "HEAD"], PIPELINE_ROOT) : config.pipeline.ref;
  const packs = resolvePacks(config.skills.packs, projectDir);
  const lock = { pipeline: { ...config.pipeline, commit: pipelineCommit }, packs, created: new Date().toISOString() };
  const lockPath = join(projectDir, ".sdlc", "lock.json");
  const prev = existsSync(lockPath) ? JSON.parse(readText(lockPath)) : null;
  let changed = false;
  if (!prev || JSON.stringify({ ...prev, created: 0 }) !== JSON.stringify({ ...lock, created: 0 })) {
    writeText(lockPath, JSON.stringify(lock, null, 2) + "\n");
    changed = true;
  }

  const r = installPacks(projectDir, packs);
  if (r.installed.length) changed = true;

  const wf = readText(join(PIPELINE_ROOT, "templates", "workflows", "sdlc-checkpoint.yml"))
    .replaceAll("{{PIPELINE_REPO}}", config.pipeline.repo).replaceAll("{{PIPELINE_REF}}", config.pipeline.ref);
  const wfPath = join(projectDir, ".github", "workflows", "sdlc-checkpoint.yml");
  if (!existsSync(wfPath) || readText(wfPath) !== wf) {
    writeText(wfPath, wf);
    changed = true;
  }

  // Creating the default egress name list under the user's home is machine-local
  // housekeeping, not a project change: it never touches projectDir, so it must not
  // gate the run record or the commit below.
  if (!existsSync(DEFAULT_NAMES)) writeText(DEFAULT_NAMES,
    "# agentic-sdlc egress name list: one colleague name per line. Never commit this file.\n# The egress check fails any tracked file that contains a name listed here.\n");

  for (const s of r.skipped) console.warn(`warning: ${s}`);

  if (changed) {
    appendRun(projectDir, `init: pipeline ${pipelineCommit.slice(0, 7)}, packs ${packs.length}, skills installed ${r.installed.length}, skipped ${r.skipped.length}`);
    if (git(["status", "--porcelain"], projectDir)) {
      git(["add", "-A"], projectDir);
      git(["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost", "commit", "-q", "-m", "chore(sdlc): init"], projectDir);
    }
  }
  return { lock, ...r, changed };
}

COMMANDS.init = async ({ pos }) => { const r = await init(pos[0]); console.log(`init ok: ${r.installed.length} skills installed`); return 0; };

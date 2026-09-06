import { existsSync, chmodSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { git, gitOk, stagePaths } from "../lib/git.mjs";
import { readText, writeText } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { resolvePacks, installPacks } from "./packs.mjs";
import { buildSite } from "./status.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { defaultNamesPath } from "../checks/egress.mjs";
import { COMMANDS } from "../cli.mjs";
import { PIPELINE_ROOT } from "./new.mjs";

// Files copied verbatim out of the pipeline's templates into the project. Each is
// written when it is missing or differs, so a project picks up a template change on
// the next `sdlc init` without an upgrade step of its own.
const TEMPLATE_FILES = [
  { src: ["templates", "project", ".claude", "settings.json"], dst: [".claude", "settings.json"] },
  { src: ["templates", "hooks", "implement-guard.sh"], dst: [".sdlc", "hooks", "implement-guard.sh"], mode: 0o755 },
  { src: ["templates", "project", ".gitattributes"], dst: [".gitattributes"] },
  { src: ["templates", "project", ".sdlc", "personas", "ux-reviewer.md"], dst: [".sdlc", "personas", "ux-reviewer.md"] },
  { src: ["templates", "project", ".sdlc", "personas", "tech-lead.md"], dst: [".sdlc", "personas", "tech-lead.md"] },
  { src: ["templates", "project", ".sdlc", "personas", "product-owner.md"], dst: [".sdlc", "personas", "product-owner.md"] },
  { src: ["templates", "project", ".sdlc", "personas", "architect.md"], dst: [".sdlc", "personas", "architect.md"] },
  { src: ["templates", "project", ".sdlc", "personas", "reviewer.md"], dst: [".sdlc", "personas", "reviewer.md"] },
];

function installTemplateFiles(projectDir) {
  let changed = false;
  for (const f of TEMPLATE_FILES) {
    const dst = join(projectDir, ...f.dst);
    const text = readText(join(PIPELINE_ROOT, ...f.src));
    if (!existsSync(dst) || readText(dst) !== text) { writeText(dst, text); changed = true; }
    if (f.mode !== undefined) chmodSync(dst, f.mode);
  }
  return changed;
}

// A pack's skills are copied once and `copyTree` never overwrites, so a pack whose
// pinned commit moved would otherwise keep serving the old skill text forever. The
// previous lockfile says which commit each pack was installed from; where that differs
// from the commit now resolved, the pack's target skill folders are removed so the
// copy below writes the new version.
function clearMovedPackSkills(projectDir, packs, prev) {
  const before = new Map((prev?.packs ?? []).map((p) => [p.name, p.commit]));
  for (const p of packs) {
    if (before.get(p.name) === p.commit) continue;
    for (const s of p.skills) rmSync(join(projectDir, ".claude", "skills", s), { recursive: true, force: true });
  }
}

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

  clearMovedPackSkills(projectDir, packs, prev);
  const r = installPacks(projectDir, packs);
  if (r.installed.length) changed = true;

  if (installTemplateFiles(projectDir)) changed = true;

  const wf = readText(join(PIPELINE_ROOT, "templates", "workflows", "sdlc-checkpoint.yml"))
    .replaceAll("{{PIPELINE_REPO}}", config.pipeline.repo)
    .replaceAll("{{PIPELINE_REF}}", config.pipeline.ref)
    .replaceAll("{{PIPELINE_COMMIT}}", pipelineCommit);
  const wfPath = join(projectDir, ".github", "workflows", "sdlc-checkpoint.yml");
  if (!existsSync(wfPath) || readText(wfPath) !== wf) {
    writeText(wfPath, wf);
    changed = true;
  }

  // Creating the default egress name list under the user's home is machine-local
  // housekeeping, not a project change: it never touches projectDir, so it must not
  // gate the run record or the commit below.
  const namesPath = defaultNamesPath();
  if (!existsSync(namesPath)) writeText(namesPath,
    "# agentic-sdlc egress name list: one colleague name per line. Never commit this file.\n# The egress check fails any tracked file that contains a name listed here.\n");

  for (const s of r.skipped) console.warn(`warning: ${s}`);

  if (changed) {
    const runPath = appendRun(projectDir, `init: pipeline ${pipelineCommit.slice(0, 7)}, packs ${packs.length}, skills installed ${r.installed.length}, skipped ${r.skipped.length}`);
    // The state site is only rebuilt here when something else already made this init a
    // commit — never on a genuine no-op re-run, which must stay a no-op (see
    // test/new-init.test.mjs) even though the site's own generated timestamp always
    // differs between builds.
    buildSite(projectDir);
    // `init` is the one command that may run on a dirty tree — a team runs it in the
    // middle of ordinary work — so it stages the files it owns by name and leaves
    // everything else exactly as it found it.
    stagePaths(projectDir, [
      join(".sdlc", "lock.json"),
      join(".github", "workflows", "sdlc-checkpoint.yml"),
      join(".claude", "skills"),
      join(".claude", "settings.json"),
      join(".sdlc", "hooks"),
      join(".sdlc", "personas"),
      "site",
      ".gitattributes",
      relative(projectDir, runPath),
    ]);
    if (git(["diff", "--cached", "--name-only"], projectDir)) {
      git(["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost", "commit", "-q", "-m", "chore(sdlc): init"], projectDir);
    }
  }
  return { lock, ...r, changed };
}

COMMANDS.init = async ({ pos }) => { const r = await init(pos[0]); console.log(`init ok: ${r.installed.length} skills installed`); return 0; };

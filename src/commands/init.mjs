import { existsSync, chmodSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { git, gitOk, stagePaths, stageSite, reconcileGitignore, SDLC_AUTHOR } from "../lib/git.mjs";
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
  // The acceptance harness: config, fixtures and generated-type re-exports are refreshed
  // like every file above. The three `onlyIfAbsent` entries below are different — a
  // starting copy is written once and then belongs to the project, so `derive-tests`'
  // notes and a team's own attestations and seed handles are never overwritten by a
  // later `init`.
  { src: ["templates", "project", "tests", "package.json"], dst: ["tests", "package.json"] },
  { src: ["templates", "project", "tests", "tsconfig.json"], dst: ["tests", "tsconfig.json"] },
  { src: ["templates", "project", "tests", "playwright.config.ts"], dst: ["tests", "playwright.config.ts"] },
  { src: ["templates", "project", "tests", "README.md"], dst: ["tests", "README.md"] },
  { src: ["templates", "project", "tests", "fixtures", "index.ts"], dst: ["tests", "fixtures", "index.ts"] },
  { src: ["templates", "project", "tests", "fixtures", "mail.ts"], dst: ["tests", "fixtures", "mail.ts"] },
  { src: ["templates", "project", "tests", "fixtures", "env.d.ts"], dst: ["tests", "fixtures", "env.d.ts"] },
  { src: ["templates", "project", "tests", "acceptance", "not-testable.yaml"], dst: ["tests", "acceptance", "not-testable.yaml"], onlyIfAbsent: true },
  { src: ["templates", "project", "tests", "acceptance", "attestations.yaml"], dst: ["tests", "acceptance", "attestations.yaml"], onlyIfAbsent: true },
  { src: ["templates", "project", "tests", "seed", "manifest.yaml"], dst: ["tests", "seed", "manifest.yaml"], onlyIfAbsent: true },
];

// Writes every file above that is missing or differs from the pipeline's copy, skipping
// an `onlyIfAbsent` entry entirely once the project has one — never comparing its
// content, since a project's own edit to it is not drift to correct. `writtenOnlyIfAbsent`
// names, of those, the ones this call actually created: the caller stages only those, so
// a hand edit sitting uncommitted on a later run (when the file already existed and this
// function never touched it) is never swept into an unrelated init commit.
function installTemplateFiles(projectDir) {
  let changed = false;
  const writtenOnlyIfAbsent = [];
  for (const f of TEMPLATE_FILES) {
    const dst = join(projectDir, ...f.dst);
    if (f.onlyIfAbsent && existsSync(dst)) continue;
    const text = readText(join(PIPELINE_ROOT, ...f.src));
    if (!existsSync(dst) || readText(dst) !== text) {
      writeText(dst, text);
      changed = true;
      if (f.onlyIfAbsent) writtenOnlyIfAbsent.push(join(...f.dst));
    }
    if (f.mode !== undefined) chmodSync(dst, f.mode);
  }
  return { changed, writtenOnlyIfAbsent };
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

// `.sdlc/run-state.json` is a run's own scratch — which stage it is on and how far it
// got — and never a project artifact. An earlier version of the pipeline let it be
// committed, so a project can arrive here with it tracked: the index entry is dropped
// (the file on disk is left alone, since a run may be using it right now) and the
// removal is staged with the init commit. `--ignore-unmatch` makes this a no-op on
// every project that never tracked it.
function untrackRunState(projectDir) {
  const rel = join(".sdlc", "run-state.json");
  if (!git(["ls-files", "--", rel], projectDir)) return false;
  git(["rm", "--cached", "-q", "--ignore-unmatch", "--", rel], projectDir);
  return true;
}

export async function init(projectDir = process.cwd()) {
  projectDir = resolve(projectDir);
  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);

  let changed = false;
  // Both of these repair a project built by an earlier version of the pipeline, and
  // both are no-ops on one that was not: the ignore file is reconciled line by line
  // (see docs/stages/init.md) and the run-state file is dropped from the index.
  //
  // The boolean is kept, not just folded into `changed`: `stageSite` below calls
  // `reconcileGitignore` again on its own account (for the callers that never call it
  // themselves), and by then the file is already canonical, so its second call always
  // reports no change. Only this first call actually saw whatever this run rewrote, so
  // it alone decides whether `.gitignore` belongs in the commit.
  const gitignoreChanged = reconcileGitignore(projectDir);
  if (gitignoreChanged) changed = true;
  if (untrackRunState(projectDir)) changed = true;

  const pipelineCommit = gitOk(["rev-parse", "HEAD"], PIPELINE_ROOT) ? git(["rev-parse", "HEAD"], PIPELINE_ROOT) : config.pipeline.ref;
  const packs = resolvePacks(config.skills.packs, projectDir);
  const lock = { pipeline: { ...config.pipeline, commit: pipelineCommit }, packs, created: new Date().toISOString() };
  const lockPath = join(projectDir, ".sdlc", "lock.json");
  const prev = existsSync(lockPath) ? JSON.parse(readText(lockPath)) : null;
  if (!prev || JSON.stringify({ ...prev, created: 0 }) !== JSON.stringify({ ...lock, created: 0 })) {
    writeText(lockPath, JSON.stringify(lock, null, 2) + "\n");
    changed = true;
  }

  clearMovedPackSkills(projectDir, packs, prev);
  const r = installPacks(projectDir, packs);
  if (r.installed.length) changed = true;

  const tf = installTemplateFiles(projectDir);
  if (tf.changed) changed = true;

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
    // test/new-init.test.mjs).
    buildSite(projectDir);
    // The site goes through the shared helper, which un-ignores it first if this
    // project's `.gitignore` still hides it and records a page the site no longer
    // generates as removed.
    stageSite(projectDir);
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
      join("tests", "package.json"),
      join("tests", "tsconfig.json"),
      join("tests", "playwright.config.ts"),
      join("tests", "README.md"),
      join("tests", "fixtures"),
      ".gitattributes",
      relative(projectDir, runPath),
      ...(gitignoreChanged ? [".gitignore"] : []),
      // Each `onlyIfAbsent` harness file (see TEMPLATE_FILES) is staged only when this
      // very call is the one that created it — never on a later run, where it is project
      // content and a hand edit sitting uncommitted is none of this command's business.
      ...tf.writtenOnlyIfAbsent,
    ]);
    if (git(["diff", "--cached", "--name-only"], projectDir)) {
      git([...SDLC_AUTHOR, "commit", "-q", "-m", "chore(sdlc): init"], projectDir);
    }
  }
  return { lock, ...r, changed };
}

COMMANDS.init = async ({ pos }) => { const r = await init(pos[0]); console.log(`init ok: ${r.installed.length} skills installed`); return 0; };

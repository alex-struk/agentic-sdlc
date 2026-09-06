import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The untrimmed form: needed by any caller that parses porcelain output by position
// (a fixed-width slice, a NUL-separated record) rather than treating the whole result
// as one value, since `git()` below trims the *entire* stdout and would eat the first
// line's leading status character along with it.
export function gitRaw(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // execFileSync's own message is "Command failed: git ...", which drops the reason git
    // printed. The reason is on stderr, and for a few commands (a conflicted merge, for
    // one) on stdout instead, so both are tried before falling back to the raw message.
    const stderr = (e.stderr ?? "").toString().trim();
    const stdout = (e.stdout ?? "").toString().trim();
    throw new Error(`git ${args.join(" ")} failed:\n${stderr || stdout || e.message}`);
  }
}

export function git(args, cwd) {
  return gitRaw(args, cwd).trim();
}

export function gitOk(args, cwd) {
  try { git(args, cwd); return true; } catch { return false; }
}

// A gate command commits on the caller's behalf, so it must not sweep in whatever else
// happened to be in the tree: the record of a ruling has to contain the ruling and
// nothing else. Commands check first and stage by name afterwards.
export function assertCleanTree(projectDir, command) {
  const dirty = git(["status", "--porcelain"], projectDir);
  if (!dirty) return;
  const paths = dirty.split("\n").map((l) => `  ${l.trim()}`).join("\n");
  throw new Error(`${command}: the working tree has uncommitted changes. Commit or stash them first:\n${paths}`);
}

// Stages exactly the given project-relative paths, skipping any that do not exist on
// disk — a path a command did not end up writing (a run record on a command that wrote
// none, say) is skipped rather than making `git add` fail. This cannot represent a
// deletion: an already-removed path fails the existsSync check and never reaches `git
// add`, so a caller staging a stage's own changes (which may include files an agent
// deleted or renamed) wants `stageAll` below instead.
export function stagePaths(projectDir, paths) {
  const present = paths.filter((p) => existsSync(join(projectDir, p)));
  if (present.length) git(["add", "--", ...present], projectDir);
}

// Stages exactly the given project-relative paths, deletions and renames included:
// `git add -A` (unlike plain `git add`) records that a path is gone from the working
// tree instead of leaving it out of the index untouched. Every path here is expected to
// be a live pathspec — present on disk, or already known to git as removed — which a
// caller gets for free by building the list from `changedPaths()` below rather than
// naming files itself. Skips the call entirely when the list is empty, since
// `git add -A --` with no further pathspec means "the whole tree" rather than "nothing".
export function stageAll(projectDir, paths) {
  if (paths.length === 0) return;
  git(["add", "-A", "--", ...paths], projectDir);
}

// The porcelain status as bare project-relative paths — one per changed file, two for a
// rename or copy (the new path and the one it came from), so a caller can stage a
// deletion or a rename by name rather than just what still exists on disk.
//
// This reads `git status --porcelain -z` through `gitRaw`, not `git`: with `-z` git
// separates records with NUL instead of "\n" and never quotes a path, so each record is
// exactly "XY " (two status characters and a space) followed by the path, and a rename
// or copy record (X or Y is "R" or "C") is followed by a second NUL-terminated record
// holding the path it was renamed or copied from. `git()`'s blanket `.trim()` is meant
// for single-value output (a branch name, a commit hash); given multi-line or
// NUL-separated porcelain output it would only trim the outer whitespace, but the fixed
// "XY " prefix this parses still depends on nothing upstream having touched the bytes.
export function changedPaths(projectDir) {
  const out = gitRaw(["status", "--porcelain", "-z"], projectDir);
  const records = out.split("\0");
  const paths = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (status.includes("R") || status.includes("C")) paths.push(records[++i]);
  }
  return paths;
}

// The lines a project's own `.gitignore` must carry, reconciled one line at a time.
// `site/` is deliberately absent: the generated state site is a tracked artifact (see
// docs/stages/status.md), so a project carrying that line has it removed.
const REQUIRED_IGNORES = [
  "node_modules/",
  ".sdlc/packs/",
  ".sdlc/run-state.json",
  ".sdlc/*.local.yaml",
  ".sdlc/*.local.txt",
];
const UNIGNORE = "site/";

// Reconciles `<projectDir>/.gitignore` by line rather than by overwrite: a project's
// own entries — a build directory, an editor's scratch file, whatever a team added —
// are none of the pipeline's business and are left exactly where they are. Only two
// edits are ever made: append a required line that is missing, and drop a line that is
// exactly `site/`. Returns true when the file was rewritten.
export function reconcileGitignore(projectDir) {
  const path = join(projectDir, ".gitignore");
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = before.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.filter((l) => l.trim() !== UNIGNORE);
  for (const want of REQUIRED_IGNORES) if (!kept.some((l) => l.trim() === want)) kept.push(want);
  const after = kept.length ? `${kept.join("\n")}\n` : "";
  if (after === before) return false;
  writeFileSync(path, after);
  return true;
}

// Stages the generated state site for whatever commit the caller is about to make.
// A project whose `.gitignore` still ignores `site/` would otherwise commit nothing at
// all here and silently keep an untracked site, so the ignore is reconciled away first
// and the reconciled `.gitignore` staged alongside. Staging goes through `stageAll`, so
// a page the site no longer generates is recorded as removed rather than left behind.
export function stageSite(projectDir) {
  if (gitOk(["check-ignore", "-q", "--", "site"], projectDir)) reconcileGitignore(projectDir);
  const paths = [];
  if (existsSync(join(projectDir, "site"))) paths.push("site");
  else if (git(["ls-files", "--", "site"], projectDir)) paths.push("site");
  if (existsSync(join(projectDir, ".gitignore"))) paths.push(".gitignore");
  stageAll(projectDir, paths);
}

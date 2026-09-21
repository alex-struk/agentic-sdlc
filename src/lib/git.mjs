import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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

// The identity every commit this pipeline makes on the caller's behalf is authored with.
// Passed as `-c` overrides rather than written into the repository's own config, so a
// person's `user.name`/`user.email` is left alone and a pipeline commit is still
// distinguishable from theirs in `git log`.
//
// `commit.gpgsign=false` and `tag.gpgsign=false` are part of the identity, not an extra:
// a machine identity has no key, so on a machine (or a repository) where signing is
// turned on globally every commit here would fail with `gpg failed to sign the data` —
// a pipeline that cannot record a ruling on a developer's own laptop because of a
// setting that has nothing to do with the pipeline. The overrides are scoped to these
// commands alone and change nothing a person's own `git commit` does.
export const SDLC_AUTHOR = ["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost",
  "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];

export function git(args, cwd) {
  return gitRaw(args, cwd).trim();
}

export function gitOk(args, cwd) {
  try { git(args, cwd); return true; } catch { return false; }
}

// `.gitignore` is project hygiene, and it belongs to the project rather than to any one
// branch of it. A proposal branch carries the ignore rules of the day it was opened, so a
// directory the project learned to ignore since — a build output, a runtime's own mirror
// — reappears as untracked dirt the moment a ruling checks that branch out, and every
// command that needs a clean tree refuses on files nobody touched.
//
// `main`'s copy is passed as an additional excludes file, which git unions with whatever
// the checked-out branch says: a path ignored on either is ignored. The file is written
// once per call into a temporary directory, never into the project.
function statusArgs(projectDir, extra = []) {
  const fromMain = gitOk(["cat-file", "-e", "main:.gitignore"], projectDir)
    ? git(["show", "main:.gitignore"], projectDir) : "";
  if (!fromMain) return ["status", ...extra];
  const path = join(mkdtempSync(join(tmpdir(), "sdlc-ignore-")), "ignore");
  writeFileSync(path, `${fromMain}\n`);
  return ["-c", `core.excludesFile=${path}`, "status", ...extra];
}

// A gate command commits on the caller's behalf, so it must not sweep in whatever else
// happened to be in the tree: the record of a ruling has to contain the ruling and
// nothing else. Commands check first and stage by name afterwards.
export function assertCleanTree(projectDir, command) {
  const dirty = git(statusArgs(projectDir, ["--porcelain"]), projectDir);
  if (!dirty) return;
  const paths = dirty.split("\n").map((l) => `  ${l.trim()}`).join("\n");
  throw new Error(`${command}: the working tree has uncommitted changes. Commit or stash them first:\n${paths}`);
}

// `git status --porcelain` under the same ignore rules `assertCleanTree` uses.
export function porcelainStatus(projectDir) {
  return git(statusArgs(projectDir, ["--porcelain"]), projectDir);
}

// The branch the working tree is on, or "HEAD" when it is detached.
export function currentBranch(projectDir) {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], projectDir);
}

// A run has to start from `main` for the same reason it has to start from a clean tree:
// everything downstream assumes it. `propose` opens a proposal branch off `main`, the
// persona's diff is `main...proposal/<name>`, and `checkProposalNotOpen` reads
// `git branch --merged main` — so a run started on a leftover proposal branch would branch
// off that branch, diff against the wrong base, and produce a proposal carrying the
// previous proposal's changes as if they were its own. Checked before any agent turn, so
// nothing has been spent by the time it fails.
export function assertOnMain(projectDir, command) {
  const branch = currentBranch(projectDir);
  if (branch !== "main") throw new Error(`${command} must start on main; you are on ${branch}`);
}

// Puts the working tree on `branch` for a caller that means to put it back afterwards,
// and refuses before it touches anything when that cannot be done safely. Two refusals:
// a branch name nothing resolves to, and a dirty tree, whose changes `git checkout`
// carries onto the branch and then back again — a command that borrows a branch must
// return the tree exactly as it found it, and it cannot promise that for changes it did
// not make. `leaveBranch` below is the other half; every caller of one calls the other.
//
// The value returned is what HEAD was pointing at, which is a branch name normally and a
// commit hash when HEAD was already detached — `git checkout HEAD` means something else
// entirely, so the name `git rev-parse --abbrev-ref` prints for a detached HEAD is never
// what gets checked out again.
export function enterBranch(projectDir, branch, command) {
  if (!gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], projectDir))
    throw new Error(`${command}: there is no branch ${branch} in this repository`);
  assertCleanTree(projectDir, command);
  const name = currentBranch(projectDir);
  const start = name === "HEAD" ? git(["rev-parse", "HEAD"], projectDir) : name;
  if (name !== branch) git(["checkout", "-q", branch], projectDir);
  return start;
}

// The other half of `enterBranch`: back to where HEAD was, but only once the branch it is
// leaving is clean. Work that throws part-way can leave a staged or untracked file behind,
// and `git checkout` succeeds with that residue present and carries it across — onto
// `main`, usually, where every command that needs a clean tree then refuses on files
// nobody there touched. So a dirty tree stays on the branch that produced it, visible
// where it was made, and the porcelain status is handed back rather than an empty string
// so the caller can name the residue and say where HEAD was left.
export function leaveBranch(projectDir, start) {
  const dirty = porcelainStatus(projectDir);
  if (dirty) return dirty;
  if (currentBranch(projectDir) !== start) git(["checkout", "-q", start], projectDir);
  return "";
}

// Merges `ref` into the branch that is checked out, and leaves nothing half-merged either
// way. A conflict is answered rather than thrown: the paths git could not reconcile are
// read out of the index first, the merge is aborted so the tree goes back to exactly what
// it was, and the caller decides what a stale branch means to it.
//
// `rule.mjs`'s own `mergeApproved` is not this function and is not replaced by it: that
// one merges a proposal INTO `main`, moving the caller between branches to do it, and its
// unwind has to put them back on the proposal. This merges the other direction, on the
// branch the caller is already standing on, and moves nobody.
export function mergeInto(projectDir, ref, message) {
  try {
    git([...SDLC_AUTHOR, "merge", "-q", "--no-ff", "-m", message, ref], projectDir);
    return { ok: true, conflicts: [] };
  } catch (e) {
    const listed = gitOk(["diff", "--name-only", "--diff-filter=U"], projectDir)
      ? git(["diff", "--name-only", "--diff-filter=U"], projectDir) : "";
    const conflicts = listed ? listed.split("\n").filter(Boolean) : [];
    // `--abort` refuses when there is no merge in progress — a merge git declined to
    // start at all, over a file it would have to overwrite — and the tree is already
    // untouched in that case, so the refusal is not itself a failure.
    gitOk(["merge", "--abort"], projectDir);
    return { ok: false, conflicts, message: e.message };
  }
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
//
// This never retries with `-f`, and must not: git refusing a named path here because it
// is ignored is a safety property, not friction to route around. The one path this
// pipeline itself deliberately force-adds is `site`, handled by `stageSite` below
// *before* a caller builds its own batch — a caller that excludes what `stageSite`
// returned never names an ignored path here at all. Every other refusal means the named
// path was tracked and has since been added to `.gitignore` (the "committed by
// accident, now excluded" pattern, or an equivalent `git rm --cached` a person or an
// agent ran without committing it): silently forcing it back into the index is exactly
// the failure this function exists to not have. The error is re-thrown naming the
// offending path(s), parsed out of git's own message where its shape matches, falling
// back to git's raw message otherwise.
export function stageAll(projectDir, paths) {
  if (paths.length === 0) return;
  try {
    git(["add", "-A", "--", ...paths], projectDir);
  } catch (e) {
    if (!/ignored by one of your \.gitignore files/.test(e.message)) throw e;
    const match = e.message.match(/ignored by one of your \.gitignore files:\n([\s\S]*?)\n(?:hint:)/);
    const named = match ? match[1].split("\n").filter(Boolean).join(", ") : null;
    throw new Error(named
      ? `stageAll: refusing to add ${named} — tracked before and now matched by .gitignore. If it was committed by accident and is meant to stay excluded, run 'git rm --cached' on it and commit that first; if it belongs in the repo, remove the rule from .gitignore instead. Nothing was staged for it.`
      : `stageAll: git refused a path in this batch as ignored by .gitignore, but its message did not parse:\n${e.message}`);
  }
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
// `-uall` because git otherwise reports a directory it has never tracked as the directory
// alone (`design/.storybook/`), not the files inside it. Every caller matches on files:
// `propose` checks each dirty path against the exact paths a stage handed it, and the
// stage checks filter by extension, so a new domain's first `tests/acceptance/<domain>/`
// would reach `checkDeriveTestsBlindHeader` as one path ending in `/` and none of its spec
// files would be read. Ignored files are still left out, so `node_modules` is never walked.
export function changedPaths(projectDir) {
  const out = gitRaw(statusArgs(projectDir, ["--porcelain", "-z", "-uall"]), projectDir);
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
  "sources/",
  // The acceptance harness's own output, not caught by any pattern above: `node_modules/`
  // matches at any depth so `tests/node_modules/` is already covered, but Playwright
  // writes its results and HTML report to two directories of their own under `tests/`.
  "tests/test-results/",
  "tests/playwright-report/",
  // The design catalogue's built Storybook: megabytes of generated assets, rebuilt by
  // every scan. `design/report.json`, which the scan also writes, is deliberately absent —
  // it is the evidence a design gate is ruled on and belongs in the history.
  "design/storybook-static/",
  // The agent runtime mirrors the skills it is given into `.agents/skills/`. `init`
  // installs and tracks the canonical copy under `.claude/skills/`, so the mirror is
  // the same text a second time, rewritten by every turn — and left untracked it is
  // dirt that stops the next command needing a clean tree.
  ".agents/",
  // Same again for the Codex-compatible hook configuration a runtime writes beside it.
  ".codex/",
];
const UNIGNORE = "site/";

// Reconciles `<projectDir>/.gitignore` by line rather than by overwrite: a project's
// own entries — a build directory, an editor's scratch file, whatever a team added —
// are none of the pipeline's business and are left exactly where they are. Only two
// edits are ever made: append a required line that is missing, and drop a line that is
// exactly `site/`. Returns true when the file was rewritten.
// `extra` is what the project's stack profile declares as its own generated output
// (`ignore:` in the profile's front matter). It is the stack that knows which
// directories its toolchain writes, so the list above — which every project gets —
// stays about the pipeline's own artifacts.
export function reconcileGitignore(projectDir, extra = []) {
  const path = join(projectDir, ".gitignore");
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = before.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.filter((l) => l.trim() !== UNIGNORE);
  for (const want of [...REQUIRED_IGNORES, ...extra]) if (!kept.some((l) => l.trim() === want)) kept.push(want);
  const after = kept.length ? `${kept.join("\n")}\n` : "";
  if (after === before) return false;
  writeFileSync(path, after);
  return true;
}

// Stages the generated state site for whatever commit the caller is about to make, and
// returns the project-relative paths it staged (a subset of ["site", ".gitignore"]) so
// a caller that goes on to stage a wider batch of its own through `stageAll` can leave
// these back out of it — naming an already-staged, still-ignored path there would make
// `stageAll` refuse the whole batch (see its own comment), even though nothing further
// needs recording for it here.
//
// A project whose `.gitignore` still ignores `site/` would otherwise commit nothing at
// all here and silently keep an untracked site, so the ignore is reconciled away first.
// `.gitignore` itself is only staged when `reconcileGitignore` actually rewrote it — a
// project's own uncommitted edit to that file is none of this command's business and
// must not be swept in just because the site happened to be staged in the same run.
//
// Reconciling only removes an exact `site/` line (see `UNIGNORE` above), so a pattern
// that also matches the directory — `/site/`, a broader glob, a rule in a parent
// `.gitignore` — survives untouched. Rather than leave the site silently untracked in
// that case, `check-ignore` is asked again after reconciling and, if it still says the
// path is ignored, the site is force-added and the rule responsible is named on stderr
// so a person can go fix their own ignore file instead of it happening invisibly. This
// is the one place in the whole pipeline allowed to force an add: `stageAll` itself
// never does.
export function stageSite(projectDir) {
  const gitignoreChanged = reconcileGitignore(projectDir);
  const paths = [];
  if (existsSync(join(projectDir, "site"))) paths.push("site");
  else if (git(["ls-files", "--", "site"], projectDir)) paths.push("site");
  if (gitignoreChanged) paths.push(".gitignore");

  const stillIgnored = paths.includes("site") && gitOk(["check-ignore", "-q", "--", "site"], projectDir);
  if (stillIgnored) {
    const rule = git(["check-ignore", "-v", "--", "site"], projectDir);
    console.warn(`warning: site/ is still ignored after reconciling .gitignore (${rule}); staging it anyway`);
  }
  stageAll(projectDir, stillIgnored ? paths.filter((p) => p !== "site") : paths);
  if (stillIgnored) git(["add", "-Af", "--", "site"], projectDir);
  return paths;
}

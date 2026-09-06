import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    // execFileSync's own message is "Command failed: git ...", which drops the reason git
    // printed. The reason is on stderr, and for a few commands (a conflicted merge, for
    // one) on stdout instead, so both are tried before falling back to the raw message.
    const stderr = (e.stderr ?? "").toString().trim();
    const stdout = (e.stdout ?? "").toString().trim();
    throw new Error(`git ${args.join(" ")} failed:\n${stderr || stdout || e.message}`);
  }
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

// Stages exactly the given project-relative paths. A path the command did not end up
// writing (a run record on a command that wrote none, say) is skipped rather than
// making `git add` fail.
export function stagePaths(projectDir, paths) {
  const present = paths.filter((p) => existsSync(join(projectDir, p)));
  if (present.length) git(["add", "--", ...present], projectDir);
}

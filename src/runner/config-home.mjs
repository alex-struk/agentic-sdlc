import { existsSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export function configHomePath() {
  return process.env.SDLC_CLAUDE_HOME
    ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agentic-sdlc", "claude-home");
}
export function credentialsSource() {
  return process.env.SDLC_CREDENTIALS ?? join(homedir(), ".claude", ".credentials.json");
}
export function ensureConfigHome() {
  const home = configHomePath();
  mkdirSync(home, { recursive: true });
  const link = join(home, ".credentials.json");
  const src = credentialsSource();
  // An operator who points SDLC_CREDENTIALS at the link path itself (or otherwise
  // arranges for the two to resolve the same) must not have that file touched: the
  // rm/symlink dance below is written for the case where they differ, and run against
  // one path it deletes the operator's own credentials and then symlinks the now-empty
  // path to itself.
  if (resolve(link) === resolve(src)) return home;
  if (existsSync(src)) {
    // Whatever is at that path goes, symlink or not. Only a stale *symlink* used to be
    // replaced, so a real credentials file left there by anything else — a copy someone
    // made, a directory — survived and was read instead of the operator's own, which is
    // the one thing this directory exists to get right. `force` makes the usual case
    // (nothing there at all) a no-op.
    rmSync(link, { recursive: true, force: true });
    symlinkSync(src, link);
  }
  return home;
}

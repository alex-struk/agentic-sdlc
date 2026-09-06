import { existsSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
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

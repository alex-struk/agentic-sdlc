import { existsSync, mkdirSync, symlinkSync, lstatSync, unlinkSync } from "node:fs";
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
    try { if (lstatSync(link).isSymbolicLink()) unlinkSync(link); } catch {}
    if (!existsSync(link)) symlinkSync(src, link);
  }
  return home;
}

import { existsSync, lstatSync, statSync, mkdirSync, symlinkSync, rmSync, chmodSync } from "node:fs";
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
  // A live credential lives in this directory, so no other account on the machine has
  // any business listing it. The mode is set on every call, not only at creation: a
  // directory made under a looser umask before this would otherwise keep whatever it
  // was made with.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const link = join(home, ".credentials.json");
  const src = credentialsSource();
  // An operator who points SDLC_CREDENTIALS at the link path itself (or otherwise
  // arranges for the two to resolve the same) must not have that file touched: the
  // rm/symlink dance below is written for the case where they differ, and run against
  // one path it deletes the operator's own credentials and then symlinks the now-empty
  // path to itself.
  if (resolve(link) === resolve(src)) return home;
  if (!existsSync(src)) return home;
  // A session refreshes its own OAuth token when it approaches expiry and persists the
  // result by writing a new file and renaming it over `.credentials.json`. A rename
  // replaces the NAME, so a refresh does not follow the symlink through to the source:
  // it leaves a regular file here, holding the only copy of the refreshed credential.
  // Relinking over that file discards the refresh, and the next session starts from the
  // credential the last one already found too old — which is how runs come to fail for
  // an expired session while an interactive one, holding a credential of its own, keeps
  // working.
  //
  // So a regular file newer than the source stays and is what the next session reads.
  // Everything else is replaced: a symlink (the ordinary case, and a stale one when the
  // source has moved), a directory, and a file the source has overtaken — which is what
  // makes signing in interactively the way back from a credential this directory can no
  // longer refresh, and what keeps a copy somebody left here from standing in for the
  // operator's own.
  const here = lstatSync(link, { throwIfNoEntry: false });
  if (here?.isFile() && here.mtimeMs > statSync(src).mtimeMs) return home;
  rmSync(link, { recursive: true, force: true });
  symlinkSync(src, link);
  return home;
}

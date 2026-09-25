import { existsSync, lstatSync, statSync, mkdirSync, symlinkSync, rmSync, chmodSync, copyFileSync, utimesSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { writeText } from "../lib/fsx.mjs";

function configRoot() {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agentic-sdlc");
}

export function configHomePath() {
  return process.env.SDLC_CLAUDE_HOME ?? join(configRoot(), "claude-home");
}
export function credentialsSource() {
  return process.env.SDLC_CREDENTIALS ?? join(homedir(), ".claude", ".credentials.json");
}

// The directory a Codex session is pointed at through `CODEX_HOME`, the Codex counterpart of
// `configHomePath`: owned by the pipeline, holding the operator's sign-in and the one hook the
// pipeline registers, and none of the operator's own configuration, rules or instructions.
export function codexHomePath() {
  return process.env.SDLC_CODEX_HOME ?? join(configRoot(), "codex-home");
}
// Where the operator's own Codex sign-in lives: `auth.json` in the directory their CLI uses,
// which is `CODEX_HOME` when they set one and `~/.codex` otherwise. Named, never opened.
export function codexCredentialsSource() {
  return process.env.SDLC_CODEX_CREDENTIALS ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
}

// Makes `home` a private directory whose `name` entry is the operator's credential at `src`.
// Shared by both backends, because the rules are properties of a credential a session
// refreshes by rename rather than of either CLI (`docs/decisions/0035`).
function ensureHome(home, name, src) {
  // A live credential lives in this directory, so no other account on the machine has any
  // business listing it. The mode is set on every call, not only at creation: a directory
  // made under a looser umask before this would otherwise keep whatever it was made with.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const link = join(home, name);
  // An operator who points the source at the link path itself (or otherwise arranges for
  // the two to resolve the same) must not have that file touched: the rm/symlink dance
  // below is written for the case where they differ, and run against one path it deletes
  // the operator's own credentials and then symlinks the now-empty path to itself.
  if (resolve(link) === resolve(src)) return home;
  if (!existsSync(src)) return home;
  // A session refreshes its own token when it approaches expiry and persists the result by
  // writing a new file and renaming it over the credential. A rename replaces the NAME, so
  // a refresh does not follow the symlink through to the source: it leaves a regular file
  // here, holding the only copy of the refreshed credential. Relinking over that file
  // discards the refresh, and the next session starts from the credential the last one
  // already found too old.
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

export function ensureConfigHome() {
  return ensureHome(configHomePath(), ".credentials.json", credentialsSource());
}

// The project's implement guard, registered for every tool call a Codex session makes. A
// Claude session gets the same guard from the project's own `.claude/settings.json`; Codex
// reads no such file, so the pipeline registers it here, in the home it owns. The command
// names the guard relative to the session's working root, where the project keeps its copy
// (`sdlc init` installs it at `.sdlc/hooks/`), so a project's own edits to the guard are what
// runs, and no local path is written anywhere. A workspace with no copy is one the guard was
// never going to run in — an ephemeral workspace carries no `.sdlc/hooks` for a Claude
// session either — and the hook passes rather than failing every tool call there.
//
// No matcher: Codex edits files through a patch rather than through tools named like
// Claude's, and the guard reads the paths out of either shape (`templates/hooks/`).
export const CODEX_HOOKS = {
  hooks: {
    PreToolUse: [{
      hooks: [{
        type: "command",
        command: "if [ -f .sdlc/hooks/implement-guard.sh ]; then exec bash .sdlc/hooks/implement-guard.sh; fi",
        timeout: 30,
      }],
    }],
  },
};

export function ensureCodexHome() {
  const home = ensureHome(codexHomePath(), "auth.json", codexCredentialsSource());
  writeText(join(home, "hooks.json"), JSON.stringify(CODEX_HOOKS, null, 2) + "\n");
  return home;
}

// A copy of a pipeline home for one isolated session (`docs/decisions/0061`): the credential,
// read through the link to the operator's own, and the files named in `files`, into `dest`,
// which is private to the account. The credential keeps its source's modification time, so a
// copy the session never touched is not mistaken for a refresh when it comes back. Nothing
// else of the home is copied, and nothing reads what the credential holds.
export function copyHome(home, credential, files, dest) {
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  chmodSync(dest, 0o700);
  const src = join(home, credential);
  const st = statSync(src, { throwIfNoEntry: false });
  if (st?.isFile()) {
    const to = join(dest, credential);
    copyFileSync(src, to);
    chmodSync(to, 0o600);
    utimesSync(to, st.atime, st.mtime);
  }
  for (const f of files) if (existsSync(join(home, f))) copyFileSync(join(home, f), join(dest, f));
  return dest;
}

// The credential an isolated session leaves in its copy of the home, kept in the pipeline's
// own home when it is newer than the one there: the rule `0035` sets for a refresh, applied
// across the container boundary. It replaces the link by rename, as a refresh on the host
// does, so it lands as a regular file that `ensureHome` keeps while it is the newer of the
// two. Returns whether it was kept.
export function keepRefreshed(copyDir, home, credential) {
  const copy = join(copyDir, credential);
  const st = lstatSync(copy, { throwIfNoEntry: false });
  if (!st?.isFile() || st.size === 0) return false;
  const target = join(home, credential);
  const current = statSync(target, { throwIfNoEntry: false });
  if (current && st.mtimeMs <= current.mtimeMs) return false;
  const tmp = join(home, `.${credential}.${process.pid}.tmp`);
  copyFileSync(copy, tmp);
  chmodSync(tmp, 0o600);
  utimesSync(tmp, st.atime, st.mtime);
  renameSync(tmp, target);
  return true;
}

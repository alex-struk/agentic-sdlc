// Where `sdlc oracle` records which ports it chose, so the same command run again finds
// a running oracle instead of choosing new ports and starting a second copy, and so
// later stages (`bind-adapter`, `calibrate`) know where to point without re-deriving
// anything. One file per target (`.sdlc/oracle-<target>.local.yaml`) rather than one
// shared file, since a project can configure more than one oracle target over its life
// and each one's ports are independent. Untracked (see templates/project/.gitignore):
// ports are a fact about this machine's current run, not something to commit.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { writeText } from "../lib/fsx.mjs";
import { portIsFree } from "../lib/ports.mjs";

function localPath(projectDir, target) {
  return join(projectDir, ".sdlc", `oracle-${target}.local.yaml`);
}

export function readLocal(projectDir, target) {
  const p = localPath(projectDir, target);
  return existsSync(p) ? parse(readFileSync(p, "utf8")) : null;
}

export function writeLocal(projectDir, target, data) {
  return writeText(localPath(projectDir, target), stringify(data));
}

export function removeLocal(projectDir, target) {
  const p = localPath(projectDir, target);
  if (existsSync(p)) unlinkSync(p);
}

// Picks a free port: `prefer` first when given (so a project's configured `base_url`
// port is kept whenever nothing else is already using it), otherwise scanning upward
// from `from` until one binds. When `prefer` and `from` are the same port and it is
// taken, the scan starts one above it rather than re-testing the port the line above
// already found taken.
export async function freePort(prefer, from) {
  if (prefer && (await portIsFree(prefer))) return prefer;
  let port = from === prefer ? from + 1 : from;
  while (!(await portIsFree(port))) port++;
  return port;
}

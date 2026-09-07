// Where `sdlc oracle` records which ports it chose, so the same command run again finds
// a running oracle instead of choosing new ports and starting a second copy, and so
// later stages (`bind-adapter`, `calibrate`) know where to point without re-deriving
// anything. One file per target (`.sdlc/oracle-<target>.local.yaml`) rather than one
// shared file, since a project can configure more than one oracle target over its life
// and each one's ports are independent. Untracked (see templates/project/.gitignore):
// ports are a fact about this machine's current run, not something to commit.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { writeText } from "../lib/fsx.mjs";

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

// Whether `port` is free to bind on this machine right now, tested the only way that is
// actually reliable — opening a real listening socket rather than asking the OS for a
// list of ports in use, which differs by platform and misses ports a process holds
// without a listener. Bound to 127.0.0.1 specifically: the oracle is published for this
// machine only, so a port free on the loopback interface is what matters, not on every
// interface the host has.
function tryPort(port) {
  return new Promise((resolvePort) => {
    const srv = createServer();
    srv.once("error", () => resolvePort(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolvePort(true)));
  });
}

// Picks a free port: `prefer` first when given (so a project's configured `base_url`
// port is kept whenever nothing else is already using it), otherwise scanning upward
// from `from` until one binds.
export async function freePort(prefer, from) {
  if (prefer && (await tryPort(prefer))) return prefer;
  let port = from;
  while (!(await tryPort(port))) port++;
  return port;
}

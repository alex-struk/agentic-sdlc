// Whether a host port can be bound on this machine right now, and what is holding it when
// it cannot. `src/oracle/ports.mjs` is a different thing with a similar name: that one
// records which ports an oracle target settled on, this one answers the question it
// settles them by, and every caller that needs the answer comes here for it.
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";

function defaultExec(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// Tested by opening a real listening socket, which is the only reliable way: asking the
// OS for a list of ports in use differs by platform and misses a port a process holds
// without a listener. Bound on every interface rather than on the loopback alone, because
// that is what publishing a host port does, and a port held on one interface refuses a
// bind that covers it.
//
// Only `EADDRINUSE` answers the question asked. A port below 1024 refuses an unprivileged
// bind with `EACCES` while the Docker daemon — which is what actually publishes it — is
// not bound by that, so every other error reads as nothing known against the port rather
// than as the port being taken.
export function portIsFree(port) {
  return new Promise((done) => {
    const srv = createServer();
    srv.once("error", (e) => done(e?.code !== "EADDRINUSE"));
    srv.listen(port, () => srv.close(() => done(true)));
  });
}

// A container of some other compose project is the likeliest thing to be holding a port
// the sandbox wants, and `docker` is already this command's own dependency, so it is asked
// first. `{{.Ports}}` renders a published port as `0.0.0.0:8080->3000/tcp`, and it is the
// host side — the part before the arrow — that can collide.
function containerOn(port, exec) {
  let r;
  try { r = exec("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"]); }
  catch { return ""; }
  if (!r || r.status !== 0) return "";
  for (const line of String(r.stdout ?? "").split("\n")) {
    const [name, ports = ""] = line.split("\t");
    if (name && ports.split("->").slice(0, -1).some((h) => h.endsWith(`:${port}`))) return name;
  }
  return "";
}

// Anything else listening, named by `lsof`'s field output (`-F`), which prints one
// `p<pid>`/`c<command>` pair per line and nothing else — no user, no path, so there is
// nothing here that must not be written down. Without privileges it answers for this
// user's own processes and stays silent about everyone else's, which is the right
// failure: an unanswered question reads as unanswered.
function listenerOn(port, exec) {
  let r;
  try { r = exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fcp"]); }
  catch { return ""; }
  if (!r || !String(r.stdout ?? "").trim()) return "";
  let pid = "";
  let command = "";
  for (const line of String(r.stdout).split("\n")) {
    if (line.startsWith("p") && !pid) pid = line.slice(1).trim();
    if (line.startsWith("c") && !command) command = line.slice(1).trim();
  }
  if (!command) return "";
  return pid ? `${command} (pid ${pid})` : command;
}

// What is holding `port`, as a phrase to put in a sentence, or `""` when nothing could be
// established. Best effort by construction, and never a refusal on its own: the port being
// taken is what the caller acts on, and this only says what by.
export function portHolder(port, exec = defaultExec) {
  const container = containerOn(port, exec);
  if (container) return `the container ${container}`;
  return listenerOn(port, exec);
}

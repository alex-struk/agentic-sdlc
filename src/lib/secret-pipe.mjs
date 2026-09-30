import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

// Secrets an MCP server reads as a dotenv file, handed over through a named pipe (a FIFO)
// rather than a file, because a credential never goes into a file on disk: a FIFO has a
// path but no content, and what is written into it lives in a kernel buffer only until the
// reader takes it. The Playwright MCP server reads its `--secrets` path once, with
// `readFileSync`, when it starts, which a FIFO satisfies exactly like a file
// (`docs/decisions/0077`).
//
// The pipe is offered rather than pushed: every `POLL_MS` the writer end is opened
// non-blocking, which fails at once while nobody is reading, and when a reader is there
// the dotenv text is written in one piece and the writer closed, so the reader sees the
// text and then end-of-file. Serving continues until `close()`, so a server the CLI
// restarts mid-session reads the same text again. A blocking open would sit in libuv's
// thread pool waiting for a reader, and whichever way `close()` then released it, a race
// with that open could leave it waiting for good and the runner unable to exit; nothing
// here is ever pending, and the timer is unref'd, so an open pipe never holds the process
// up.
const POLL_MS = 25;

// Returns `{ path, close }`, or `null` when no value is non-empty: a server given an empty
// secret would type an empty string where the name was, so it is better given none.
export function openSecretPipe(dir, values) {
  const entries = Object.entries(values ?? {}).filter(([, v]) => typeof v === "string" && v !== "");
  if (!entries.length) return null;
  const text = entries.map(([name, value]) => `${dotenvName(name)}=${dotenvQuote(name, value)}\n`).join("");
  const path = join(dir, "mcp-secrets.env");
  execFileSync("mkfifo", ["-m", "600", path], { stdio: "ignore" });

  let closed = false;
  let timer = null;
  const offer = () => {
    if (closed) return;
    let fd;
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch {
      // ENXIO: nobody is reading yet.
      schedule();
      return;
    }
    // Under PIPE_BUF (4096 bytes) a write to a pipe is atomic, so a reader gets the whole
    // text or none of it. A reader still draining the previous copy when the next is
    // offered reads the same lines twice, which a dotenv parse reads as the same values.
    try { writeSync(fd, text); } catch { /* the reader left before the write */ }
    closeSync(fd);
    schedule();
  };
  const schedule = () => {
    timer = setTimeout(offer, POLL_MS);
    timer.unref();
  };
  schedule();

  return {
    path,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      // A reader already blocked opening the pipe would otherwise wait for a writer that
      // never comes. Opening and closing a writer releases it with end-of-file.
      try { closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK)); } catch { /* nobody reading */ }
      rmSync(path, { force: true });
    },
  };
}

function dotenvName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`secret name ${JSON.stringify(name)} is not a plain variable name`);
  return name;
}

// Dotenv strips one pair of matching quotes and expands `\n` and `\r` only inside double
// quotes, so a value is quoted with the first quote character it does not contain, taking
// double quotes only where there is no backslash for the expansion to change. A value no
// quoting reproduces exactly is refused rather than delivered altered, and the refusal
// names the variable, never the value.
function dotenvQuote(name, value) {
  if (!/[\r\n]/.test(value)) {
    if (!value.includes("'")) return `'${value}'`;
    if (!value.includes("`")) return `\`${value}\``;
    if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  }
  throw new Error(`${name} cannot be written as a dotenv value exactly (it holds a line break, or every kind of quote), so the browser tool cannot be given it`);
}

// The stage's `mcpSecrets` applied to the servers its `mcp` declares: a pipe opened in
// `dir` and `--secrets <pipe>` appended to the named server's arguments, so the MCP config
// written from the result holds only the pipe's path. `pipe` is `null` where nothing was
// opened, and otherwise must be closed by the caller once the session is over.
export function withMcpSecrets(dir, mcpServers, secrets) {
  if (!mcpServers || !secrets) return { mcpServers, pipe: null };
  const server = mcpServers[secrets.server];
  if (!server) throw new Error(`mcpSecrets names the MCP server "${secrets.server}", which this stage does not declare`);
  const pipe = openSecretPipe(dir, secrets.values);
  if (!pipe) return { mcpServers, pipe: null };
  return {
    mcpServers: { ...mcpServers, [secrets.server]: { ...server, args: [...(server.args ?? []), "--secrets", pipe.path] } },
    pipe,
  };
}

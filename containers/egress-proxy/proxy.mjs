// The forward proxy an isolated agent session reaches the network through
// (`docs/decisions/0061-an-agent-session-in-a-container.md`). The session's container sits on
// a Docker network with no route out; this proxy is the one other container on it, and the
// only one with a second network that has a route. What it lets through is therefore the
// whole of the session's egress.
//
// It allows an HTTPS tunnel (`CONNECT host:port`) or a plain HTTP request (absolute-form
// URL) to a host its allowlist names and refuses everything else with 403. The allowlist
// arrives as `SDLC_EGRESS_ALLOW`, comma-separated: `host`, `*.domain` (subdomains only, never
// the bare domain), either with `:port`. An entry without a port allows 443 and 80. An
// address is allowed only where it is named exactly. Each decision is one line on stdout
// naming the host and port, which is all a person needs to see what a session tried to reach;
// nothing a request carries is logged.
//
// Node's standard library only, so the image is the Node base image and this file.
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

const WEB_PORTS = new Set([443, 80]);

export function parseAllowlist(text) {
  return String(text ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).map((entry) => {
    const m = entry.match(/^(.*?)(?::(\d+))?$/);
    return { host: m[1], port: m[2] ? Number(m[2]) : null };
  });
}

function normalise(host) {
  return String(host ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function allowed(entries, host, port) {
  const h = normalise(host);
  const p = Number(port);
  const isAddress = net.isIP(h) !== 0;
  return entries.some((e) => {
    if (e.port === null ? !WEB_PORTS.has(p) : e.port !== p) return false;
    if (e.host === h) return true;
    return !isAddress && e.host.startsWith("*.") && h.endsWith(e.host.slice(1));
  });
}

// `host:port` of a CONNECT target, with a bracketed IPv6 address kept whole.
function splitTarget(target) {
  const m = String(target).match(/^\[?([^\]]*?)\]?:(\d+)$/);
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

export function createEgressProxy(entries, log = (line) => console.log(line)) {
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url); } catch { res.writeHead(400).end("a forward proxy takes absolute-form requests only\n"); return; }
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    if (url.protocol !== "http:" || !allowed(entries, url.hostname, port)) {
      log(`deny ${req.method} ${normalise(url.hostname)}:${port}`);
      res.writeHead(403).end("egress to this host is not on the session's allowlist\n");
      return;
    }
    log(`allow ${req.method} ${normalise(url.hostname)}:${port}`);
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const up = http.request({ host: url.hostname, port, method: req.method, path: `${url.pathname}${url.search}`, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on("connect", (req, socket, head) => {
    socket.on("error", () => {});
    const t = splitTarget(req.url);
    if (!t || !allowed(entries, t.host, t.port)) {
      log(`deny CONNECT ${t ? `${normalise(t.host)}:${t.port}` : "(malformed)"}`);
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    log(`allow CONNECT ${normalise(t.host)}:${t.port}`);
    const up = net.connect(t.port, t.host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => {
      if (socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      else socket.destroy();
    });
    socket.on("close", () => up.destroy());
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const entries = parseAllowlist(process.env.SDLC_EGRESS_ALLOW);
  const port = Number(process.env.SDLC_EGRESS_PORT ?? 3128);
  createEgressProxy(entries).listen(port, () => console.log(`listening on ${port}, allowing ${entries.map((e) => (e.port ? `${e.host}:${e.port}` : e.host)).join(", ") || "nothing"}`));
  process.on("SIGTERM", () => process.exit(0));
}

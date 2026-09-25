import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { parseAllowlist, allowed, createEgressProxy } from "../containers/egress-proxy/proxy.mjs";

// The forward proxy an isolated agent session reaches the network through. It is the only
// thing on the session's network with a route out, so what it lets through is the whole of
// the session's egress.

test("an allowlist entry is a host, a *.domain wildcard, or either with a port", () => {
  assert.deepEqual(parseAllowlist("example.org, *.example.net ,registry.example.com:8443,,"), [
    { host: "example.org", port: null },
    { host: "*.example.net", port: null },
    { host: "registry.example.com", port: 8443 },
  ]);
  assert.deepEqual(parseAllowlist(""), []);
  assert.deepEqual(parseAllowlist(undefined), []);
});

test("a host is allowed when it is named, on the web ports unless the entry names another", () => {
  const list = parseAllowlist("example.org,registry.example.com:8443");
  assert.equal(allowed(list, "example.org", 443), true);
  assert.equal(allowed(list, "example.org", 80), true);
  assert.equal(allowed(list, "EXAMPLE.ORG.", 443), true);
  assert.equal(allowed(list, "example.org", 22), false);
  assert.equal(allowed(list, "registry.example.com", 8443), true);
  assert.equal(allowed(list, "registry.example.com", 443), false);
  assert.equal(allowed(list, "other.example", 443), false);
});

test("a wildcard covers subdomains and never the bare domain or a lookalike", () => {
  const list = parseAllowlist("*.example.net");
  assert.equal(allowed(list, "cdn.example.net", 443), true);
  assert.equal(allowed(list, "a.b.example.net", 443), true);
  assert.equal(allowed(list, "example.net", 443), false);
  assert.equal(allowed(list, "badexample.net", 443), false);
});

test("an address is allowed only when it is named exactly, never through a wildcard", () => {
  assert.equal(allowed(parseAllowlist("*.example.net"), "10.0.0.1", 443), false);
  assert.equal(allowed(parseAllowlist("127.0.0.1:9"), "127.0.0.1", 9), true);
  assert.equal(allowed(parseAllowlist("example.org"), "localhost", 443), false);
});

// ---- the proxy itself, against a local upstream ----------------------------------------------

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function connectThrough(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: target });
    req.on("connect", (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on("error", reject);
    req.end();
  });
}

function getThrough(proxyPort, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the proxy tunnels to an allowed host, refuses any other, and logs each decision by host alone", async () => {
  const upstream = net.createServer((s) => s.end("upstream says hi"));
  const upstreamPort = await listen(upstream);
  const log = [];
  const proxy = createEgressProxy(parseAllowlist(`127.0.0.1:${upstreamPort}`), (line) => log.push(line));
  const proxyPort = await listen(proxy);
  try {
    const ok = await connectThrough(proxyPort, `127.0.0.1:${upstreamPort}`);
    assert.equal(ok.status, 200);
    const body = await new Promise((resolve) => { let b = ""; ok.socket.on("data", (c) => { b += c; }); ok.socket.on("end", () => resolve(b)); });
    assert.equal(body, "upstream says hi");
    const denied = await connectThrough(proxyPort, "blocked.example:443");
    assert.equal(denied.status, 403);
    denied.socket.destroy();
    assert.ok(log.includes(`allow CONNECT 127.0.0.1:${upstreamPort}`), log.join("\n"));
    assert.ok(log.includes("deny CONNECT blocked.example:443"), log.join("\n"));
  } finally { proxy.close(); upstream.close(); }
});

test("the proxy forwards a plain request to an allowed host and refuses one to any other", async () => {
  const upstream = http.createServer((req, res) => res.end(`served ${req.url}`));
  const upstreamPort = await listen(upstream);
  const proxy = createEgressProxy(parseAllowlist(`127.0.0.1:${upstreamPort}`), () => {});
  const proxyPort = await listen(proxy);
  try {
    const ok = await getThrough(proxyPort, `http://127.0.0.1:${upstreamPort}/pkg`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "served /pkg");
    const denied = await getThrough(proxyPort, "http://blocked.example/pkg");
    assert.equal(denied.status, 403);
    // A request that is not addressed to a host at all is no forward request.
    const origin = await getThrough(proxyPort, "/pkg");
    assert.equal(origin.status, 400);
  } finally { proxy.close(); upstream.close(); }
});

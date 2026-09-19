import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetSettings, resetCommandFor } from "../src/sandbox/local.mjs";
import { sandboxUp, sandboxReset, sandboxDown } from "../src/commands/sandbox.mjs";
import { parseConfig } from "../src/config/load.mjs";

const CONFIG = { project: { name: "mkt" }, targets: { new: { base_url: "http://localhost:8080", identity: "sandbox-idp" } } };

test("a target's sandbox settings default to the stack's compose file and seed service", () => {
  assert.deepEqual(targetSettings(CONFIG, "new"), {
    baseUrl: "http://localhost:8080", identity: "sandbox-idp",
    compose: "app/compose/compose.yaml", seedService: "seed", project: "sdlc-mkt-new",
  });
  const custom = { ...CONFIG, targets: { new: { ...CONFIG.targets.new, compose: "ops/dev.yaml", seed_service: "load" } } };
  assert.equal(targetSettings(custom, "new").compose, "ops/dev.yaml");
  assert.equal(targetSettings(custom, "new").seedService, "load");
  assert.throws(() => targetSettings(CONFIG, "staging"), /unknown target staging/);
});

test("the config schema accepts compose and seed_service on a target", () => {
  const text = `pipeline: { repo: a, ref: main }\nprofile: greenfield\nstack: openshift-ts\nproject: { name: p, domains: [a] }\n`
    + `targets:\n  new: { base_url: "http://localhost:8080", identity: sandbox-idp, compose: app/compose/compose.yaml, seed_service: seed }\n`
    + `policy:\n  gates:\n    G0: { holder: tech-lead }\n    G1: { holder: tech-lead }\n    G-DESIGN: { holder: tech-lead }\n    G2: { holder: tech-lead }\n    G3: { holder: tech-lead }\n    G-POL: { holder: tech-lead }\n  default_tier: STANDARD\nskills: { packs: [] }\negress: { rules: [E-2] }\n`;
  assert.deepEqual(parseConfig(text).errors, []);
});

function project(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-sandbox-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  mkdirSync(join(d, "app", "compose"), { recursive: true });
  writeFileSync(join(d, "app", "compose", "compose.yaml"), "services: {}\n");
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  return d;
}

function recorder(responses = {}) {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push([cmd, ...args].join(" "));
    const key = Object.keys(responses).find((k) => [cmd, ...args].join(" ").includes(k));
    return key ? responses[key] : { status: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

test("up builds and starts the project's own compose file, waits for health, then seeds", async (t) => {
  const d = project(t);
  const { calls, exec } = recorder();
  const r = await sandboxUp(d, CONFIG, "new", { exec, health: async () => true });
  assert.equal(r.ok, true);
  assert.match(calls[0], /^docker compose -p sdlc-mkt-new -f app\/compose\/compose\.yaml up -d --build --wait/);
  assert.match(calls.at(-1), /^docker compose -p sdlc-mkt-new -f app\/compose\/compose\.yaml run --rm seed$/);
});

test("a project with no compose file is told what the stack expects, and nothing runs", async (t) => {
  const d = project(t);
  rmSync(join(d, "app", "compose", "compose.yaml"));
  const { calls, exec } = recorder();
  const r = await sandboxUp(d, CONFIG, "new", { exec, health: async () => true });
  assert.equal(r.ok, false);
  assert.match(r.messages[0], /app\/compose\/compose\.yaml is missing/);
  assert.deepEqual(calls, []);
});

test("an application that never answers its health check is reported, not seeded", async (t) => {
  const d = project(t);
  const { calls, exec } = recorder();
  const r = await sandboxUp(d, CONFIG, "new", { exec, health: async () => false });
  assert.equal(r.ok, false);
  assert.match(r.messages.join(" "), /did not answer at http:\/\/localhost:8080/);
  assert.ok(!calls.some((c) => c.includes("run --rm seed")));
});

// The password the sandbox identity provider's test users sign in with is passed to
// compose through the environment and nowhere else.
test("the sandbox password reaches compose by environment only", async (t) => {
  const d = project(t);
  const seen = [];
  const exec = (cmd, args, opts) => { seen.push({ args: args.join(" "), env: opts?.env ?? {} }); return { status: 0, stdout: "", stderr: "" }; };
  process.env.SDLC_SANDBOX_PASSWORD = "not-a-real-one";
  t.after(() => delete process.env.SDLC_SANDBOX_PASSWORD);
  await sandboxUp(d, CONFIG, "new", { exec, health: async () => true });
  assert.ok(seen.every((c) => !c.args.includes("not-a-real-one")));
  assert.equal(seen[0].env.SDLC_SANDBOX_PASSWORD, "not-a-real-one");
});

test("reset re-runs the seed service; down removes the project's containers and volumes", async (t) => {
  const d = project(t);
  const { calls, exec } = recorder();
  assert.equal(sandboxReset(d, CONFIG, "new", { exec }).ok, true);
  assert.match(calls[0], /run --rm seed$/);
  sandboxDown(d, CONFIG, "new", { exec });
  assert.match(calls[1], /^docker compose -p sdlc-mkt-new -f app\/compose\/compose\.yaml down -v$/);
  assert.equal(resetCommandFor(d, CONFIG, "new"),
    `docker compose -p sdlc-mkt-new -f ${join(d, "app/compose/compose.yaml")} run --rm seed`);
});

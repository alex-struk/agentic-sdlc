import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetSettings, resetCommandFor } from "../src/sandbox/local.mjs";
import { sandboxUp, sandboxReset, sandboxDown, runSandbox } from "../src/commands/sandbox.mjs";
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

// The application a `build` slice writes lives on its own proposal branch until a
// reviewer approves it, so `--from` is how anything on `main` starts it: the project
// below has a compose file on `proposal/build-slice-1` and none on `main`, which is the
// shape every slice is in between `build` and its G3 ruling.
const CONFIG_YAML = [
  "pipeline: { repo: a, ref: main }", "profile: greenfield", "stack: openshift-ts",
  "project: { name: mkt, domains: [users] }",
  "targets:", "  new: { base_url: \"http://localhost:8080\", identity: sandbox-idp }",
  "policy:", "  gates:",
  ...["G0", "G1", "G-DESIGN", "G2", "G3", "G-POL"].map((g) => `    ${g}: { holder: tech-lead }`),
  "  default_tier: STANDARD", "skills: { packs: [] }", "egress: { rules: [E-2] }", "",
].join("\n");

function branchProject(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-sandbox-branch-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@e.test"]);
  run(["config", "user.name", "t"]);
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "config.yaml"), CONFIG_YAML);
  run(["add", "-A"]); run(["commit", "-q", "-m", "start"]);
  run(["checkout", "-q", "-b", "proposal/build-slice-1"]);
  mkdirSync(join(d, "app", "compose"), { recursive: true });
  writeFileSync(join(d, "app", "compose", "compose.yaml"), "services: {}\n");
  run(["add", "-A"]); run(["commit", "-q", "-m", "build slice 1"]);
  run(["checkout", "-q", "main"]);
  return d;
}

const headOf = (d) => execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: d, encoding: "utf8" }).trim();

test("up --from builds the application a proposal branch carries and leaves HEAD where it found it", async (t) => {
  const d = branchProject(t);
  const { calls, exec } = recorder();
  const code = await runSandbox(d, "up", { target: "new", from: "proposal/build-slice-1" }, { exec, health: async () => true });
  assert.equal(code, 0);
  assert.match(calls[0], /^docker compose -p sdlc-mkt-new -f app\/compose\/compose\.yaml up -d --build --wait/);
  assert.match(calls.at(-1), /run --rm seed$/);
  // The containers run from the images that build produced, so the tree goes back: HEAD
  // on the branch it started on, and the branch's own files out of the way again.
  assert.equal(headOf(d), "main");
  assert.equal(existsSync(join(d, "app", "compose", "compose.yaml")), false);
});

test("down --from reaches the same stack from main, after HEAD has been put back", async (t) => {
  const d = branchProject(t);
  const calls = [];
  // Compose resolves `-f app/compose/compose.yaml` against the tree it runs in, so what
  // this has to show is that the file was there while docker ran, not only that the
  // right argument was passed.
  const exec = (cmd, args) => {
    calls.push({ line: [cmd, ...args].join(" "), composePresent: existsSync(join(d, "app", "compose", "compose.yaml")) });
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.equal(await runSandbox(d, "down", { target: "new", from: "proposal/build-slice-1" }, { exec }), 0);
  assert.match(calls[0].line, /^docker compose -p sdlc-mkt-new -f app\/compose\/compose\.yaml down -v$/);
  assert.equal(calls[0].composePresent, true);
  assert.equal(headOf(d), "main");
});

test("up with no --from is what it always was: the tree it is run in, and its own refusal", async (t) => {
  const d = branchProject(t);
  const { calls, exec } = recorder();
  const code = await runSandbox(d, "up", { target: "new" }, { exec, health: async () => true });
  assert.equal(code, 1);
  assert.deepEqual(calls, [], "nothing is started from a tree with no compose file in it");
  assert.equal(headOf(d), "main");
});

test("a branch that does not exist is refused by name, before anything is started", async (t) => {
  const d = branchProject(t);
  const { calls, exec } = recorder();
  const said = [];
  const err = console.error;
  console.error = (m) => said.push(m);
  t.after(() => { console.error = err; });
  const code = await runSandbox(d, "up", { target: "new", from: "proposal/build-slice-9" }, { exec, health: async () => true });
  assert.equal(code, 1);
  assert.match(said.join("\n"), /there is no branch proposal\/build-slice-9/);
  assert.deepEqual(calls, []);
  assert.equal(headOf(d), "main");
});

test("a dirty tree is refused, rather than carried onto the branch and back", async (t) => {
  const d = branchProject(t);
  writeFileSync(join(d, "notes.txt"), "half-finished\n");
  const { calls, exec } = recorder();
  const said = [];
  const err = console.error;
  console.error = (m) => said.push(m);
  t.after(() => { console.error = err; });
  const code = await runSandbox(d, "up", { target: "new", from: "proposal/build-slice-1" }, { exec, health: async () => true });
  assert.equal(code, 1);
  assert.match(said.join("\n"), /sandbox up: the working tree has uncommitted changes/);
  assert.match(said.join("\n"), /notes\.txt/);
  assert.deepEqual(calls, []);
  assert.equal(headOf(d), "main");
});

test("work that dirties the branch keeps HEAD there and says so, rather than carrying the residue to main", async (t) => {
  const d = branchProject(t);
  const exec = (cmd, args) => {
    if (args.includes("up")) writeFileSync(join(d, "app", "compose", "leftover.log"), "x\n");
    return { status: 0, stdout: "", stderr: "" };
  };
  const said = [];
  const err = console.error;
  console.error = (m) => said.push(m);
  t.after(() => { console.error = err; });
  const code = await runSandbox(d, "up", { target: "new", from: "proposal/build-slice-1" }, { exec, health: async () => true });
  assert.equal(code, 1);
  assert.equal(headOf(d), "proposal/build-slice-1");
  assert.match(said.join("\n"), /left dirty on proposal\/build-slice-1/);
  assert.match(said.join("\n"), /leftover\.log/);
});

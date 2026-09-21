import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetSettings, resetCommandFor, parseComposePs, serviceFailures, causeOf } from "../src/sandbox/local.mjs";
import { sandboxUp, sandboxReset, sandboxDown, runSandbox } from "../src/commands/sandbox.mjs";
import { parseConfig } from "../src/config/load.mjs";
import { COMMANDS } from "../src/cli.mjs";

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

// stderr, captured: the refusals and the "where HEAD was left" reports are the whole
// point of the paths below, and a message nobody can read is the defect being tested for.
function saidOnStderr(t) {
  const lines = [];
  const err = console.error;
  console.error = (m) => lines.push(String(m));
  t.after(() => { console.error = err; });
  return () => lines.join("\n");
}

test("an action that throws after dirtying the branch still fails, and says where HEAD was left", async (t) => {
  const d = branchProject(t);
  const said = saidOnStderr(t);
  const exec = () => { writeFileSync(join(d, "app", "compose", "leftover.log"), "x\n"); throw new Error("docker: no such daemon"); };
  const err = await runSandbox(d, "up", { target: "new", from: "proposal/build-slice-1" }, { exec, health: async () => true })
    .then(() => null, (e) => e);
  assert.ok(err, "the failure is not swallowed");
  assert.match(err.message, /no such daemon/);
  // Without this the caller reads a docker error, fixes docker, and the next `sdlc run`
  // refuses with `must start on main` having never been told where it is standing.
  assert.match(said(), /left dirty on proposal\/build-slice-1/);
  assert.match(said(), /leftover\.log/);
  assert.equal(headOf(d), "proposal/build-slice-1");
});

test("a teardown that cannot put HEAD back does not replace the failure already on its way out", async (t) => {
  const d = branchProject(t);
  const said = saidOnStderr(t);
  // A lock file is what a crashed git leaves behind, and it fails the checkout home
  // without touching `git status` — so the tree reads clean and the way back is shut.
  const exec = () => { writeFileSync(join(d, ".git", "index.lock"), ""); throw new Error("docker: no such daemon"); };
  const err = await runSandbox(d, "up", { target: "new", from: "proposal/build-slice-1" }, { exec, health: async () => true })
    .then(() => null, (e) => e);
  assert.match(err.message, /no such daemon/, "the docker failure survives a teardown that failed too");
  assert.doesNotMatch(err.message, /index\.lock/);
  assert.match(said(), /HEAD could not be put back on main/);
  assert.equal(headOf(d), "proposal/build-slice-1");
});

test("a teardown that cannot put HEAD back is itself the failure when nothing else went wrong", async (t) => {
  const d = branchProject(t);
  saidOnStderr(t);
  const exec = () => { writeFileSync(join(d, ".git", "index.lock"), ""); return { status: 0, stdout: "", stderr: "" }; };
  const err = await runSandbox(d, "up", { target: "new", from: "proposal/build-slice-1" }, { exec, health: async () => true })
    .then(() => null, (e) => e);
  assert.ok(err, "a command that cannot give the tree back does not report success");
  assert.match(err.message, /index\.lock/);
});

test("reset --from and status --from read the compose file the branch carries", async (t) => {
  const d = branchProject(t);
  const calls = [];
  const exec = (cmd, args) => {
    calls.push({ line: [cmd, ...args].join(" "), composePresent: existsSync(join(d, "app", "compose", "compose.yaml")) });
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.equal(await runSandbox(d, "reset", { target: "new", from: "proposal/build-slice-1" }, { exec }), 0);
  assert.equal(await runSandbox(d, "status", { target: "new", from: "proposal/build-slice-1" }, { exec }), 0);
  assert.match(calls[0].line, /run --rm seed$/);
  assert.match(calls[1].line, /ps$/);
  assert.ok(calls.every((c) => c.composePresent), "both actions ran with the branch's tree in place");
  assert.equal(headOf(d), "main");
});

test("a detached HEAD is given back detached, at the commit it was on", async (t) => {
  const d = branchProject(t);
  execFileSync("git", ["checkout", "-q", "--detach"], { cwd: d });
  const at = execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
  const { exec } = recorder();
  assert.equal(await runSandbox(d, "up", { target: "new", from: "proposal/build-slice-1" }, { exec, health: async () => true }), 0);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim(), at);
  assert.equal(headOf(d), "HEAD", "still detached, rather than put on a branch it was never on");
});

test("a --from carrying no branch name is refused, not quietly run against the tree you are on", async (t) => {
  const d = branchProject(t);
  const said = saidOnStderr(t);
  const { calls, exec } = recorder();
  assert.equal(await runSandbox(d, "down", { target: "new", from: true }, { exec }), 1);
  assert.match(said(), /--from needs a branch name/);
  assert.deepEqual(calls, [], "no stack is torn down on the strength of a flag with nothing in it");
});

test("an unknown subcommand names itself and prints what the command takes", async (t) => {
  const d = branchProject(t);
  const said = saidOnStderr(t);
  const { calls, exec } = recorder();
  assert.equal(await runSandbox(d, "upp", { target: "new" }, { exec }), 1);
  assert.match(said(), /unknown sandbox subcommand: upp/);
  assert.match(said(), /usage: sdlc sandbox up\|down\|reset\|status \[--target <t>\] \[--from <branch>\]/);
  assert.deepEqual(calls, []);
});

test("the CLI hands --from through as the parser produced it, so a bare one is caught", async (t) => {
  const d = branchProject(t);
  const said = saidOnStderr(t);
  const cwd = process.cwd();
  process.chdir(d);
  t.after(() => process.chdir(cwd));
  // A bare flag is refused before docker is reached, so this exercises the mapping
  // without a daemon: `--from proposal/build-slice-1` would go on to run one.
  assert.equal(await COMMANDS.sandbox({ pos: ["down"], flags: { target: "new", from: true } }), 1);
  assert.match(said(), /--from needs a branch name/);
  assert.equal(headOf(d), "main");
});

// `docker compose up --wait` gates only on services that declare a healthcheck, and the
// base-URL wait only ever asks one service anything. Everything below is about the gap
// between those two and "the project's services are running".

const psLines = (rows) => rows.map((r) => JSON.stringify(r)).join("\n");
const noSleep = async () => {};

test("compose's `ps --format json` is read in both spellings it is written in", () => {
  const rows = [{ Service: "web", State: "running" }, { Service: "seed", State: "exited", ExitCode: 0 }];
  assert.deepEqual(parseComposePs(psLines(rows)), rows, "one JSON object per line");
  assert.deepEqual(parseComposePs(JSON.stringify(rows)), rows, "a single JSON array");
});

// The two empty answers are different answers. "This project has no containers" is
// something known; "this is not a spelling I read" is nothing known at all, and a caller
// that could not tell them apart would report a sandbox up on an answer it never parsed.
test("an answer compose's `ps` could not have written is not read as an empty one", () => {
  assert.deepEqual(parseComposePs(""), [], "compose printed nothing: no containers");
  assert.deepEqual(parseComposePs("[]"), [], "an empty array: no containers");
  assert.equal(parseComposePs("NAME  COMMAND  STATE\nweb   node     Up"), null, "a table is not a record");
  assert.equal(parseComposePs("{\"Service\":\"web\"}\nnot json"), null, "one unreadable line makes the whole answer unreadable");
  assert.equal(parseComposePs("[{\"Service\":"), null, "a truncated array");
  assert.equal(parseComposePs("{\"services\": []}"), null, "a JSON object is not the list of rows this reads");
});

// The discriminator is the exit code, not the service's name: a compose file the pipeline
// does not own can call its one-shots anything, and compose itself settles the same
// question the same way (`service_completed_successfully` means exit 0).
test("a service that ran once and exited 0 is a one-shot finishing, not a service failing", () => {
  assert.deepEqual(serviceFailures([
    { Service: "web", State: "running" },
    { Service: "migrate", State: "exited", ExitCode: 0 },
    { Service: "seed", State: "exited", ExitCode: 0 },
  ]), []);
  const bad = serviceFailures([{ Service: "migrate", State: "exited", ExitCode: 3 }]);
  assert.equal(bad.length, 1);
  assert.match(bad[0].reason, /exited with code 3/);
});

test("a container that never started is nobody's application failing", () => {
  const created = serviceFailures([{ Service: "db", State: "created" }]);
  assert.equal(created.length, 1, "a sandbox with a container that never started is not up");
  assert.equal(causeOf(created), "environment", "nothing of the build has run, so there is nothing to tell a builder");
  assert.equal(causeOf(serviceFailures([{ Service: "idp", State: "restarting" }])), "application");
  assert.equal(causeOf([]), "environment");
});

test("a running service its own healthcheck calls unhealthy is a service that failed", () => {
  const bad = serviceFailures([{ Service: "api", State: "running", Health: "unhealthy" }]);
  assert.equal(bad.length, 1);
  assert.equal(causeOf(bad), "application");
  assert.deepEqual(serviceFailures([{ Service: "api", State: "running", Health: "healthy" }]), []);
});

test("up refuses a sandbox with a crash-looping service, names it, and does not seed", async (t) => {
  const d = project(t);
  const { calls, exec } = recorder({
    "ps --all": { status: 0, stdout: psLines([{ Service: "web", State: "running" }, { Service: "idp", State: "restarting" }]), stderr: "" },
    logs: { status: 0, stdout: "ERROR: Failed to run import\nERROR: Unrecognized field \"_comment\", not marked as ignorable\n", stderr: "" },
  });
  const r = await sandboxUp(d, CONFIG, "new", { exec, health: async () => true, sleep: noSleep });
  assert.equal(r.ok, false, "a dead identity provider is not a sandbox that is up");
  assert.equal(r.cause, "application");
  assert.deepEqual(r.failures.map((f) => f.service), ["idp"]);
  const said = r.messages.join("\n");
  assert.match(said, /idp is restarting/);
  assert.match(said, /Unrecognized field/, "the service's own log is what says why");
  assert.ok(!calls.some((c) => c.includes("run --rm seed")), "a sandbox that is not up is not seeded");
});

test("a one-shot that exited 0 alongside a running application is a sandbox that is up", async (t) => {
  const d = project(t);
  const { calls, exec } = recorder({
    "ps --all": { status: 0, stdout: JSON.stringify([
      { Service: "web", State: "running" }, { Service: "migrate", State: "exited", ExitCode: 0 }, { Service: "seed", State: "exited", ExitCode: 0 },
    ]), stderr: "" },
  });
  const r = await sandboxUp(d, CONFIG, "new", { exec, health: async () => true, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.match(calls.at(-1), /run --rm seed$/, "the seed still runs: nothing here read a finished migration as a failure");
});

// A crash loop spends part of every cycle running, so one glance at `ps` can find the
// container in the half of the cycle that looks healthy.
test("a crash loop caught mid-cycle is still caught: the services are watched, not glanced at", async (t) => {
  const d = project(t);
  let samples = 0;
  const slept = [];
  const exec = (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    if (line.includes("ps --all")) {
      samples += 1;
      return { status: 0, stdout: psLines([{ Service: "idp", State: samples < 3 ? "running" : "restarting" }]), stderr: "" };
    }
    if (line.includes("logs")) return { status: 0, stdout: "ERROR: Failed to run import\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const r = await sandboxUp(d, CONFIG, "new", { exec, health: async () => true, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(r.ok, false);
  assert.equal(samples, 3, "the first two samples found it in the half of its cycle that looks fine");
  assert.deepEqual(slept, [2000, 2000]);
});

test("an up that never created a container is the machine's, and an up whose container died is the application's", async (t) => {
  const d = project(t);
  const bind = recorder({
    "up -d": { status: 1, stdout: "", stderr: "Error response from daemon: failed to bind host port: address already in use" },
    "ps --all": { status: 0, stdout: "", stderr: "" },
  });
  const port = await sandboxUp(d, CONFIG, "new", { exec: bind.exec, health: async () => true, sleep: noSleep });
  assert.equal(port.ok, false);
  assert.equal(port.cause, "environment", "a port already taken is not the builder's defect");
  assert.match(port.messages[0], /address already in use/);

  const died = recorder({
    "up -d": { status: 1, stdout: "", stderr: "dependency failed to start: container mkt-idp-1 exited (1)" },
    "ps --all": { status: 0, stdout: psLines([{ Service: "idp", State: "exited", ExitCode: 1 }]), stderr: "" },
    logs: { status: 0, stdout: "ERROR: Unrecognized field \"_comment\"\n", stderr: "" },
  });
  const app = await sandboxUp(d, CONFIG, "new", { exec: died.exec, health: async () => true, sleep: noSleep });
  assert.equal(app.cause, "application", "a container that started and died ran something the build wrote");
  assert.match(app.messages.join("\n"), /Unrecognized field/);
});

test("an application that never answers, and a seed that fails, are both the application's", async (t) => {
  const d = project(t);
  const silent = recorder({ "ps --all": { status: 0, stdout: psLines([{ Service: "web", State: "running" }]), stderr: "" } });
  const r = await sandboxUp(d, CONFIG, "new", { exec: silent.exec, health: async () => false, sleep: noSleep });
  assert.equal(r.cause, "application", "the base URL is the address this build was told to publish on");

  const badSeed = recorder({
    "ps --all": { status: 0, stdout: psLines([{ Service: "web", State: "running" }]), stderr: "" },
    "run --rm seed": { status: 1, stdout: "", stderr: "relation \"users\" does not exist" },
  });
  const seeded = await sandboxUp(d, CONFIG, "new", { exec: badSeed.exec, health: async () => true, sleep: noSleep });
  assert.equal(seeded.ok, false);
  assert.equal(seeded.cause, "application");
  assert.match(seeded.messages.join("\n"), /relation "users" does not exist/);
});

// A container is free to print whatever it was handed. The password reaches compose by
// environment only, and a log quoted back into a message — and from there into a gate file
// and a commit — must not be the thing that writes it down.
test("a container's own log is quoted back without the sandbox password in it", async (t) => {
  const d = project(t);
  process.env.SDLC_SANDBOX_PASSWORD = "not-a-real-one";
  t.after(() => delete process.env.SDLC_SANDBOX_PASSWORD);
  const { exec } = recorder({
    "ps --all": { status: 0, stdout: psLines([{ Service: "idp", State: "restarting" }]), stderr: "" },
    logs: { status: 0, stdout: "starting admin user with password not-a-real-one\nERROR: Failed to run import\n", stderr: "" },
  });
  const r = await sandboxUp(d, CONFIG, "new", { exec, health: async () => true, sleep: noSleep });
  assert.ok(!JSON.stringify(r).includes("not-a-real-one"), "nothing the result carries repeats the password");
  assert.match(r.messages.join("\n"), /\[redacted\]/);
  assert.match(r.messages.join("\n"), /Failed to run import/, "and the rest of the log survives");
});

// `ps` is the only thing that knows whether the services are running. An unreadable answer
// is not a clean bill of health: read as one, `up` prints `sandbox up` over the crash loop
// this whole check exists to catch.
test("a `ps` that will not run leaves the sandbox not reported up, and it is the machine's", async (t) => {
  const d = project(t);
  const { calls, exec } = recorder({ "ps --all": { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" } });
  const r = await sandboxUp(d, CONFIG, "new", { exec, health: async () => true, sleep: noSleep });
  assert.equal(r.ok, false, "nothing established about the services is not the same as nothing wrong with them");
  assert.equal(r.cause, "environment");
  assert.match(r.messages.join("\n"), /could not be established/);
  assert.match(r.messages.join("\n"), /Cannot connect to the Docker daemon/);
  assert.ok(!calls.some((c) => c.includes("run --rm seed")));
});

test("a `ps` answering in a spelling this version does not read is treated the same way", async (t) => {
  const d = project(t);
  const { exec } = recorder({ "ps --all": { status: 0, stdout: "NAME      IMAGE   STATUS\nmkt-web   web     Up 3 seconds\n", stderr: "" } });
  const r = await sandboxUp(d, CONFIG, "new", { exec, health: async () => true, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.cause, "environment");
  assert.match(r.messages.join("\n"), /does not read/);
});

test("a `ps` that names no container at all is an answer, and the sandbox is up", async (t) => {
  const d = project(t);
  const { calls, exec } = recorder({ "ps --all": { status: 0, stdout: "[]", stderr: "" } });
  const r = await sandboxUp(d, CONFIG, "new", { exec, health: async () => true, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.match(calls.at(-1), /run --rm seed$/);
});

// `State` is the machine-readable field and `Status` is the sentence compose writes for a
// person. Both are read, so a version that spells one of them differently is still caught.
test("a restart is caught from compose's own sentence as well as from its state field", () => {
  const bad = serviceFailures([{ Service: "idp", State: "running", Status: "Restarting (1) 3 seconds ago" }]);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].state, "restarting");
  assert.equal(causeOf(bad), "application");
  assert.deepEqual(serviceFailures([{ Service: "idp", State: "running", Status: "Up 3 seconds" }]), []);
});

// An out-of-memory kill exits 137 and is reported here as the application's, which is the
// wrong side: the machine ran out of memory. `compose ps --format json` carries no
// `OOMKilled` field, so nothing here can know, and the exit code is all there is to read.
test("a container the kernel killed for memory is reported as the application's, which is the wrong side", () => {
  const bad = serviceFailures([{ Service: "api", State: "exited", ExitCode: 137 }]);
  assert.equal(causeOf(bad), "application");
  assert.match(bad[0].reason, /exited with code 137/);
});

test("the compose tail and the seed's own output are quoted without the password in them", async (t) => {
  const d = project(t);
  process.env.SDLC_SANDBOX_PASSWORD = "not-a-real-one";
  t.after(() => delete process.env.SDLC_SANDBOX_PASSWORD);
  const upFailed = recorder({
    "up -d": { status: 1, stdout: "", stderr: "invalid interpolation: SDLC_SANDBOX_PASSWORD=not-a-real-one\ncompose: exit 1" },
    "ps --all": { status: 0, stdout: "[]", stderr: "" },
  });
  const failedUp = await sandboxUp(d, CONFIG, "new", { exec: upFailed.exec, health: async () => true, sleep: noSleep });
  assert.ok(!JSON.stringify(failedUp).includes("not-a-real-one"));
  assert.match(failedUp.messages.join("\n"), /\[redacted\]/);

  const seedFailed = recorder({
    "ps --all": { status: 0, stdout: "[]", stderr: "" },
    "run --rm seed": { status: 1, stdout: "", stderr: "psql: connection refused for password not-a-real-one" },
  });
  const failedSeed = await sandboxUp(d, CONFIG, "new", { exec: seedFailed.exec, health: async () => true, sleep: noSleep });
  assert.equal(failedSeed.cause, "application");
  assert.ok(!JSON.stringify(failedSeed).includes("not-a-real-one"));
  assert.match(failedSeed.messages.join("\n"), /connection refused for password \[redacted\]/);
});

test("status passes compose its environment and prints what it says redacted", async (t) => {
  const d = branchProject(t);
  process.env.SDLC_SANDBOX_PASSWORD = "not-a-real-one";
  t.after(() => delete process.env.SDLC_SANDBOX_PASSWORD);
  const said = [];
  const log = console.log;
  console.log = (m) => said.push(String(m));
  t.after(() => { console.log = log; });
  const seen = [];
  const exec = (cmd, args, opts) => {
    seen.push({ line: [cmd, ...args].join(" "), env: opts?.env ?? {} });
    return { status: 0, stdout: "mkt-idp  Up 3 seconds  SDLC_SANDBOX_PASSWORD=not-a-real-one\n", stderr: "" };
  };
  assert.equal(await runSandbox(d, "status", { target: "new", from: "proposal/build-slice-1" }, { exec }), 0);
  assert.equal(seen[0].env.SDLC_SANDBOX_PASSWORD, "not-a-real-one", "compose gets the variable its file interpolates");
  assert.ok(!said.join("\n").includes("not-a-real-one"));
  assert.match(said.join("\n"), /\[redacted\]/);
});

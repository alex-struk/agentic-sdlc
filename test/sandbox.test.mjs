import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetSettings, resetCommandFor, parseComposePs, serviceFailures, stoppedForGood, publishedPorts, portOf, causeOf } from "../src/sandbox/local.mjs";
import { sandboxUp, sandboxReset, sandboxDown, runSandbox, pollAddress } from "../src/commands/sandbox.mjs";
import { parseConfig } from "../src/config/load.mjs";
import { COMMANDS } from "../src/cli.mjs";

const CONFIG = { project: { name: "mkt" }, targets: { new: { base_url: "http://localhost:8080", identity: "sandbox-idp" } } };

// The same project, declaring the address its identity provider answers on. A target that
// signs people in through a provider of its own is not a usable sandbox until that
// provider answers, whatever the web tier in front of it is serving
// (docs/decisions/0018-a-sandbox-is-ready-when-what-it-serves-through-answers.md).
const IDP_URL = "http://localhost:8081/realms/sandbox";
const DEP_CONFIG = { project: { name: "mkt" }, targets: { new: { ...CONFIG.targets.new, depends_on: { identity: IDP_URL } } } };

test("a target's sandbox settings default to the stack's compose file and seed service", () => {
  assert.deepEqual(targetSettings(CONFIG, "new"), {
    baseUrl: "http://localhost:8080", identity: "sandbox-idp", dependsOn: {},
    compose: "app/compose/compose.yaml", seedService: "seed", project: "sdlc-mkt-new",
  });
  const custom = { ...CONFIG, targets: { new: { ...CONFIG.targets.new, compose: "ops/dev.yaml", seed_service: "load" } } };
  assert.equal(targetSettings(custom, "new").compose, "ops/dev.yaml");
  assert.equal(targetSettings(custom, "new").seedService, "load");
  assert.deepEqual(targetSettings(DEP_CONFIG, "new").dependsOn, { identity: "http://localhost:8081/realms/sandbox" });
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

// Everything below is about the gap the service watch above cannot close on its own: a
// front door that answers while the provider everything signs in through never does.

test("the config schema accepts the addresses a target declares it depends on, and refuses a name or a value it cannot use", () => {
  const cfg = (deps) => `pipeline: { repo: a, ref: main }\nprofile: greenfield\nstack: openshift-ts\nproject: { name: p, domains: [a] }\n`
    + `targets:\n  new: { base_url: "http://localhost:8080", identity: sandbox-idp, depends_on: ${deps} }\n`
    + `policy:\n  gates:\n    G0: { holder: tech-lead }\n    G1: { holder: tech-lead }\n    G-DESIGN: { holder: tech-lead }\n    G2: { holder: tech-lead }\n    G3: { holder: tech-lead }\n    G-POL: { holder: tech-lead }\n  default_tier: STANDARD\nskills: { packs: [] }\negress: { rules: [E-2] }\n`;
  assert.deepEqual(parseConfig(cfg(`{ identity: "${IDP_URL}" }`)).errors, []);
  assert.match(parseConfig(cfg(`{ Identity: "${IDP_URL}" }`)).errors.join(" "), /depends_on/, "a dependency is named the way every other name in this file is");
  assert.match(parseConfig(cfg("{ identity: 7 }")).errors.join(" "), /must be string/);
});

// Most of what `ps` can report about a container while the project is coming up is a state
// a healthy project passes through, and `restarting` is the one that matters: a container
// that exits retrying its database is restarted, loops for ten seconds and then runs, and
// `--wait` returns while that is going on.
test("only a container compose has finished with is certain while the project is still coming up", () => {
  const rows = [
    { Service: "web", State: "running" },
    { Service: "db", State: "created" },
    { Service: "api", State: "running", Health: "unhealthy" },
    { Service: "idp", State: "restarting" },
    { Service: "worker", State: "dead" },
    { Service: "migrate", State: "exited", ExitCode: 3 },
    { Service: "seed", State: "exited", ExitCode: 0 },
  ];
  assert.deepEqual(stoppedForGood(serviceFailures(rows)).map((f) => f.service), ["worker", "migrate"]);
  assert.deepEqual(stoppedForGood([]), []);
});

test("the ports a project publishes are read from compose's own rows, and an unanswerable question answers null", () => {
  const rows = [
    { Service: "web", State: "running", Publishers: [{ PublishedPort: 8080, TargetPort: 3000 }, { PublishedPort: 0, TargetPort: 9229 }] },
    { Service: "db", State: "running", Publishers: [] },
  ];
  assert.deepEqual([...publishedPorts(rows)], [8080], "a port published on 0 is not published");
  assert.equal(publishedPorts([{ Service: "web", State: "running" }]), null, "a compose version that names no publishers has said nothing");
  assert.equal(publishedPorts([]), null);
  assert.equal(portOf("http://localhost:8081/realms/sandbox"), 8081);
  assert.equal(portOf("http://localhost/realms/sandbox"), 80);
  assert.equal(portOf("https://idp.test/realms/sandbox"), 443);
  assert.equal(portOf("localhost:8081"), 0, "a string that is not an address is not a port");
});

test("the wait for an address ends at the service that will never let it answer, rather than running out", async () => {
  const asked = [];
  const refused = async (u) => { asked.push(u); throw new Error("connection refused"); };
  let ticks = 0;
  const tick = async () => (++ticks < 3 ? null : { failures: [{ service: "idp", state: "restarting", ran: true, reason: "is restarting" }] });
  const stopped = await pollAddress(IDP_URL, tick, { fetchUrl: refused, sleep: noSleep });
  assert.deepEqual(stopped.failures.map((f) => f.service), ["idp"], "the answer is the container, not the silence");
  assert.equal(asked.length, 3, "and it came at the sample that found it, not at the sixtieth attempt");

  const quiet = async () => null;
  assert.equal(await pollAddress(IDP_URL, quiet, { fetchUrl: async () => ({ status: 200 }), sleep: noSleep }), true);
  assert.equal(await pollAddress(IDP_URL, quiet, { fetchUrl: async () => ({ status: 404 }), sleep: noSleep }), true, "anything short of a server error is an answer");
  assert.equal(await pollAddress(IDP_URL, quiet, { fetchUrl: refused, sleep: noSleep, tries: 2 }), false);
});

test("up waits for every address a target declares, and for its base URL alone when it declares none", async (t) => {
  const d = project(t);
  const asked = [];
  const { exec } = recorder({ "ps --all": { status: 0, stdout: psLines([{ Service: "web", State: "running" }]), stderr: "" } });
  const health = async (url) => { asked.push(url); return true; };
  assert.equal((await sandboxUp(d, DEP_CONFIG, "new", { exec, health, sleep: noSleep })).ok, true);
  assert.deepEqual(asked, ["http://localhost:8080", IDP_URL]);
  asked.length = 0;
  assert.equal((await sandboxUp(d, CONFIG, "new", { exec, health, sleep: noSleep })).ok, true);
  assert.deepEqual(asked, ["http://localhost:8080"], "a target that declares nothing waits for what it always waited for");
});

// The shape the service watch cannot reach: the provider's container reads `Up` for the
// whole of the watch and the realm it was to import is not there, so nothing ever answers
// at its address and every test that signs in would fail on a sandbox reported up.
test("a declared dependency that never answers is a sandbox that is not up, whatever the web tier is serving", async (t) => {
  const d = project(t);
  const { calls, exec } = recorder({
    "ps --all": { status: 0, stdout: psLines([{ Service: "web", State: "running" }, { Service: "idp", State: "running" }]), stderr: "" },
  });
  const r = await sandboxUp(d, DEP_CONFIG, "new", { exec, health: async (url) => url === "http://localhost:8080", sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.cause, "application");
  assert.match(r.messages[0], /its identity dependency did not answer at http:\/\/localhost:8081\/realms\/sandbox/);
  assert.ok(!calls.some((c) => c.includes("run --rm seed")), "a sandbox that is not up is not seeded");
});

// The measured run: the provider is `Up` while the base URL comes good, and reads
// `Restarting (1)` by the time anyone looks again. A restart loop never ends a wait, since
// nothing in a `ps` row tells one that recovers from one that does not, so the wait for the
// realm's address runs to its end — and the refusal still names the provider and quotes the
// import error, because the containers are read again when it does.
test("a provider that crash-loops behind its own address is refused with the container named, at the end of the wait", async (t) => {
  const d = project(t);
  const { calls, exec } = recorder({
    "ps --all": { status: 0, stdout: psLines([{ Service: "web", State: "running" }, { Service: "idp", State: "restarting" }]), stderr: "" },
    logs: { status: 0, stdout: "ERROR: Failed to run import\nERROR: Unrecognized field \"_comment\"\n", stderr: "" },
  });
  let attempts = 0;
  const health = async (url, tick) => {
    if (url === "http://localhost:8080") return true;
    for (let i = 0; i < 6; i += 1) { attempts += 1; if (await tick()) return { failures: [] }; }
    return false;
  };
  const r = await sandboxUp(d, DEP_CONFIG, "new", { exec, health, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.cause, "application");
  assert.equal(attempts, 6, "a restart loop is left to the address: it may yet recover");
  assert.match(r.messages[0], /its identity dependency did not answer at http:\/\/localhost:8081\/realms\/sandbox/);
  assert.deepEqual(r.failures.map((f) => f.service), ["idp"]);
  assert.match(r.messages.join("\n"), /Unrecognized field/, "the service's own log is still what says why");
  assert.ok(!calls.some((c) => c.includes("run --rm seed")));
});

// The other half of the same rule, and the reason it is drawn where it is. An application
// container that exits retrying a database it depends on is restarted, loops for about ten
// seconds and then serves; `--wait` returns while that is going on. Refusing it would send
// a build proposal back for a sandbox that was seconds from healthy.
test("a container that crash-loops on its way up and then serves is a sandbox that is up", async (t) => {
  const d = project(t);
  let samples = 0;
  const exec = (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    if (line.includes("ps --all")) {
      samples += 1;
      return { status: 0, stdout: psLines([{ Service: "web", State: "running" }, { Service: "api", State: samples < 4 ? "restarting" : "running" }]), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const health = async (url, tick) => {
    if (url === "http://localhost:8080") return true;
    for (let i = 0; i < 6; i += 1) { if (await tick()) return { failures: [] }; }
    return true;
  };
  const r = await sandboxUp(d, DEP_CONFIG, "new", { exec, health, sleep: noSleep });
  assert.equal(r.ok, true, "a loop that recovers is not a sandbox that failed");
});

// A container compose has finished with is the one case nothing is waiting on any more.
test("a container that exited non-zero while a dependency is still being waited for ends that wait", async (t) => {
  const d = project(t);
  let samples = 0;
  const exec = (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    if (line.includes("ps --all")) {
      samples += 1;
      return { status: 0, stdout: psLines([{ Service: "web", State: "running" }, { Service: "idp", State: samples < 3 ? "running" : "exited", ExitCode: samples < 3 ? 0 : 1 }]), stderr: "" };
    }
    if (line.includes("logs")) return { status: 0, stdout: "ERROR: Failed to run import\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  let attempts = 0;
  const health = async (url, tick) => {
    if (url === "http://localhost:8080") return true;
    for (let i = 0; i < 20; i += 1) { attempts += 1; const stopped = tick ? await tick() : null; if (stopped) return stopped; }
    return false;
  };
  const r = await sandboxUp(d, DEP_CONFIG, "new", { exec, health, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.cause, "application", "a container that started and died ran something the build wrote");
  assert.match(r.messages[0], /while waiting for its identity dependency at http:\/\/localhost:8081\/realms\/sandbox/);
  assert.deepEqual(r.failures.map((f) => f.service), ["idp"]);
  assert.match(r.messages.join("\n"), /Failed to run import/);
  assert.equal(attempts, 3, "the wait ended at the sample that found it rather than at its own end");
});

// The address is a string in `.sdlc/config.yaml`. No build writes that file or is shown it,
// so a build proposal returned for it would spend one of a slice's three attempts against
// somebody who can neither see the cause nor fix it.
test("an address on a port this project does not publish is the configuration's, and nothing is recorded against the build", async (t) => {
  const d = project(t);
  const rows = [{ Service: "web", State: "running", Publishers: [{ PublishedPort: 8080 }] }, { Service: "idp", State: "running", Publishers: [{ PublishedPort: 8081 }] }];
  const { calls, exec } = recorder({ "ps --all": { status: 0, stdout: psLines(rows), stderr: "" } });
  const typo = { project: { name: "mkt" }, targets: { new: { ...CONFIG.targets.new, depends_on: { identity: "http://localhost:8181/realms/sandbox" } } } };
  const r = await sandboxUp(d, typo, "new", { exec, health: async (url) => url === "http://localhost:8080", sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.cause, "environment", "a line only the operator can fix does not go back to a builder");
  assert.match(r.messages.join("\n"), /no container of this project publishes port 8181 — the ports it publishes are 8080, 8081/);
  assert.match(r.messages.join("\n"), /targets\.new\.depends_on\.identity names an address this project does not serve/);
  assert.deepEqual(r.failures, [], "there is no service to write a condition about");
  assert.ok(!calls.some((c) => c.includes("run --rm seed")));
});

test("an address on a port this project does publish is the application's, and so is one where nothing could be told apart", async (t) => {
  const d = project(t);
  const served = recorder({
    "ps --all": { status: 0, stdout: psLines([{ Service: "idp", State: "running", Publishers: [{ PublishedPort: 8081 }] }]), stderr: "" },
  });
  const r = await sandboxUp(d, DEP_CONFIG, "new", { exec: served.exec, health: async (url) => url === "http://localhost:8080", sleep: noSleep });
  assert.equal(r.cause, "application", "the port is published and simply silent: the service is not serving");
  assert.match(r.messages[0], /its identity dependency did not answer/);

  const quiet = recorder({ "ps --all": { status: 0, stdout: psLines([{ Service: "idp", State: "running" }]), stderr: "" } });
  const older = await sandboxUp(d, DEP_CONFIG, "new", { exec: quiet.exec, health: async (url) => url === "http://localhost:8080", sleep: noSleep });
  assert.equal(older.cause, "application", "a compose version that names no publishers has said nothing to decide on");
});

// A wait that ended on a container compose had not started yet would refuse sandboxes that
// were about to be fine, which is the opposite error and costs a run just the same.
test("a container still starting or looping does not end a wait, and neither does a `ps` that could not be read", async (t) => {
  const d = project(t);
  const starting = psLines([{ Service: "web", State: "running" }, { Service: "db", State: "created" }, { Service: "api", State: "running", Health: "unhealthy" }, { Service: "idp", State: "restarting" }]);
  for (const ps of [{ status: 0, stdout: starting, stderr: "" }, { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }]) {
    const { exec } = recorder({ "ps --all": ps });
    let ticks = 0;
    let cutShort = false;
    const health = async (url, tick) => {
      if (url === "http://localhost:8080") return true;
      for (let i = 0; i < 4; i += 1) { ticks += 1; const stopped = await tick(); if (stopped) { cutShort = true; return stopped; } }
      return false;
    };
    const r = await sandboxUp(d, DEP_CONFIG, "new", { exec, health, sleep: noSleep });
    assert.equal(ticks, 4);
    assert.equal(cutShort, false, "the wait ran to its own end");
    assert.match(r.messages[0], /its identity dependency did not answer/);
  }
});

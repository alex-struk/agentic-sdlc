// `sdlc sandbox up|down|reset|status [--target new] [--from <branch>]` — a rebuilt
// target's local lifecycle, the counterpart of `sdlc oracle` for the application the
// pipeline builds. `up` is the deploy for this phase
// (docs/decisions/0011-build-verify-review.md): the project's own compose file, built
// from the working tree, waited on, checked service by service, then seeded.
//
// A refusal from `up` carries a `cause` — `application` or `environment` — because the two
// need opposite answers from a caller: a container that starts and dies ran something the
// build wrote, and a container that could never be created did not
// (docs/decisions/0017-a-sandbox-that-is-not-up.md).
//
// `--from <branch>` is how an application that exists only on an unmerged proposal branch
// is started from `main` (docs/decisions/0016-binding-and-verifying-an-unmerged-proposal.md): the
// action runs with the working tree on that branch and HEAD is put back afterwards.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadConfig } from "../config/load.mjs";
import { targetSettings, composeArgs, parseComposePs, serviceFailures, causeOf, APPLICATION, ENVIRONMENT } from "../sandbox/local.mjs";
import { enterBranch, leaveBranch } from "../lib/git.mjs";
import { COMMANDS } from "../cli.mjs";

function defaultExec(cmd, args, { cwd, env = {} } = {}) {
  const res = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr || (res.error ? res.error.message : "") };
}

async function defaultHealth(url) {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* not up yet */ }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  return false;
}

// The identity provider's test users sign in with this password, and compose reads it from
// the environment. It is passed only that way, so it never appears in an argument list, a
// log line or a file.
function composeEnv() {
  return process.env.SDLC_SANDBOX_PASSWORD ? { SDLC_SANDBOX_PASSWORD: process.env.SDLC_SANDBOX_PASSWORD } : {};
}

// The sandbox password reaches compose through the environment, and a container is free to
// print whatever it was given. Everything quoted back out of a container — a compose tail,
// a service's own log — goes through here first, so a value that is never written to a file
// on the way in is not written to one on the way out either, whether that file is a
// terminal, a gate file or a commit.
function redact(text) {
  const secret = process.env.SDLC_SANDBOX_PASSWORD;
  const t = `${text ?? ""}`;
  return secret ? t.split(secret).join("[redacted]") : t;
}

const tail = (r) => redact(`${r.stderr || r.stdout}`).trim().split("\n").slice(-15).join("\n");

const LOG_LINES = 20;

// How long the services are watched once everything else says the sandbox is up, and how
// often. A crash loop is reported `restarting` for the whole of its backoff and `running`
// for the seconds between, so a single sample can catch it in the half that looks healthy —
// and the longer the backoff grows, the wider the window to catch it in. Three samples a
// couple of seconds apart close that gap. What they do not close is a container that
// outlives the watch and dies after it, which no number of samples would: the suite that
// runs next is what finds that one.
const SETTLE_SAMPLES = 3;
const SETTLE_MS = 2000;

const sleepMs = (ms) => new Promise((ok) => setTimeout(ok, ms));

// What compose says has become of every container of this project, including the ones that
// have stopped — or why it could not be asked.
//
// `{ ok: true, rows: [] }` and `{ ok: false }` are different answers and the difference is
// the whole point of this function. No rows is compose saying this project has no
// containers. Not ok is compose failing, or answering in a spelling this version does not
// read, which is nothing known either way — and a caller that read that as "no service
// failed" would print `sandbox up` over the crash loop this whole check exists to catch.
function psRows(projectDir, s, exec) {
  let r;
  try { r = exec("docker", [...composeArgs(projectDir, s), "ps", "--all", "--format", "json"], { cwd: projectDir, env: composeEnv() }); }
  catch (err) { return { ok: false, why: `docker compose ps could not be run: ${redact(err?.message ?? String(err))}` }; }
  if (!r || r.status !== 0) return { ok: false, why: `docker compose ps failed:\n${tail(r ?? {})}` };
  const rows = parseComposePs(r.stdout);
  if (rows === null) {
    return { ok: false, why: `docker compose ps answered in a form this version does not read:\n${redact(r.stdout).trim().split("\n").slice(0, 3).join("\n")}` };
  }
  return { ok: true, rows };
}

// The same question asked where the answer is only used to attribute a failure that has
// already happened. An unreadable `ps` there means no container can be shown to have run,
// which `causeOf` reads as the machine's — the same direction the guess goes everywhere
// else.
const psFailures = (projectDir, s, exec) => serviceFailures(psRows(projectDir, s, exec).rows ?? []);

// One service's own account of why it stopped. This is the line that makes a failure
// actionable — a realm file compose will not parse, a migration that hit a constraint —
// and it is the only place the reason exists, since the service is not the one the base
// URL points at and nothing else has read it.
function logTail(projectDir, s, exec, service) {
  let r;
  try { r = exec("docker", [...composeArgs(projectDir, s), "logs", "--no-color", "--tail", String(LOG_LINES), service], { cwd: projectDir, env: composeEnv() }); }
  catch { return ""; }
  if (!r) return "";
  return redact(`${r.stdout ?? ""}\n${r.stderr ?? ""}`).trim().split("\n").slice(-LOG_LINES).join("\n");
}

async function watchServices(projectDir, s, exec, { sleep = sleepMs, samples = SETTLE_SAMPLES } = {}) {
  const seen = new Map();
  for (let i = 0; i < samples; i += 1) {
    if (i) await sleep(SETTLE_MS);
    const ps = psRows(projectDir, s, exec);
    // Nothing can be established about the services, so nothing is claimed about them.
    if (!ps.ok) return { unreadable: ps.why, failures: [] };
    // Compose named no container for this project. There is nothing to watch and nothing
    // to conclude, so the watch stops rather than spending the rest of its samples.
    if (!ps.rows.length) break;
    for (const f of serviceFailures(ps.rows)) if (!seen.has(f.service)) seen.set(f.service, f);
    if (seen.size) break;
  }
  return { unreadable: "", failures: [...seen.values()] };
}

function withLogs(projectDir, s, exec, failures) {
  return failures.map((f) => ({ ...f, log: logTail(projectDir, s, exec, f.service) }));
}

const describe = (f) => (f.log ? `${f.service} ${f.reason}. The end of its own log:\n${f.log}` : `${f.service} ${f.reason}.`);

// Every refusal `up` makes carries a `cause`, so a caller can act on whose fault it is
// without reading the message. `failures` carries the same answer in parts, for a caller
// that has to write one condition per service rather than print a paragraph.
const failed = (cause, messages, failures = []) => ({ ok: false, cause, failures, messages });

export async function sandboxUp(projectDir, config, target, { exec = defaultExec, health = defaultHealth, sleep = sleepMs, samples = SETTLE_SAMPLES } = {}) {
  const s = targetSettings(config, target);
  // The compose file is written by the build that declares the application's local
  // services, and it lives under `app/` with the rest of that build's output, so a missing
  // one is something a builder can be told to write.
  if (!existsSync(join(projectDir, s.compose)))
    return failed(APPLICATION, [`${s.compose} is missing; the stack profile has the application declare its local services there`]);
  const up = exec("docker", [...composeArgs(projectDir, s), "up", "-d", "--build", "--wait"], { cwd: projectDir, env: composeEnv() });
  if (up.status !== 0) {
    const bad = withLogs(projectDir, s, exec, psFailures(projectDir, s, exec));
    return failed(causeOf(bad), [`docker compose up failed:\n${tail(up)}`, ...bad.map(describe)], bad);
  }
  if (!(await health(s.baseUrl))) {
    // The address in `targets.<t>.base_url` is the one the build was told to publish on
    // and the one the acceptance suite drives. Nothing answering there is the application
    // not serving, whatever state the containers around it are in.
    const bad = withLogs(projectDir, s, exec, psFailures(projectDir, s, exec));
    return failed(APPLICATION, [`the application did not answer at ${s.baseUrl}`, ...bad.map(describe)], bad);
  }
  // `--build --wait` gates only on services that declare a healthcheck, and the base-URL
  // wait only ever asked one service anything. Neither notices a second service that came
  // up, fell over and has been restarting ever since — which is a sandbox that is not up,
  // whatever the web tier says.
  const watched = await watchServices(projectDir, s, exec, { sleep, samples });
  // Whether the services are running could not be established, so the sandbox is not
  // reported up. This is the machine's: a `ps` that will not run or will not parse says
  // nothing about the application, and a re-run costs nothing next to reporting a sandbox
  // up on an answer nothing could read.
  if (watched.unreadable)
    return failed(ENVIRONMENT, [`the sandbox is not reported up: whether this project's services are running could not be established.\n${watched.unreadable}`]);
  const bad = withLogs(projectDir, s, exec, watched.failures);
  if (bad.length) {
    const what = bad.length === 1 ? "a service of this project is not running" : `${bad.length} services of this project are not running`;
    return failed(causeOf(bad), [`the sandbox is not up: ${what}`, ...bad.map(describe)], bad);
  }
  const seeded = sandboxReset(projectDir, config, target, { exec });
  return seeded.ok ? { ok: true, baseUrl: s.baseUrl, messages: [] } : seeded;
}

export function sandboxReset(projectDir, config, target, { exec = defaultExec } = {}) {
  const s = targetSettings(config, target);
  const r = exec("docker", [...composeArgs(projectDir, s), "run", "--rm", s.seedService], { cwd: projectDir, env: composeEnv() });
  if (r.status === 0) return { ok: true, messages: [] };
  // A seed container is created and run against a stack that is already up, so what failed
  // is the process inside it: the seed, the migrations it depends on, or the schema they
  // expect. `--rm` has taken the container away, so its output is quoted from the call.
  return failed(APPLICATION, [`the ${s.seedService} service failed:\n${tail(r)}`],
    [{ service: s.seedService, state: "exited", ran: true, reason: "failed to load the seed", log: tail(r) }]);
}

export function sandboxDown(projectDir, config, target, { exec = defaultExec } = {}) {
  const s = targetSettings(config, target);
  const r = exec("docker", [...composeArgs(projectDir, s), "down", "-v"], { cwd: projectDir, env: composeEnv() });
  return { ok: r.status === 0 };
}

const USAGE = "usage: sdlc sandbox up|down|reset|status [--target <t>] [--from <branch>]";

// One action against one target, with the working tree already wherever it needs to be.
// Prints what it did and answers with the exit code alone, so the branch handling in
// `runSandbox` below has one thing to wrap rather than four.
async function sandboxAction(projectDir, config, sub, target, deps = {}) {
  const { exec = defaultExec } = deps;
  if (sub === "up") {
    const r = await sandboxUp(projectDir, config, target, deps);
    console.log(r.ok ? `sandbox ${target} up at ${r.baseUrl}` : r.messages.join("\n"));
    return r.ok ? 0 : 1;
  }
  if (sub === "reset") { const r = sandboxReset(projectDir, config, target, { exec }); console.log(r.ok ? `sandbox ${target} reseeded` : r.messages.join("\n")); return r.ok ? 0 : 1; }
  if (sub === "down") { sandboxDown(projectDir, config, target, { exec }); console.log(`sandbox ${target} down`); return 0; }
  const s = targetSettings(config, target);
  // `composeEnv()` for the same reason every other call takes it — compose warns about a
  // variable its file interpolates and the environment does not carry — and `redact` for
  // the reason every other quoting path takes it: what a container was handed is not
  // written down on the way out either.
  const r = exec("docker", [...composeArgs(projectDir, s), "ps"], { cwd: projectDir, env: composeEnv() });
  console.log(redact(r.stdout).trim() || `sandbox ${target}: nothing running`);
  return 0;
}

// The shared entry point behind `COMMANDS.sandbox` below, exported so tests can drive it
// with an explicit `projectDir` and their own `exec`/`health` rather than a real Docker
// daemon and a `process.chdir()`.
//
// `--from <branch>` builds and starts the application a branch carries without leaving
// HEAD there. Nothing about the running stack depends on the tree afterwards: compose
// reads the build context while `up` runs, the containers run from the images it
// produced, and the seed service has already loaded by the time `up` returns. What the
// compose file still has to be reachable for is every later action against the same
// stack, which is why `down`, `reset` and `status` take the same flag.
export async function runSandbox(projectDir, sub, { target = "new", from } = {}, deps = {}) {
  if (!["up", "down", "reset", "status"].includes(sub)) { console.error(`unknown sandbox subcommand: ${sub ?? "(none)"}\n${USAGE}`); return 1; }
  // `--from` with nothing after it parses as `true`, and a flag that reads as set but
  // carries no branch must not quietly become "the tree you are standing in": a
  // `sandbox down --from` typed that way would report a stack torn down while the
  // containers the branch declares go on running.
  if (from !== undefined && (typeof from !== "string" || !from)) {
    console.error(`sandbox ${sub}: --from needs a branch name — sdlc sandbox ${sub} --from proposal/<name>`);
    return 1;
  }
  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) { console.error(`config invalid:\n  ${errors.join("\n  ")}`); return 1; }
  if (!from) return sandboxAction(projectDir, config, sub, target, deps);

  let start;
  // A branch that does not exist and a dirty tree are both refused before anything is
  // started, and both are the caller's to fix, so they read as the command's own message
  // rather than as a stack trace.
  try { start = enterBranch(projectDir, from, `sandbox ${sub}`); }
  catch (err) { console.error(err.message); return 1; }
  let code;
  let failure;
  try { code = await sandboxAction(projectDir, config, sub, target, deps); }
  catch (err) { failure = err; }
  // Where HEAD was left is reported before anything is rethrown, and reported on the
  // failing path too. An action that threw after dirtying the tree is exactly when the
  // caller most needs to be told: they read the docker failure, fix it, and the next
  // `sdlc run` refuses with `must start on main` for a reason nothing has mentioned.
  // `failure ??=` is why the report survives a teardown that fails as well — a checkout
  // blocked by a file the action left behind must not replace the failure already on its
  // way out (`src/stages/verify.mjs` does the same for the same reason).
  let dirty = "";
  try { dirty = leaveBranch(projectDir, start); }
  catch (err) {
    failure ??= err;
    console.error(`sandbox ${sub}: HEAD could not be put back on ${start} and is still on ${from}; check it out by hand once the cause below is dealt with.`);
  }
  if (dirty) console.error(`sandbox ${sub}: the working tree was left dirty on ${from}, so HEAD is still there. Inspect and clean it, then check out ${start}:\n${dirty}`);
  if (failure) throw failure;
  // The action may well have worked — the stack can be up and serving — but HEAD is not
  // where the caller left it, and the next `sdlc run` refuses anywhere but `main`. That
  // is the thing to deal with first, so it decides the exit code.
  return dirty ? 1 : code;
}

// `flags.from` is passed through exactly as the parser produced it — a string, or `true`
// for a bare `--from` — so the refusal above is the one place that decides what a flag
// carrying no branch means, and a test can reach it without a shell.
COMMANDS.sandbox = async ({ pos, flags }) => runSandbox(process.cwd(), pos[0], {
  target: typeof flags.target === "string" ? flags.target : "new",
  from: flags.from,
});

// Every `docker compose` call the oracle lifecycle makes goes through `compose()` below —
// the one place `SDLC_ORACLE=mock` short-circuits, so `src/commands/oracle.mjs` never
// has to know whether Docker is actually available. Modelled on the mock-executor
// pattern in `src/runner/executor.mjs` (`SDLC_EXECUTOR=mock`): a real subprocess in
// normal use, a recorded call and a canned answer under test.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function mockDir() {
  return process.env.SDLC_MOCK_DIR ?? "";
}

// Appends one call to `SDLC_MOCK_DIR/oracle-calls.json`, creating the file the first
// time it is needed, so a test can assert on the exact sequence of compose calls a run
// made without a real Docker daemon anywhere in reach. `input` (the path of a file piped
// to stdin, when there is one) is recorded as its own field rather than folded into
// `args`, since it was never part of the compose command line.
function recordMockCall(args, env, input) {
  const p = join(mockDir(), "oracle-calls.json");
  const calls = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
  // Only `SDLC_*` keys are recorded: everything else in a caller's `env` is either
  // inherited from the ambient process (irrelevant to what this call asked for) or an
  // `oracle.env` entry a project defined for its own application, neither of which a
  // test asserting on compose *calls* needs to see.
  const sdlcEnv = Object.fromEntries(Object.entries(env ?? {}).filter(([k]) => k.startsWith("SDLC_")));
  const call = { args, env: sdlcEnv };
  if (input) call.input = input;
  calls.push(call);
  writeFileSync(p, JSON.stringify(calls, null, 2));
}

// Whether `docker compose` is actually available on this machine, and its version line
// when it is. Shared by `sdlc doctor` (a report line, never blocking) and `sdlc oracle
// up` (a hard refusal, since nothing downstream can work without it) so the two agree
// on what "available" means rather than each running its own probe.
export function composeVersion() {
  try {
    const v = execFileSync("docker", ["compose", "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")[0];
    return { found: true, version: v.trim() };
  } catch { return { found: false }; }
}

// A real `up --build` or `run` streams a container build's whole output — tens of
// megabytes on a first build — and `execFileSync`'s default 1 MiB buffer would abort the
// call with ENOBUFS long before the build finished. 256 MiB is past anything a compose
// build has been observed to produce while still bounded.
const MAX_BUFFER = 256 * 1024 * 1024;

// The subcommands whose output is a progress report a person watches rather than a value
// a caller parses. Both are long-running, so their stdout and stderr are inherited: the
// build scrolls in the terminal as it happens instead of arriving all at once at the end,
// or not at all if the call fails. Nothing reads their return value.
const STREAMING = new Set(["up", "run"]);

// The compose subcommand in `args`, past the `-p <project> -f <file> -f <file>` prefix
// every call carries. Flags that take a value are skipped with their value, so the first
// bare word left is the subcommand — `up`, `run`, `ps`, `exec`, `down`.
function composeSubcommand(args) {
  const takesValue = new Set(["-p", "--project-name", "-f", "--file", "--profile", "--env-file", "--project-directory"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (takesValue.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return a;
  }
  return "";
}

// The child-process options one `docker compose` call runs with. Exported so a test can
// assert on the buffer and the stream wiring without a Docker daemon anywhere in reach.
export function composeOptions(args, { cwd, env = {}, input } = {}) {
  const streaming = STREAMING.has(composeSubcommand(args));
  return {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: [input ? "pipe" : "ignore", streaming ? "inherit" : "pipe", streaming ? "inherit" : "pipe"],
  };
}

// Runs `docker compose <args>` synchronously, in `cwd`, with `env` merged over the
// ambient environment. `input` is a path to a file whose contents are piped to the
// process's stdin (`loadSeed` below uses this to feed a `.sql` file to `psql` without
// shelling out through a redirect the way a person would at a terminal).
//
// Under `SDLC_ORACLE=mock` nothing is spawned: the call is appended to
// `oracle-calls.json` as `{ args, env, input }` (`input` present only for calls that
// pipe a file) and the answer is `""`, except `ps --format json`, which answers with
// whatever `SDLC_MOCK_DIR/oracle-ps.json` holds — a test's way of saying a container is
// already running — and `config --services`, which answers with
// `SDLC_MOCK_DIR/oracle-services.txt`; either is `""` when its file is not present.
export function compose(args, { cwd, env = {}, input } = {}) {
  if (process.env.SDLC_ORACLE === "mock") {
    recordMockCall(args, env, input);
    // `args[0]` is never "ps" here — every real call carries the `-p <project> -f ...`
    // prefix first — so this looks for the subcommand anywhere in the array rather than
    // assuming a position.
    if (args.includes("ps") && args.includes("--format") && args.includes("json")) {
      const p = join(mockDir(), "oracle-ps.json");
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    }
    // `config --services` lists what the compose files define, which is how `oracle up`
    // works out which services to start before the application. Under mock that list
    // comes from `SDLC_MOCK_DIR/oracle-services.txt`, one service name per line.
    if (args.includes("config") && args.includes("--services")) {
      const p = join(mockDir(), "oracle-services.txt");
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    }
    return "";
  }
  try {
    const opts = composeOptions(args, { cwd, env, input });
    if (input) opts.input = readFileSync(input, "utf8");
    return execFileSync("docker", ["compose", ...args], opts);
  } catch (e) {
    // A streaming call's stderr went straight to the terminal, so there is nothing on
    // the error to quote and the message stands on its own; a captured call's stderr is
    // the whole account of the failure and is quoted.
    const stderr = (e.stderr ?? "").toString().trim();
    throw new Error(`docker compose ${args.join(" ")} failed:\n${stderr || e.message}`);
  }
}

// Polls `url` with a plain `fetch` every 2s until it gets any HTTP response at all — the
// oracle is "up" the moment it answers, whatever the status code — up to `ms`
// milliseconds. Under mock there is no server to poll, so it resolves immediately.
export async function waitForHttp(url, ms) {
  if (process.env.SDLC_ORACLE === "mock") return;
  const deadline = Date.now() + ms;
  for (;;) {
    try { await fetch(url); return; }
    catch (e) {
      if (Date.now() >= deadline) throw new Error(`timed out after ${ms}ms waiting for ${url} to answer: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Polls `compose exec -T <db.service> pg_isready -U <db.user>` every 2s for up to 60s.
// `baseArgs` is the `-p <project> -f <compose> -f <override>` prefix every compose call
// in a single `oracle up` shares (built once by the caller, not re-derived here).
export async function waitForDb(baseArgs, db, opts) {
  const args = [...baseArgs, "exec", "-T", db.service, "pg_isready", "-U", db.user];
  if (process.env.SDLC_ORACLE === "mock") { compose(args, opts); return; }
  const deadline = Date.now() + 60000;
  for (;;) {
    try { compose(args, opts); return; }
    catch (e) {
      if (Date.now() >= deadline) throw new Error(`db did not become ready within 60s: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Where a project keeps the `.sql` files `oracle up` loads: `oracle.seed` when the config
// sets it, `tests/seed` otherwise — the path `contract` writes to and everything else in
// the pipeline reads. A trailing slash is tolerated, since that is how the key reads most
// naturally in YAML.
export function seedDirFor(config) {
  return (config?.oracle?.seed || "tests/seed").replace(/\/+$/, "");
}

// The seed files a load would apply, in ascending name order — shared between `loadSeed`
// below and `oracle.mjs`'s check for seed files that exist but have nowhere to load into
// (`oracle.db` not configured).
export function seedFiles(projectDir, config) {
  const dir = join(projectDir, seedDirFor(config));
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
}

// Loads every seed file, in ascending name order, through
// `compose exec -T <db.service> psql -v ON_ERROR_STOP=1 -U <db.user> -d <db.database>`,
// piping each file as stdin. `ON_ERROR_STOP=1` makes a broken seed file fail the call
// (and so the whole `oracle up`) instead of loading partway and reporting success.
// Returns the list of files loaded, for the caller to report or assert on.
export function loadSeed(projectDir, config, baseArgs, opts) {
  const db = config.oracle.db;
  const dir = join(projectDir, seedDirFor(config));
  const files = seedFiles(projectDir, config);
  for (const f of files) {
    const args = [...baseArgs, "exec", "-T", db.service, "psql", "-v", "ON_ERROR_STOP=1", "-U", db.user, "-d", db.database];
    compose(args, { ...opts, input: join(dir, f) });
  }
  return files;
}

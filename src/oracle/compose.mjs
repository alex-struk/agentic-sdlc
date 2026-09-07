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

// Runs `docker compose <args>` synchronously, in `cwd`, with `env` merged over the
// ambient environment. `input` is a path to a file whose contents are piped to the
// process's stdin (`loadSeed` below uses this to feed a `.sql` file to `psql` without
// shelling out through a redirect the way a person would at a terminal).
//
// Under `SDLC_ORACLE=mock` nothing is spawned: the call is appended to
// `oracle-calls.json` as `{ args, env, input }` (`input` present only for calls that
// pipe a file) and the answer is `""`, except `ps --format json`, which answers with
// whatever `SDLC_MOCK_DIR/oracle-ps.json` holds — a test's way of saying a container is
// already running — or `""` when that file is not present.
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
    return "";
  }
  try {
    const opts = { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] };
    if (input) opts.input = readFileSync(input, "utf8");
    return execFileSync("docker", ["compose", ...args], opts);
  } catch (e) {
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

// The `tests/seed/*.sql` files a load would apply, in ascending name order — shared
// between `loadSeed` below and `oracle.mjs`'s check for seed files that exist but have
// nowhere to load into (`oracle.db` not configured).
export function seedFiles(projectDir) {
  const seedDir = join(projectDir, "tests", "seed");
  return existsSync(seedDir) ? readdirSync(seedDir).filter((f) => f.endsWith(".sql")).sort() : [];
}

// Loads every `tests/seed/*.sql` file, in ascending name order, through
// `compose exec -T <db.service> psql -v ON_ERROR_STOP=1 -U <db.user> -d <db.database>`,
// piping each file as stdin. `ON_ERROR_STOP=1` makes a broken seed file fail the call
// (and so the whole `oracle up`) instead of loading partway and reporting success.
// Returns the list of files loaded, for the caller to report or assert on.
export function loadSeed(projectDir, baseArgs, db, opts) {
  const seedDir = join(projectDir, "tests", "seed");
  const files = seedFiles(projectDir);
  for (const f of files) {
    const args = [...baseArgs, "exec", "-T", db.service, "psql", "-v", "ON_ERROR_STOP=1", "-U", db.user, "-d", db.database];
    compose(args, { ...opts, input: join(seedDir, f) });
  }
  return files;
}

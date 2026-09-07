// `sdlc oracle up|down|status [--target <t>]` — the old application's lifecycle. Later
// stages (`bind-adapter`, `calibrate`) compare a candidate against the old application
// running through Docker Compose on ports this command chooses, so nothing about the
// host's other traffic can collide with it. Every actual `docker compose` invocation
// goes through `compose()` in `src/oracle/compose.mjs`, the one place `SDLC_ORACLE=mock`
// stands in for a real Docker daemon.
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadConfig } from "../config/load.mjs";
import { git, SDLC_AUTHOR, stagePaths } from "../lib/git.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { freePort, readLocal, removeLocal, writeLocal } from "../oracle/ports.mjs";
import { compose, composeVersion, loadSeed, waitForDb, waitForHttp } from "../oracle/compose.mjs";
import { oracleOverridePath } from "../stages/registry.mjs";
import { COMMANDS } from "../cli.mjs";

// `docker compose ps --format json` answers either one JSON array or one JSON object per
// line, depending on the installed version — both are read the same way here so a caller
// never has to know which shape this machine's Docker happens to produce.
function parsePsJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try { const v = JSON.parse(trimmed); return Array.isArray(v) ? v : [v]; }
  catch { return trimmed.split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
}

// The `-p <project> -f <compose> -f <override>` prefix every compose call for one
// `oracle` invocation shares, built once so `up`, `down` and `status` never risk
// naming the files in a different order from each other.
function baseArgs(config, project) {
  return ["-p", project, "-f", config.oracle.compose, "-f", oracleOverridePath(config)];
}

// App port: the port already named in `oracle.base_url` when it is free, so a project's
// configured URL keeps working across runs whenever nothing else has taken it; otherwise
// the first free port from 3100. Db and mail API always scan from their own ranges,
// which sit far enough from 3100 and from each other that a real collision between the
// three would mean something already very unusual about this machine's open ports — so
// this only guards against it rather than working around it silently.
async function pickPorts(baseUrl) {
  let preferApp = null;
  try {
    const u = new URL(baseUrl);
    preferApp = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
  } catch { /* an unparseable base_url just means no preferred app port */ }
  const app = await freePort(preferApp, 3100);
  const db = await freePort(null, 5500);
  const mail_api = await freePort(8025, 8025);
  const values = [app, db, mail_api];
  if (new Set(values).size !== values.length) {
    throw new Error(`oracle up: chose overlapping ports (app ${app}, db ${db}, mail API ${mail_api}); free up ports in the 3100/5500/8025 ranges and try again`);
  }
  return { app, db, mail_api };
}

function composeEnv(config, ports) {
  return {
    SDLC_APP_PORT: String(ports.app),
    SDLC_DB_PORT: String(ports.db),
    SDLC_MAIL_API_PORT: String(ports.mail_api),
    SDLC_MAIL_API: `http://localhost:${ports.mail_api}`,
    ...(config.oracle.env ?? {}),
  };
}

// Appends a run-record line and commits it with the pipeline's own identity, the same
// way `rule.mjs` commits a ruling — but only when the tree was already clean before this
// call: an `oracle up`/`down` run in the middle of other uncommitted work must not sweep
// that work into a commit it did not ask for, so it just prints in that case and leaves
// the run record itself uncommitted for whatever commits the rest of the tree next.
function recordRun(projectDir, line) {
  const wasClean = !git(["status", "--porcelain"], projectDir);
  const runPath = appendRun(projectDir, line);
  if (!wasClean) return;
  stagePaths(projectDir, [relative(projectDir, runPath)]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `chore(oracle): ${line}`], projectDir);
}

async function oracleUp(projectDir, config, target) {
  const composePath = join(projectDir, config.oracle.compose);
  if (!existsSync(composePath)) {
    console.error(`oracle up: compose file not found: ${config.oracle.compose}`);
    return 1;
  }
  if (process.env.SDLC_ORACLE !== "mock") {
    const dc = composeVersion();
    if (!dc.found) {
      console.error("oracle up: docker compose is not available (docker compose version failed); install Docker Compose, or run sdlc doctor to check tools");
      return 1;
    }
  }

  const composeProject = `sdlc-${config.project.name}-${target}`;

  // Already up: a local file from a previous `oracle up` names a compose project, and if
  // that project still has containers, this run is a no-op — the same ports and the same
  // URLs are still good, and starting a second copy over them would be wrong twice over.
  const existing = readLocal(projectDir, target);
  if (existing) {
    const psOut = compose([...baseArgs(config, existing.compose_project), "ps", "--format", "json"], { cwd: projectDir });
    if (parsePsJson(psOut).length > 0) {
      console.log(`oracle up: ${existing.base_url} (mail API ${existing.mail_api})`);
      return 0;
    }
  }

  const ports = await pickPorts(config.oracle.base_url);
  const baseUrl = `http://localhost:${ports.app}`;
  const mailApi = `http://localhost:${ports.mail_api}`;
  writeLocal(projectDir, target, { target, base_url: baseUrl, ports, mail_api: mailApi, compose_project: composeProject });

  const opts = { cwd: projectDir, env: composeEnv(config, ports) };
  const base = baseArgs(config, composeProject);

  // Every service except `service` and `migrate_service` when `oracle.up` is empty: the
  // pipeline reads that as "bring up everything the compose file defines except the
  // application and the one-off migration service", but `docker compose up -d --build`
  // with no service names already does exactly that — it brings up every service the
  // compose file (base plus override) defines. Naming `service` and `migrate_service`
  // explicitly here would start the application before its database and migration have
  // run, so the override is expected to define the application service without also
  // listing it in a profile or dependency that `up` with no names would start early.
  compose([...base, "up", "-d", "--build", ...(config.oracle.up ?? [])], opts);

  // Nothing to wait for or seed without a configured database — a project can run an
  // oracle with no database at all (a static site, say), and `db` is optional for
  // exactly that reason.
  if (config.oracle.db) {
    await waitForDb(base, config.oracle.db, opts);
    if (config.oracle.migrate_service) compose([...base, "run", "--rm", config.oracle.migrate_service], opts);
    loadSeed(projectDir, base, config.oracle.db, opts);
  }

  compose([...base, "up", "-d", config.oracle.service ?? "app"], opts);
  await waitForHttp(`${baseUrl}/`, 180000);

  console.log(`oracle up: ${baseUrl} (mail API ${mailApi})`);
  recordRun(projectDir, `oracle up ${target}: ${baseUrl}`);
  return 0;
}

function oracleDown(projectDir, config, target) {
  const local = readLocal(projectDir, target);
  const composeProject = local?.compose_project ?? `sdlc-${config.project.name}-${target}`;
  compose([...baseArgs(config, composeProject), "down", "-v"], { cwd: projectDir });
  removeLocal(projectDir, target);
  console.log(`oracle down: ${target}`);
  recordRun(projectDir, `oracle down ${target}`);
  return 0;
}

function oracleStatus(projectDir, config, target) {
  const local = readLocal(projectDir, target);
  if (!local) {
    console.log(`oracle status: ${target} is not up`);
    return 0;
  }
  console.log(`target: ${local.target}`);
  console.log(`base_url: ${local.base_url}`);
  console.log(`mail_api: ${local.mail_api}`);
  console.log(`ports: app=${local.ports.app} db=${local.ports.db} mail_api=${local.ports.mail_api}`);
  console.log(`compose_project: ${local.compose_project}`);
  const psOut = compose([...baseArgs(config, local.compose_project), "ps"], { cwd: projectDir });
  console.log(psOut.trim() || "(no containers)");
  return 0;
}

// The shared entry point behind `COMMANDS.oracle` below, exported so tests can drive it
// with an explicit `projectDir` rather than having to `process.chdir()` into a fixture
// the way the real CLI's `process.cwd()` would require.
export async function runOracle(projectDir, sub, { target: wantedTarget } = {}) {
  if (!["up", "down", "status"].includes(sub)) {
    console.error(`unknown oracle subcommand: ${sub ?? "(none)"}\nusage: sdlc oracle up|down|status [--target <t>]`);
    return 2;
  }
  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) { console.error(`.sdlc/config.yaml is invalid:\n  ${errors.join("\n  ")}`); return 1; }
  if (!config.oracle) { console.error("oracle: this project has no oracle configured (config.oracle is missing from .sdlc/config.yaml)"); return 1; }
  const target = wantedTarget ?? config.oracle.target;
  if (target !== config.oracle.target) {
    console.error(`oracle: "${target}" is not config.oracle.target ("${config.oracle.target}") — this project has only one oracle target`);
    return 1;
  }
  if (sub === "up") return oracleUp(projectDir, config, target);
  if (sub === "down") return oracleDown(projectDir, config, target);
  return oracleStatus(projectDir, config, target);
}

COMMANDS.oracle = async ({ pos, flags }) => runOracle(resolve(process.cwd()), pos[0], { target: typeof flags.target === "string" ? flags.target : undefined });

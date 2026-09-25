// `sdlc oracle up|down|status [--target <t>]` — the old application's lifecycle. Later
// stages (`bind-adapter`, `calibrate`) compare a candidate against the old application
// running through Docker Compose on ports this command chooses, so nothing about the
// host's other traffic can collide with it. Every actual `docker compose` invocation
// goes through `compose()` in `src/oracle/compose.mjs`, the one place `SDLC_ORACLE=mock`
// stands in for a real Docker daemon.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { loadConfig } from "../config/load.mjs";
import { writeText } from "../lib/fsx.mjs";
import { git, SDLC_AUTHOR, stagePaths } from "../lib/git.mjs";
import { appendRun, deferRun } from "../lib/runrecord.mjs";
import { freePort, readLocal, removeLocal, writeLocal } from "../oracle/ports.mjs";
import { compose, composeVersion, loadSeed, seedDirFor, seedFiles, waitForDb, waitForHttp } from "../oracle/compose.mjs";
import { oracleOverridePath } from "../oracle/paths.mjs";
import { ensureSources } from "../runner/sources.mjs";
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
//
// Inside a stage (`stage` set) neither happens. The line waits for the stage's own
// run-record line (`deferRun`), so it reaches `main` in the stage's own commit or proposal
// rather than in a commit landing mid-stage, and the stage's scope checks never see the
// pipeline's own record as a change the agent made.
function recordRun(projectDir, line, stage) {
  if (stage) { deferRun(projectDir, line); return; }
  const wasClean = !git(["status", "--porcelain"], projectDir);
  const runPath = appendRun(projectDir, line);
  if (!wasClean) return;
  stagePaths(projectDir, [relative(projectDir, runPath)]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `chore(oracle): ${line}`], projectDir);
}

// Which services come up before the application itself. `oracle.up` names them when a
// project wants a particular set; left unset, the list is every service the compose files
// define minus the application and the one-off migration service, asked of compose itself
// (`config --services`) and passed explicitly. Naming them is what keeps `up` from
// starting the application before its database and migration have run — bare `up -d
// --build` starts everything, the application included.
function upServices(config, base, opts) {
  const configured = config.oracle.up ?? [];
  if (configured.length) return configured;
  const defined = String(compose([...base, "config", "--services"], opts)).split("\n").map((l) => l.trim()).filter(Boolean);
  const application = new Set([config.oracle.service ?? "app", config.oracle.migrate_service].filter(Boolean));
  return defined.filter((s) => !application.has(s));
}

// How many independent copies of the oracle to run. Each is a compose project of its own —
// its own application, its own database, its own mail catcher — so the acceptance suite can
// run that many tests at once without two of them sharing data. One by default, because a
// copy costs memory and a project that never runs the suite in parallel should pay nothing
// for the option.
function instanceCount(config) {
  return Math.max(1, Number(config.oracle.instances ?? 1));
}

// Instance 0 keeps the unsuffixed project name it has always had, so a project that was up
// before this existed is still found rather than started a second time beside itself.
function instanceProject(config, target, i) {
  const base = `sdlc-${config.project.name}-${target}`;
  return i === 0 ? base : `${base}-${i}`;
}

// The copies recorded by the last `oracle up`, oldest shape included: a file written before
// instances existed carries the one copy at its top level and no list.
export function instancesOf(local) {
  if (!local) return [];
  if (Array.isArray(local.instances) && local.instances.length) return local.instances;
  return [{ base_url: local.base_url, mail_api: local.mail_api, ports: local.ports, compose_project: local.compose_project }];
}

// A container name is global to the Docker daemon, so a compose file that pins one — and
// plenty do — lets exactly one copy of that service exist at a time, whatever project it
// belongs to. The second copy fails on the name rather than on anything about itself.
//
// Rather than ask every project to rewrite the old application's compose file, a run that
// wants more than one copy adds an override of the pipeline's own making: every service the
// compose files define, named after the compose project it belongs to. Written to a scratch
// file and never into the project, because it is a fact about running several copies on one
// machine rather than something the project decided.
function instanceNameArgs(config, project, wanted, opts) {
  if (wanted < 2) return [];
  const services = String(compose([...baseArgs(config, project), "config", "--services"], opts))
    .split("\n").map((l) => l.trim()).filter(Boolean);
  if (!services.length) return [];
  const body = ["services:", ...services.map((s) => `  ${s}:\n    container_name: ${project}-${s}`)].join("\n");
  const file = join(mkdtempSync(join(tmpdir(), "sdlc-oracle-names-")), "container-names.yml");
  writeText(file, `${body}\n`);
  return ["-f", file];
}

async function startOracle(projectDir, config, target, stage) {
  // Checked before anything that touches the network or the filesystem for real:
  // cloning the old application's sources is wasted work if Docker Compose is not even
  // on this machine, so the probe for it runs first and every later check builds on a
  // Docker that is actually there.
  if (process.env.SDLC_ORACLE !== "mock") {
    const dc = composeVersion();
    if (!dc.found) {
      console.error("oracle up: docker compose is not available (docker compose version failed); install Docker Compose, or run sdlc doctor to check tools");
      return 1;
    }
  }
  // A compose file under `sources/` belongs to the old application's clone, which the
  // pipeline materialises rather than the project committing — so it may simply not be
  // on disk yet on a fresh checkout, and checking out the configured commit is what puts
  // it there. Under mock there is no clone to make and no daemon to run it.
  if (config.oracle.compose.startsWith("sources/") && config.sources?.old && process.env.SDLC_ORACLE !== "mock") {
    ensureSources(projectDir, config);
  }
  const composePath = join(projectDir, config.oracle.compose);
  if (!existsSync(composePath)) {
    console.error(`oracle up: compose file not found: ${config.oracle.compose}`
      + (config.oracle.compose.startsWith("sources/")
        ? " — sources/old holds the old application's clone, checked out by the pipeline from config.sources.old"
        : ""));
    return 1;
  }
  // The override is `contract`'s own output (mailpit, the published ports, the app's
  // non-production sign-in routes). Without it every compose call below names a file
  // that is not there, and compose fails on each one in turn rather than once, here.
  const overrideRel = oracleOverridePath(config);
  if (!existsSync(join(projectDir, overrideRel))) {
    console.error(`oracle up: run sdlc run contract first: ${overrideRel} is missing`);
    return 1;
  }

  const composeProject = `sdlc-${config.project.name}-${target}`;

  // Already up: a local file from a previous `oracle up` names a compose project, and if
  // that project still has containers, this run is a no-op — the same ports and the same
  // URLs are still good, and starting a second copy over them would be wrong twice over.
  const wanted = instanceCount(config);
  const existing = readLocal(projectDir, target);
  if (existing && instancesOf(existing).length === wanted) {
    const psOut = compose([...baseArgs(config, existing.compose_project), "ps", "--format", "json"], { cwd: projectDir });
    if (parsePsJson(psOut).length > 0) {
      console.log(`oracle up: ${existing.base_url} (mail API ${existing.mail_api})${wanted > 1 ? `, ${wanted} copies` : ""}`);
      return 0;
    }
  }
  // A different number of copies than last time means the old ones are not what was asked
  // for. Taking them down first is the only way to reach the asked-for state, and leaving
  // them would strand containers nothing records any more.
  if (existing && instancesOf(existing).length !== wanted) {
    for (const inst of instancesOf(existing)) compose([...baseArgs(config, inst.compose_project), "down", "-v"], { cwd: projectDir });
  }

  const instances = [];
  for (let i = 0; i < wanted; i += 1) {
    // Ports are picked one copy at a time, and the copy is started before the next one's
    // are chosen: a free port is only free until something binds it, so choosing all of
    // them up front would hand the same port to every copy.
    const ports = await pickPorts(config.oracle.base_url);
    const baseUrl = `http://localhost:${ports.app}`;
    const mailApi = `http://localhost:${ports.mail_api}`;
    const project = instanceProject(config, target, i);
    const opts = { cwd: projectDir, env: composeEnv(config, ports) };
    const base = [...baseArgs(config, project), ...instanceNameArgs(config, project, wanted, opts)];

    compose([...base, "up", "-d", "--build", ...upServices(config, base, opts)], opts);

    // Nothing to wait for without a configured database — a project can run an oracle with
    // no database at all (a static site, say), and `db` is optional for exactly that
    // reason.
    if (config.oracle.db) await waitForDb(base, config.oracle.db, opts);

    // The migration service is independent of `db`: a project can run migrations through
    // a one-off compose service without the pipeline knowing that database's connection
    // details (the service manages its own), so this runs whenever `migrate_service` is
    // configured — after the db wait above when there is one, but not gated on it.
    if (config.oracle.migrate_service) compose([...base, "run", "--rm", config.oracle.migrate_service], opts);

    // Seeding, unlike migration, genuinely needs `db`: `loadSeed` connects with `psql`
    // using `db.user`/`db.database`, which only exist when `db` is configured. When seed
    // files are sitting in `tests/seed/` with no `db` to load them into, that is very
    // likely a config a project didn't mean to leave half-set, so this warns rather than
    // failing silently or refusing the whole `up`.
    if (config.oracle.db) {
      loadSeed(projectDir, config, base, opts);
    } else if (i === 0 && seedFiles(projectDir, config).length > 0) {
      console.warn(`oracle up: ${seedDirFor(config)}/*.sql files exist but oracle.db is not configured — seed not loaded`);
    }

    compose([...base, "up", "-d", config.oracle.service ?? "app"], opts);
    await waitForHttp(`${baseUrl}/`, 180000);
    instances.push({ base_url: baseUrl, mail_api: mailApi, ports, compose_project: project });

    // Written after each copy rather than at the end, so an `up` that fails partway leaves
    // a record of what is actually running for `oracle down` to clean up.
    writeLocal(projectDir, target, {
      target, base_url: instances[0].base_url, ports: instances[0].ports,
      mail_api: instances[0].mail_api, compose_project: instances[0].compose_project, instances,
    });
  }

  const baseUrl = instances[0].base_url;
  const mailApi = instances[0].mail_api;
  const ports = instances[0].ports;
  console.log(`oracle up: ${baseUrl} (mail API ${mailApi})${wanted > 1 ? `, ${wanted} copies` : ""}`);
  // The run record is committed history, so it names the target's configured URL and the
  // port only as a local fact: the port `pickPorts` landed on is whatever was free on
  // this machine and means nothing on anybody else's.
  recordRun(projectDir, `oracle up ${target}: ${config.oracle.base_url} (local port ${ports.app})`, stage);
  return 0;
}

// The tables a reset leaves alone: a migration tool's own bookkeeping. Emptying those
// would tell the application its schema had never been built, and the next thing to read
// them would try to migrate an already-migrated database. The four names below are what
// the common tools use, and `oracle.db.keep` replaces them for a project whose tool names
// its table something else.
const MIGRATION_TABLES = ["knex_migrations", "knex_migrations_lock", "schema_migrations", "migrations"];

// A name from config is written into SQL, so it is checked here as well as in the schema:
// one place validating it is one place that can be changed without the other noticing.
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Empties every other table in one statement, worked out in the database rather than
// listed here, so a schema that gains a table is covered without anybody remembering to
// add it. `CASCADE` because the tables reference each other and no order would satisfy
// them all; `RESTART IDENTITY` so a sequence does not carry numbers over from the run
// before and make a generated id depend on how many tests ran first.
export function truncateAllSql(keep = MIGRATION_TABLES) {
  const bad = keep.filter((t) => !TABLE_NAME.test(t));
  if (bad.length) throw new Error(`oracle.db.keep: not a table name: ${bad.join(", ")}`);
  const list = keep.map((t) => `'${t}'`).join(", ");
  return `DO $$
DECLARE stmt text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
    INTO stmt
    FROM pg_tables
   WHERE schemaname = 'public' AND tablename NOT IN (${list});
  IF stmt IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || stmt || ' RESTART IDENTITY CASCADE';
  END IF;
END $$;`;
}

// `sdlc oracle reseed` — put the database back to what the seed describes, without
// restarting anything. The acceptance suite runs it between tests: a test that deactivates
// an account or grants somebody administrator rights leaves that account changed for every
// test after it, and those tests then fail for a reason that has nothing to do with what
// they are checking. One calibration lost seven criteria to exactly that, and the product
// owner's answer was to make each test check its own accounts first, which is the symptom
// rather than the cause.
//
// It reuses the seed the oracle was started with, so there is one description of the
// starting state rather than a second one that could drift from it.
function oracleReseed(projectDir, config, target, instance) {
  const local = readLocal(projectDir, target);
  if (!local) { console.error(`oracle reseed: ${target} is not up; run sdlc oracle up first`); return 1; }
  const db = config.oracle.db;
  if (!db) { console.error("oracle reseed: config.oracle.db is not configured, so there is nowhere to load the seed into"); return 1; }
  const all = instancesOf(local);
  // One copy when the suite names it — each worker resets only its own, and resetting
  // another's would wipe data a test running right now is in the middle of using. All of
  // them when nobody says, which is what a person running this by hand means.
  if (instance !== undefined && !all[instance]) {
    console.error(`oracle reseed: ${target} has no copy ${instance} (${all.length} running)`);
    return 1;
  }
  const chosen = instance === undefined ? all : [all[instance]];
  let files = [];
  for (const inst of chosen) {
    const opts = { cwd: projectDir, env: composeEnv(config, inst.ports) };
    const base = baseArgs(config, inst.compose_project);
    compose([...base, "exec", "-T", db.service, "psql", "-v", "ON_ERROR_STOP=1", "-U", db.user, "-d", db.database,
      "-c", truncateAllSql(db.keep ?? MIGRATION_TABLES)], opts);
    files = loadSeed(projectDir, config, base, opts);
  }
  console.log(`oracle reseed: ${target} (${files.length} seed file(s)${chosen.length > 1 ? `, ${chosen.length} copies` : ""})`);
  return 0;
}

function oracleDown(projectDir, config, target, stage) {
  const local = readLocal(projectDir, target);
  const projects = local ? instancesOf(local).map((i) => i.compose_project) : [`sdlc-${config.project.name}-${target}`];
  for (const project of projects) compose([...baseArgs(config, project), "down", "-v"], { cwd: projectDir });
  removeLocal(projectDir, target);
  console.log(`oracle down: ${target}`);
  recordRun(projectDir, `oracle down ${target}`, stage);
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
//
// `stage` names the stage this call is part of. The executor sets `SDLC_STAGE` on every
// session it spawns (`src/runner/executor.mjs`), so a command a stage's agent runs carries
// it, and one a person runs does not.
export async function runOracle(projectDir, sub, { target: wantedTarget, instance, stage = process.env.SDLC_STAGE || undefined } = {}) {
  if (!["up", "down", "status", "reseed"].includes(sub)) {
    console.error(`unknown oracle subcommand: ${sub ?? "(none)"}\nusage: sdlc oracle up|down|status|reseed [--target <t>] [--instance <n>]`);
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
  if (sub === "up") return startOracle(projectDir, config, target, stage);
  if (sub === "reseed") return oracleReseed(projectDir, config, target, instance);
  if (sub === "down") return oracleDown(projectDir, config, target, stage);
  return oracleStatus(projectDir, config, target);
}

// The programmatic form of `sdlc oracle up`, for a stage that needs the old application
// running before it can do anything (`calibrate`, `src/stages/registry.mjs`). It runs the
// same lifecycle the command does — idempotent, so a target already up is found through
// its own local file rather than started a second time — and returns what that run
// recorded (`base_url`, `mail_api`, the ports, the compose project) instead of an exit
// code, so the caller does not have to read the local file itself to find out where the
// target ended up. It is only ever called from inside a stage, so its line is recorded as a
// stage's is: waiting for the stage's own.
export async function oracleUp(projectDir, { target, stage = "stage" } = {}) {
  const code = await runOracle(projectDir, "up", { target, stage });
  if (code !== 0) throw new Error(`oracle up failed for target "${target ?? "(the configured one)"}"`);
  const { config } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  return readLocal(projectDir, target ?? config?.oracle?.target);
}

COMMANDS.oracle = async ({ pos, flags }) => runOracle(resolve(process.cwd()), pos[0], {
  target: typeof flags.target === "string" ? flags.target : undefined,
  instance: flags.instance === undefined ? undefined : Number(flags.instance),
});

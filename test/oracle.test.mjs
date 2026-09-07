import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { createServer, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { freePort, readLocal } from "../src/oracle/ports.mjs";
import { compose, composeOptions } from "../src/oracle/compose.mjs";
import { runOracle } from "../src/commands/oracle.mjs";

// A minimal config.yaml carrying just enough for the schema plus a fully-specified
// `oracle` block: target `old`, a base compose file, a db to seed, and an app service to
// bring up last. Nothing here exercises any other stage, so the rest of the required
// top-level keys are filled with the smallest values the schema accepts.
const CONFIG = `
pipeline: { repo: agentic-sdlc, ref: main }
profile: rebuild
stack: openshift-ts
project:
  name: micro-oracle
  domains: [widgets]
sources:
  old: { repo: https://example.org/old.git, commit: 0123456789abcdef0123456789abcdef01234567 }
oracle:
  target: old
  compose: sources/old/docker-compose.yml
  seed: tests/seed/
  base_url: http://localhost:3100
  identity: session-route
  service: app
  up: [db, mailpit]
  migrate_service: migrate
  db: { service: db, user: postgres, database: appdb }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-1, E-2, E-3, E-4] }
`;

// Builds the "hand-built micro project" the brief calls for: just enough on disk for
// `sdlc oracle` to work with — a config, the base compose file, an override, and two
// seed files — committed so `oracle up`/`down` can exercise the "commit the run record
// when the tree started clean" path.
function makeMicroProject(tmp, config = CONFIG) {
  const dir = join(tmp, "micro-oracle");
  mkdirSync(join(dir, ".sdlc", "oracle"), { recursive: true });
  mkdirSync(join(dir, "sources", "old"), { recursive: true });
  mkdirSync(join(dir, "tests", "seed"), { recursive: true });
  writeFileSync(join(dir, ".sdlc", "config.yaml"), config);
  // Empty is enough: under SDLC_ORACLE=mock nothing ever reads this file's contents,
  // only its existence (the pre-flight "compose file must exist" check).
  writeFileSync(join(dir, "sources", "old", "docker-compose.yml"), "");
  writeFileSync(join(dir, ".sdlc", "oracle", "compose.yml"), "");
  writeFileSync(join(dir, "tests", "seed", "001-users.sql"), "-- seed users\n");
  writeFileSync(join(dir, "tests", "seed", "002-fees.sql"), "-- seed fees\n");
  // Without this, the local file `oracle up` writes (`.sdlc/oracle-old.local.yaml`) is
  // an untracked change of its own, and `recordRun`'s "was the tree clean before this
  // call" check would see it and skip committing the run record — exactly the ignore
  // rule templates/project/.gitignore carries in the real pipeline.
  writeFileSync(join(dir, ".gitignore"), ".sdlc/oracle-*.local.yaml\n");
  git(["init", "-q", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "micro oracle project"], dir);
  return dir;
}

function readCalls(mockDir) {
  const p = join(mockDir, "oracle-calls.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
}

async function withMock(t, fn) {
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-oracle-mock-"));
  process.env.SDLC_ORACLE = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try { await fn(mockDir); }
  finally { delete process.env.SDLC_ORACLE; delete process.env.SDLC_MOCK_DIR; }
}

test("oracle up: writes the local file with three distinct ports and runs the compose calls in order", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-oracle-up-"));
  const dir = makeMicroProject(tmp);
  await withMock(null, async (mockDir) => {
    const code = await runOracle(dir, "up", {});
    assert.equal(code, 0);

    const local = readLocal(dir, "old");
    assert.equal(local.target, "old");
    assert.equal(local.compose_project, "sdlc-micro-oracle-old");
    const ports = [local.ports.app, local.ports.db, local.ports.mail_api];
    assert.equal(new Set(ports).size, 3, `ports were not distinct: ${JSON.stringify(local.ports)}`);
    assert.equal(local.base_url, `http://localhost:${local.ports.app}`);
    assert.equal(local.mail_api, `http://localhost:${local.ports.mail_api}`);

    const calls = readCalls(mockDir);
    // No local file existed yet, so no "ps" idempotency probe is issued — the first
    // call is "up -d --build" with the configured `up` services, in order. Every call's
    // args carry the shared "-p <project> -f <compose> -f <override>" prefix (checked
    // separately below); this strips it to compare just the subcommand each call ran.
    const shapes = calls.map((c) => c.args.slice(6).join(" "));
    assert.equal(shapes[0], "up -d --build db mailpit");
    assert.equal(shapes[1], `exec -T db pg_isready -U postgres`);
    assert.equal(shapes[2], "run --rm migrate");
    assert.equal(shapes[3], "exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d appdb");
    assert.match(calls[3].input, /001-users\.sql$/);
    assert.equal(shapes[4], "exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d appdb");
    assert.match(calls[4].input, /002-fees\.sql$/);
    assert.equal(shapes[5], "up -d app");
    assert.equal(calls.length, 6);
    // The two service-bringup calls (and the migrate/pg_isready calls) never pipe a
    // file, so `input` is absent from their recorded shape rather than present-but-empty.
    assert.equal("input" in calls[0], false);
    assert.equal("input" in calls[2], false);

    // Every compose call carries the same -p/-f prefix, and the env recorded on the
    // service-bringup calls carries the chosen ports.
    for (const c of calls) assert.deepEqual(c.args.slice(0, 6), ["-p", "sdlc-micro-oracle-old", "-f", "sources/old/docker-compose.yml", "-f", ".sdlc/oracle/compose.yml"]);
    assert.equal(calls[0].env.SDLC_APP_PORT, String(local.ports.app));
    assert.equal(calls[0].env.SDLC_DB_PORT, String(local.ports.db));
    assert.equal(calls[0].env.SDLC_MAIL_API_PORT, String(local.ports.mail_api));
    assert.equal(calls[0].env.SDLC_MAIL_API, local.mail_api);

    // The run record was appended and committed (the tree started clean).
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /oracle up/);
    const day = new Date().toISOString().slice(0, 10);
    const runs = readFileSync(join(dir, `.sdlc/runs/${day}.md`), "utf8");
    assert.match(runs, new RegExp(`oracle up old: http://localhost:3100 \\(local port ${local.ports.app}\\)`));
  });
});

test("oracle down: removes the local file and calls down -v", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-oracle-down-"));
  const dir = makeMicroProject(tmp);
  await withMock(null, async (mockDir) => {
    await runOracle(dir, "up", {});
    const local = readLocal(dir, "old");
    assert.ok(local);

    const code = await runOracle(dir, "down", {});
    assert.equal(code, 0);
    assert.equal(readLocal(dir, "old"), null);

    const calls = readCalls(mockDir);
    const last = calls[calls.length - 1];
    assert.deepEqual(last.args, ["-p", local.compose_project, "-f", "sources/old/docker-compose.yml", "-f", ".sdlc/oracle/compose.yml", "down", "-v"]);

    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.match(git(["log", "-1", "--pretty=%s"], dir), /oracle down/);
  });
});

test("oracle up: a second up on a running oracle is a no-op (no new 'up' compose call)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-oracle-noop-"));
  const dir = makeMicroProject(tmp);
  await withMock(null, async (mockDir) => {
    const first = await runOracle(dir, "up", {});
    assert.equal(first, 0);
    const before = readCalls(mockDir);
    const localBefore = readLocal(dir, "old");

    // Simulate a running oracle: `docker compose ps --format json` under mock answers
    // with whatever oracle-ps.json holds.
    writeFileSync(join(mockDir, "oracle-ps.json"), JSON.stringify([{ Service: "app", State: "running" }]));

    const second = await runOracle(dir, "up", {});
    assert.equal(second, 0);
    const localAfter = readLocal(dir, "old");
    assert.deepEqual(localAfter, localBefore);

    const after = readCalls(mockDir);
    // The only new call is the ps probe; no new "up" call was issued.
    assert.equal(after.length, before.length + 1);
    const newCall = after[after.length - 1];
    assert.deepEqual(newCall.args.slice(6), ["ps", "--format", "json"]);
    assert.ok(!after.slice(before.length).some((c) => c.args[6] === "up"));
  });
});

test("oracle up: refuses when config.oracle is absent", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-oracle-noconfig-"));
  const dir = join(tmp, "no-oracle");
  mkdirSync(join(dir, ".sdlc"), { recursive: true });
  writeFileSync(join(dir, ".sdlc", "config.yaml"), CONFIG.replace(/oracle:\n(?:.*\n)*?(?=policy:)/, ""));
  git(["init", "-q", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "no oracle"], dir);

  await withMock(null, async () => {
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(" "));
    try {
      const code = await runOracle(dir, "up", {});
      assert.equal(code, 1);
      assert.ok(errors.some((e) => e.includes("no oracle configured")), errors.join("\n"));
    } finally { console.error = orig; }
  });
});

test("oracle up: migrate_service without oracle.db still migrates, skips db waits/seeding, and warns about unloaded seed files", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-oracle-nodb-"));
  const dir = join(tmp, "micro-oracle-nodb");
  mkdirSync(join(dir, ".sdlc", "oracle"), { recursive: true });
  mkdirSync(join(dir, "sources", "old"), { recursive: true });
  mkdirSync(join(dir, "tests", "seed"), { recursive: true });
  // Same config as the micro project above, minus the `db` block — a project can
  // configure `migrate_service` without `db` (a migration service managing its own
  // connection), which is exactly the case that must not be silently skipped.
  const config = CONFIG.replace(/\n  db: \{[^}]*\}\n/, "\n");
  writeFileSync(join(dir, ".sdlc", "config.yaml"), config);
  writeFileSync(join(dir, "sources", "old", "docker-compose.yml"), "");
  writeFileSync(join(dir, ".sdlc", "oracle", "compose.yml"), "");
  writeFileSync(join(dir, "tests", "seed", "001-users.sql"), "-- seed users\n");
  writeFileSync(join(dir, ".gitignore"), ".sdlc/oracle-*.local.yaml\n");
  git(["init", "-q", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "micro oracle project without db"], dir);

  await withMock(null, async (mockDir) => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(" "));
    let code;
    try { code = await runOracle(dir, "up", {}); }
    finally { console.warn = origWarn; }
    assert.equal(code, 0);

    const calls = readCalls(mockDir);
    const shapes = calls.map((c) => c.args.slice(6).join(" "));
    assert.deepEqual(shapes, ["up -d --build db mailpit", "run --rm migrate", "up -d app"]);
    assert.ok(!shapes.some((s) => s.includes("psql") || s.includes("pg_isready")), shapes.join("\n"));

    // A seed file exists but there is nowhere configured to load it into — a warning,
    // not a silent skip and not a failure.
    assert.ok(warnings.some((w) => w.includes("oracle.db")), warnings.join("\n"));
  });
});

test("freePort skips a port a test is listening on", async () => {
  // Bind an ephemeral port (0 asks the OS to pick one) and hold it open, so freePort
  // scanning upward from exactly that port must skip it.
  const holder = createServer();
  const held = await new Promise((res, rej) => {
    holder.once("error", rej);
    holder.listen(0, "127.0.0.1", () => res(holder.address().port));
  });
  try {
    const chosen = await freePort(null, held);
    assert.notEqual(chosen, held);
    assert.ok(chosen > held, `expected a port above ${held}, got ${chosen}`);
  } finally {
    await new Promise((res) => holder.close(res));
  }
});

test("freePort does not re-test a taken port twice when prefer and from are the same port", async (t) => {
  const holder = createServer();
  const held = await new Promise((res, rej) => {
    holder.once("error", rej);
    holder.listen(0, "127.0.0.1", () => res(holder.address().port));
  });
  // Spy on every port a real listen attempt targets, without changing behaviour (the
  // mock calls through to the original `listen`) — the fix is that `held` is bound once
  // by the `prefer` check and never re-tested as the scan's own starting port.
  const attempted = [];
  const originalListen = Server.prototype.listen;
  const listenSpy = t.mock.method(Server.prototype, "listen", function (...args) {
    attempted.push(args[0]);
    return originalListen.apply(this, args);
  });
  try {
    const chosen = await freePort(held, held);
    assert.notEqual(chosen, held);
    assert.ok(chosen > held, `expected a port above ${held}, got ${chosen}`);
    assert.equal(attempted.filter((p) => p === held).length, 1, `expected ${held} to be tried exactly once, tried: ${JSON.stringify(attempted)}`);
  } finally {
    listenSpy.mock.restore();
    await new Promise((res) => holder.close(res));
  }
});

// --- what a real `docker compose` call is given ---

test("compose options: every call carries a 256 MiB buffer; up and run stream, everything else is captured", () => {
  const prefix = ["-p", "proj", "-f", "docker-compose.yml", "-f", ".sdlc/oracle/compose.yml"];
  const up = composeOptions([...prefix, "up", "-d", "--build", "db"], { cwd: "/x" });
  assert.equal(up.maxBuffer, 256 * 1024 * 1024);
  assert.deepEqual(up.stdio, ["ignore", "inherit", "inherit"]);

  const run = composeOptions([...prefix, "run", "--rm", "migrate"], { cwd: "/x" });
  assert.deepEqual(run.stdio, ["ignore", "inherit", "inherit"]);

  // `ps` output is parsed by the caller, so it has to come back rather than scroll past.
  const ps = composeOptions([...prefix, "ps", "--format", "json"], { cwd: "/x" });
  assert.equal(ps.maxBuffer, 256 * 1024 * 1024);
  assert.deepEqual(ps.stdio, ["ignore", "pipe", "pipe"]);

  // A piped seed file needs stdin open; the file name is not the subcommand.
  const psql = composeOptions([...prefix, "exec", "-T", "db", "psql"], { cwd: "/x", input: "/seed/001.sql" });
  assert.deepEqual(psql.stdio, ["pipe", "pipe", "pipe"]);
});

test("compose: a docker whose output is larger than the old 1 MiB default is read in full", () => {
  // A stand-in `docker` on PATH that writes 2 MiB — what a real `up --build` does many
  // times over, and what execFileSync's default buffer aborts on with ENOBUFS.
  const binDir = mkdtempSync(join(tmpdir(), "sdlc-fake-docker-"));
  writeFileSync(join(binDir, "docker"), "#!/usr/bin/env node\nprocess.stdout.write(\"x\".repeat(2 * 1024 * 1024));\n");
  chmodSync(join(binDir, "docker"), 0o755);
  const prevPath = process.env.PATH;
  const prevOracle = process.env.SDLC_ORACLE;
  delete process.env.SDLC_ORACLE;
  process.env.PATH = `${binDir}:${prevPath}`;
  try {
    const out = compose(["-p", "proj", "-f", "docker-compose.yml", "ps", "--format", "json"], { cwd: binDir });
    assert.equal(out.length, 2 * 1024 * 1024);
  } finally {
    process.env.PATH = prevPath;
    if (prevOracle === undefined) delete process.env.SDLC_ORACLE;
    else process.env.SDLC_ORACLE = prevOracle;
  }
});

// --- which services come up, and in what order ---

test("oracle up: with no oracle.up configured, the services come from compose config --services minus the app and migration services", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-oracle-services-"));
  const dir = makeMicroProject(tmp, CONFIG.replace("  up: [db, mailpit]\n", ""));
  await withMock(null, async (mockDir) => {
    writeFileSync(join(mockDir, "oracle-services.txt"), "app\ndb\nmailpit\nmigrate\nredis\n");
    const code = await runOracle(dir, "up", {});
    assert.equal(code, 0);

    const shapes = readCalls(mockDir).map((c) => c.args.slice(6).join(" "));
    // `config --services` is asked first, then `up` names exactly what it answered minus
    // `service` (app) and `migrate_service` (migrate).
    assert.equal(shapes[0], "config --services");
    assert.equal(shapes[1], "up -d --build db mailpit redis");
    assert.equal(shapes[shapes.length - 1], "up -d app");
  });
});

test("oracle up: a configured oracle.up is used as it stands, with no compose config call", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-oracle-services-configured-"));
  const dir = makeMicroProject(tmp);
  await withMock(null, async (mockDir) => {
    writeFileSync(join(mockDir, "oracle-services.txt"), "app\ndb\nmailpit\nmigrate\nredis\n");
    assert.equal(await runOracle(dir, "up", {}), 0);
    const shapes = readCalls(mockDir).map((c) => c.args.slice(6).join(" "));
    assert.ok(!shapes.some((x) => x.startsWith("config")), shapes.join(" | "));
    assert.equal(shapes[0], "up -d --build db mailpit");
  });
});

// --- what has to be on disk before anything is composed ---

test("oracle up: refuses when the compose override the contract stage writes is missing", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-oracle-nooverride-"));
  const dir = makeMicroProject(tmp);
  rmSync(join(dir, ".sdlc", "oracle", "compose.yml"));
  await withMock(null, async (mockDir) => {
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(" "));
    try {
      assert.equal(await runOracle(dir, "up", {}), 1);
      assert.ok(errors.some((e) => e.includes("run sdlc run contract first: .sdlc/oracle/compose.yml is missing")), errors.join("\n"));
    } finally { console.error = orig; }
    assert.deepEqual(readCalls(mockDir), []);
  });
});

test("oracle up: a compose file under sources/ that is not there names the pipeline-owned clone", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-oracle-nosources-"));
  const dir = makeMicroProject(tmp);
  rmSync(join(dir, "sources", "old", "docker-compose.yml"));
  await withMock(null, async () => {
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(" "));
    try {
      assert.equal(await runOracle(dir, "up", {}), 1);
      assert.ok(errors.some((e) => e.includes("compose file not found") && e.includes("sources/old holds the old application's clone")), errors.join("\n"));
    } finally { console.error = orig; }
  });
});

// --- what the run record says ---

test("oracle up: the run record names the configured base_url and the port only as a local fact", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-oracle-record-"));
  const dir = makeMicroProject(tmp);
  await withMock(null, async () => {
    assert.equal(await runOracle(dir, "up", {}), 0);
    const local = readLocal(dir, "old");
    const day = new Date().toISOString().slice(0, 10);
    const runs = readFileSync(join(dir, `.sdlc/runs/${day}.md`), "utf8");
    assert.match(runs, new RegExp(`oracle up old: http://localhost:3100 \\(local port ${local.ports.app}\\)`));
    // The machine-local URL itself is never written into committed history.
    assert.ok(!runs.includes(`oracle up old: ${local.base_url}\n`), runs);
  });
});

// --- where the seed files come from ---

test("oracle up: oracle.seed points the loader at the directory it names, and defaults to tests/seed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-oracle-seeddir-"));
  const dir = join(tmp, "micro-oracle-seeddir");
  mkdirSync(join(dir, ".sdlc", "oracle"), { recursive: true });
  mkdirSync(join(dir, "sources", "old"), { recursive: true });
  mkdirSync(join(dir, "db", "fixtures"), { recursive: true });
  writeFileSync(join(dir, ".sdlc", "config.yaml"), CONFIG.replace("  seed: tests/seed/\n", "  seed: db/fixtures\n"));
  writeFileSync(join(dir, "sources", "old", "docker-compose.yml"), "");
  writeFileSync(join(dir, ".sdlc", "oracle", "compose.yml"), "");
  writeFileSync(join(dir, "db", "fixtures", "010-widgets.sql"), "-- widgets\n");
  writeFileSync(join(dir, ".gitignore"), ".sdlc/oracle-*.local.yaml\n");
  git(["init", "-q", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "seed elsewhere"], dir);

  await withMock(null, async (mockDir) => {
    assert.equal(await runOracle(dir, "up", {}), 0);
    const piped = readCalls(mockDir).filter((c) => c.input);
    assert.equal(piped.length, 1);
    assert.match(piped[0].input, /db\/fixtures\/010-widgets\.sql$/);
  });
});

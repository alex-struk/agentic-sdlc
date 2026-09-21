// Where a rebuilt target's local sandbox comes from, resolved once from the config so the
// command, the verify stage and the acceptance harness all name the same compose project.
//
// The rebuilt application is the project's own: the stack profile has it declare its local
// services in `app/compose/compose.yaml`, including a one-shot service that loads the seed
// the acceptance suite's handles name (`tests/seed/manifest.yaml`). Nothing here knows what
// is inside that file; the runner starts it, waits for it, and runs its seed service.
import { join } from "node:path";

const DEFAULT_COMPOSE = "app/compose/compose.yaml";
const DEFAULT_SEED_SERVICE = "seed";

export function targetSettings(config, target) {
  const t = config?.targets?.[target];
  if (!t) throw new Error(`unknown target ${target}: .sdlc/config.yaml has no targets.${target}`);
  return {
    baseUrl: t.base_url,
    identity: t.identity,
    // The addresses this target is not usable without, named. Empty for a target that
    // declares none, which is every target that predates the key.
    dependsOn: t.depends_on ?? {},
    compose: t.compose ?? DEFAULT_COMPOSE,
    seedService: t.seed_service ?? DEFAULT_SEED_SERVICE,
    project: `sdlc-${config.project.name}-${target}`,
  };
}

export function composeArgs(projectDir, settings, absolute = false) {
  return ["compose", "-p", settings.project, "-f", absolute ? join(projectDir, settings.compose) : settings.compose];
}

// What the harness runs before each test to put the data back to the seed. Absolute, since
// the harness runs from `tests/` and a relative compose path would not resolve there.
export function resetCommandFor(projectDir, config, target) {
  const s = targetSettings(config, target);
  return ["docker", ...composeArgs(projectDir, s, true), "run", "--rm", s.seedService].join(" ");
}

// Which half of a sandbox failure the caller is looking at. `up` reports one of these on
// every result it refuses, and the two are acted on differently: the application's fault
// is the build's output and goes back to the builder as a condition to fix, the machine's
// halts the run and is recorded against nothing (docs/decisions/0017-a-sandbox-that-is-not-up.md).
export const APPLICATION = "application";
export const ENVIRONMENT = "environment";

// `docker compose ps --format json` writes one JSON object per line in some versions and a
// single JSON array in others, and both spellings are in the field.
//
// The two empty answers are different answers and are returned differently. `[]` — compose
// printed nothing, or printed an empty array — means this project has no containers, which
// is something known. `null` means the text is a spelling this does not read, which is
// nothing known at all, and a caller that treated the two alike would report a sandbox up
// on the strength of an answer it could not parse.
export function parseComposePs(text) {
  const t = (text ?? "").trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    let a;
    try { a = JSON.parse(t); } catch { return null; }
    return Array.isArray(a) ? containerRows(a) : null;
  }
  if (!t.startsWith("{")) return null;
  const rows = [];
  for (const line of t.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    if (!l.startsWith("{")) return null;
    try { rows.push(JSON.parse(l)); } catch { return null; }
  }
  return containerRows(rows);
}

// Well-formed JSON is not yet an answer to the question asked. Every row compose writes for
// a container names it, so a document that parses but describes something else — a wrapper
// object, a different report — is `null` rather than a list of containers with nothing
// wrong with them.
function containerRows(rows) {
  return rows.every((r) => r && typeof r === "object" && (r.Name || r.Service)) ? rows : null;
}

// What one container's row says has become of it, or `null` when nothing has.
//
// Telling a one-shot service apart from a failed one is the whole difficulty here, and the
// answer is the exit code rather than the service's identity. A compose file legitimately
// contains services that run once and stop — a migration step, a seed step — and the only
// thing that distinguishes those from a long-running service that died is what they exited
// with. Compose itself draws the line in the same place: `service_completed_successfully`,
// the condition a dependant declares on a one-shot, is satisfied by exit 0 and by nothing
// else. So a container that has exited 0 has done its job whatever job that was, and a
// container that has exited non-zero has failed whether it was meant to run once or for
// ever. No list of one-shot service names is kept, because a list would have to be
// maintained against a compose file the pipeline does not own.
//
// `ran` is the other question the row answers: whether a container of this project got as
// far as running its own process. That is what separates the application's fault from the
// machine's, and it is a different question from whether the service is healthy.
export function serviceFailure(row) {
  const service = row?.Service || row?.Name || "(unnamed service)";
  const state = String(row?.State ?? "").toLowerCase();
  const exitCode = Number(row?.ExitCode ?? 0);
  const health = String(row?.Health ?? "").toLowerCase();
  // `Status` is the sentence compose writes for a person — `Up 3 seconds`,
  // `Restarting (1) 3 seconds ago`, `Exited (0) 2 minutes ago`. It is read alongside
  // `State` rather than instead of it, so a version that spells the machine-readable field
  // differently, or reports `running` while its own sentence says otherwise, is still
  // caught. The `(1)` in `Restarting (1)` is the exit code, not a restart count.
  const status = String(row?.Status ?? "").trim();
  if (state === "restarting" || /^restarting\b/i.test(status)) return { service, state: "restarting", ran: true, reason: "is restarting, so it starts, dies and starts again" };
  if (state === "dead") return { service, state, ran: true, reason: "is dead" };
  if (state === "exited") {
    return exitCode === 0 ? null : { service, state, exitCode, ran: true, reason: `exited with code ${exitCode}` };
  }
  if (state === "running") {
    return health === "unhealthy" ? { service, state, ran: true, reason: "is running, and its own healthcheck reports it unhealthy" } : null;
  }
  // `created` and `paused`: the container exists and its process never ran, which is not
  // the application failing at anything — nothing of it has executed yet.
  if (state === "created" || state === "paused") return { service, state, ran: false, reason: `is ${state}, so it never started` };
  return null;
}

export function serviceFailures(rows) {
  const out = [];
  for (const row of rows) {
    const f = serviceFailure(row);
    if (f) out.push(f);
  }
  return out;
}

// A container that reached a state of its own and failed out of it — restarting, dead,
// exited, unhealthy — is the application: the image it was built from and the files it read
// are this build's output. A failure with no such container behind it is the machine — a
// port already bound, an image that would not pull, a daemon that is not there — and there
// is no container to tell a builder anything about.
//
// The test is the container's state, not whether its process executed. An image whose
// entrypoint does not exist reports `exited` with code 127, and that is the application's
// even though nothing of the build ever ran: the entrypoint is named in a file this build
// wrote, and a builder can fix it.
export function causeOf(failures) {
  return failures.some((f) => f.ran) ? APPLICATION : ENVIRONMENT;
}

// The failures that are certain whatever else is still coming up, for the poll that waits
// for a target's addresses rather than for the watch that runs once every wait has passed.
//
// A container that is dead, or that has exited non-zero, is not going to serve the address
// something is waiting for: compose has finished with it. Every other state a failure can
// carry is one a healthy project passes through on its way up. `created` is a container
// compose has not started yet, and a healthcheck reports `unhealthy` for as long as a
// service is inside its start period — and `restarting` is the one that has to be read
// carefully, because it is both halves at once. A container that exits retrying a database
// it depends on is restarted, crash-loops for ten seconds and then runs, and `--wait`
// returns while that is going on. Nothing in a `ps` row tells that loop from one that will
// never end; only waiting does, which is what the poll around this is already doing.
//
// So a loop is left to the address itself. If the service recovers, its address answers
// and the wait ends; if it never does, the wait ends at its ceiling and the watch that
// runs after it reads `restarting` and refuses with the container named. The cost of
// ending a wait early on a loop is a build proposal returned for a sandbox that was
// seconds from healthy, which spends one of the slice's three attempts; the cost of
// waiting is the wait.
export function stoppedForGood(failures) {
  return failures.filter((f) => f.state === "dead" || f.state === "exited");
}

// Which host ports this project's containers publish, or `null` when compose named none —
// an older `ps --format json` that writes no `Publishers` field, or a project whose
// containers are reached some way this cannot see. `null` is nothing known, and a caller
// that read it as "this project publishes nothing" would call every address wrong.
export function publishedPorts(rows) {
  const ports = new Set();
  for (const row of rows) {
    if (!Array.isArray(row?.Publishers)) continue;
    for (const p of row.Publishers) {
      const n = Number(p?.PublishedPort ?? 0);
      if (n > 0) ports.add(n);
    }
  }
  return ports.size ? ports : null;
}

// The host port an address is asked on, or 0 for anything this cannot reason about — a
// string that is not a URL, or a scheme other than the two `up` polls over. Zero is not a
// port and every caller reads it as a question it declined to answer.
export function portOf(url) {
  let u;
  try { u = new URL(url); } catch { return 0; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return 0;
  return Number(u.port) || (u.protocol === "https:" ? 443 : 80);
}

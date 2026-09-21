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

// The failures that are already certain while the sandbox is still coming up, for the
// poll that waits for its addresses to answer rather than for the watch that runs once
// every wait has passed.
//
// A container that ran and is no longer running — restarting, dead, exited non-zero — has
// failed whatever else is still starting around it. The two states left out are ones a
// healthy project passes through on its way up: `created` is a container compose has not
// started yet, and a service's own healthcheck reports `unhealthy` for as long as it is
// inside its start period. Ending a wait on either of those would refuse sandboxes that
// were about to be fine, which is the opposite error from the one this all exists for and
// costs a run either way.
export function ranAndStopped(failures) {
  return failures.filter((f) => f.ran && f.state !== "running");
}

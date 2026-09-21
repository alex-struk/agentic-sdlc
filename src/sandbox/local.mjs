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
// single JSON array in others, and both spellings are in the field. Anything that is
// neither is read as "compose said nothing about this project's containers", which the
// caller treats as no evidence rather than as evidence of health.
export function parseComposePs(text) {
  const t = (text ?? "").trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try { const a = JSON.parse(t); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  const rows = [];
  for (const line of t.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try { rows.push(JSON.parse(l)); } catch { /* not a record compose wrote */ }
  }
  return rows;
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
  if (state === "restarting") return { service, state, ran: true, reason: "is restarting, so it starts, dies and starts again" };
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

// A container that started and then failed is the application: the process it ran is the
// build's own output. A failure with no such container behind it is the machine — a port
// already bound, an image that would not pull, a daemon that is not there — and nothing of
// what the builder wrote ever executed, so there is nothing to tell a builder to fix.
export function causeOf(failures) {
  return failures.some((f) => f.ran) ? APPLICATION : ENVIRONMENT;
}

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

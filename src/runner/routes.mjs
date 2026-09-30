// What a proposal's name, or a revision request, says a run is about: the stage and the
// domain, target or slice it runs on. Read from names, reasons and the configuration alone,
// with no git and no files, so the runner, the ruling and the stages that take requests up
// all read a request's subject the same way (`docs/decisions/0081`).

// The target a build proposes an application for, and a verify measures it on. A build
// slice's proposal is about this target's application, and its verify's failures are charged
// to this target's adapter (`docs/decisions/0075`).
export const BUILD_TARGET = "new";

// How a proposal's name maps to the stage that produced it and what it is about. Longer
// prefixes first, so a family whose name begins with another's is read as its own.
const ROUTES = [
  { prefix: "intent-", stage: "intent" },
  { prefix: "archaeology-", stage: "archaeology", subject: "domain" },
  { prefix: "ratify-", stage: "ratify", subject: "domain" },
  { prefix: "contract-v", stage: "contract" },
  { prefix: "derive-tests-", stage: "derive-tests", subject: "domain" },
  { prefix: "bind-adapter-", stage: "bind-adapter", subject: "target" },
  { prefix: "calibrate-triage-", stage: "calibrate", subject: "target" },
  { prefix: "calibrate-", stage: "calibrate", subject: "target" },
  { prefix: "design-", stage: "design", subject: "domain" },
  { prefix: "build-slice-", stage: "build", subject: "slice" },
  { prefix: "plan", stage: "plan", exact: /^plan(?:-\d+)?$/ },
];

// The flag each stage needs to say what it runs on.
export const SUBJECT_OF = { archaeology: "domain", ratify: "domain", "derive-tests": "domain", design: "domain", "bind-adapter": "target", calibrate: "target", build: "slice", verify: "slice" };

// Stages whose every run is on the build target, whatever else names them.
const ON_BUILD_TARGET = new Set(["build", "verify"]);

function configuredTargets(config) {
  return [...new Set([config?.oracle?.target, ...Object.keys(config?.targets ?? {})].filter(Boolean))];
}

// The stage a proposal came from and what it is about, or `null` for a proposal no stage
// opens (one made with `sdlc propose`).
export function routeOf(name, config) {
  const domains = config?.project?.domains ?? [];
  const targets = configuredTargets(config);
  for (const r of ROUTES) {
    if (r.exact ? !r.exact.test(name) : !name.startsWith(r.prefix)) continue;
    const rest = name.slice(r.prefix.length);
    if (!r.subject) return { stage: r.stage };
    if (r.subject === "slice") {
      const m = /^(\d+)(?:-\d+)?$/.exec(rest);
      return m ? { stage: r.stage, slice: Number(m[1]) } : null;
    }
    const list = r.subject === "domain" ? domains : targets;
    const hit = list.filter((x) => rest === x || rest.startsWith(`${x}-`)).sort((a, b) => b.length - a.length)[0];
    const route = { stage: r.stage, [r.subject]: hit ?? null };
    if (r.stage === "derive-tests" && hit && /^-stale-\d+$/.test(rest.slice(hit.length))) route.stale = true;
    return route;
  }
  return null;
}

// The target whose adapter a reason names by its path, `tests/adapters/<t>/…`, or `null` where
// it names none or more than one. Only a configured target counts, where the configuration
// names any, so a path that merely looks like an adapter's is not taken for one.
export function adapterTargetNamedIn(text, config) {
  const known = configuredTargets(config);
  const named = new Set();
  for (const m of String(text ?? "").matchAll(/tests\/adapters\/([A-Za-z0-9_.-]+)\//g)) {
    if (!known.length || known.includes(m[1])) named.add(m[1]);
  }
  return named.size === 1 ? [...named][0] : null;
}

// What a revision request's run is about, as `{ [flag]: value }`, for a stage that runs on a
// domain, target or slice; `{}` for a stage that runs on nothing in particular; `null` where the
// stage needs a subject and neither the request nor what it came from says which.
//
// The request's own field first: a ruling files it (`fileAddressedRequests` in
// `src/commands/rule.mjs`). Where it is missing, which is every request filed before rulings
// recorded one, it is read the way the ruling would have read it. The line of work that asked
// names it when that line is about the same kind of thing: a bind-adapter or calibration
// proposal names its target, a derive-tests or design proposal its domain, a build proposal its
// slice. A build proposal, and the verify that measured it, are on the build target, so what
// its ruling asks of a target-scoped stage is asked on that target. Failing both, a
// target-scoped request whose reason names exactly one adapter by its path is about that
// adapter's target.
export function requestSubject(request, config) {
  const s = SUBJECT_OF[request?.stage];
  if (!s) return {};
  const own = request[s];
  if (own !== undefined && own !== null && own !== "") return { [s]: own };
  const route = request.from ? routeOf(String(request.from), config) : null;
  const from = route?.[s];
  if (from !== undefined && from !== null) return { [s]: from };
  if (s !== "target") return null;
  if (route && ON_BUILD_TARGET.has(route.stage)) return { target: BUILD_TARGET };
  const named = adapterTargetNamedIn(request.why, config);
  return named ? { target: named } : null;
}

// The policy values the engine acts on, each read in one place with its default.
//
// Every key here is optional in `.sdlc/config.yaml`, and every default is the value the
// engine applies to a project that sets nothing. A reader asks this module rather than
// reaching into `config.policy` itself, so a default is written once and a caller cannot
// quietly apply a different one (`docs/config.md`, `policy`).

export const DEFAULT_VERIFY_RETURNS = 3;
export const DEFAULT_RATIFY_FOLLOW_UPS = 2;
export const DEFAULT_RATIFY_ON_LIMIT = "escalate";
export const DEFAULT_OWED_LOOP = 2;
export const OWED_LOOP_KINDS = Object.freeze(["rebind", "redo", "recovery", "request"]);
export const DEFAULT_POST_CHECK_REPAIRS = 1;
export const DEFAULT_CALIBRATE_ENVIRONMENT_FAULTS = 0;
export const DEFAULT_COMMAND_MINUTES = 30;
export const DEFAULT_ESCALATE_TIERS = Object.freeze(["HIGH", "CRITICAL"]);
export const DEFAULT_BLOCK_UNVERIFIED = Object.freeze(["HIGH", "CRITICAL"]);

// How many times verify may return one slice's build before the next failure escalates
// instead (spec §7.1). Counted per slice, across every cause verify returns a build for.
export function verifyReturnLimit(config) {
  return config?.policy?.loops?.verify_returns ?? DEFAULT_VERIFY_RETURNS;
}

// How many follow-up rulings a domain's still-unresolved provisional criteria get, and
// what `ratify` does with the ones still unresolved once that many have been ruled:
// `escalate` hands the next follow-up to G1's escalation target, `obsolete` drops them.
export function ratifyFollowUps(config) {
  const v = config?.policy?.loops?.ratify_follow_ups ?? {};
  return { max: v.max ?? DEFAULT_RATIFY_FOLLOW_UPS, onLimit: v.on_limit ?? DEFAULT_RATIFY_ON_LIMIT };
}

// How many times one item of owed work of this kind may be sent to the stage that owes it
// before what that stage produces for it is escalated to its gate's escalation target
// instead of ruled by the holder (spec §7.1). `null` for a kind with no loop to bound.
export function owedLoopLimit(config, kind) {
  if (!OWED_LOOP_KINDS.includes(kind)) return null;
  return config?.policy?.loops?.[kind] ?? DEFAULT_OWED_LOOP;
}

// How many rows of a calibration may fail for a reason that is the machine's — the target
// could not be reset, or could not be reached — before the run halts as an environment
// fault rather than recording its rows (spec §7.1, `env-defect`). None by default: each such
// row says nothing about the application, and recording it puts a question nobody can
// answer in front of the reviewer.
export function calibrateEnvironmentFaults(config) {
  return config?.policy?.calibrate?.environment_faults ?? DEFAULT_CALIBRATE_ENVIRONMENT_FAULTS;
}

// Which rows a calibration re-runs: `full`, every row, or `changed`, only the rows whose inputs
// changed since they were measured, carrying the rest (`docs/decisions/0072`). `full` by default,
// so a project re-runs its whole suite every time until it chooses otherwise.
export const CALIBRATE_SCOPES = Object.freeze(["full", "changed"]);
export const DEFAULT_CALIBRATE_SCOPE = "full";

export function calibrateScope(config) {
  const v = config?.policy?.calibrate?.scope;
  return CALIBRATE_SCOPES.includes(v) ? v : DEFAULT_CALIBRATE_SCOPE;
}

// Under `scope: changed`, how often a calibration of a target is full anyway: every n-th one, or
// `null` when the project sets no cadence and a full run comes only when something else calls
// for one.
export function calibrateFullEvery(config) {
  const n = config?.policy?.calibrate?.full_every;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// How long one command an agent session runs may take before the session's own tooling stops
// it, in minutes, by stage. It is long enough for the slowest thing a stage is asked to run for
// itself — bringing the oracle up, which pulls images, installs and migrates — and a session
// waits for a command in the foreground, so the limit is what keeps a hung one from holding the
// session for the rest of its turns (`docs/decisions/0065`).
export function commandMinutes(config, stage) {
  return config?.policy?.command_minutes?.[stage] ?? DEFAULT_COMMAND_MINUTES;
}

// How many repair turns a stage whose output failed its post-checks is given.
export function postCheckRepairs(config) {
  return config?.policy?.retries?.post_check_repair ?? DEFAULT_POST_CHECK_REPAIRS;
}

// The proposal tiers an agent-held gate escalates before its persona is asked anything.
export function escalateTiers(config) {
  return config?.policy?.escalate_tiers ?? DEFAULT_ESCALATE_TIERS;
}

// The criterion tiers at which a test of unverified provenance fails outright. At every
// other tier it needs an attestation instead.
export function blockUnverifiedTiers(config) {
  return config?.policy?.provenance?.block_unverified ?? DEFAULT_BLOCK_UNVERIFIED;
}

// Whether a G3 ruler may approve a build whose verify verdict is `pass-unasserted`.
export function approvesUnasserted(config) {
  return config?.policy?.gates?.G3?.approve_unasserted ?? true;
}

// Whether a G3 ruler is refused an approval of a build slice while a criterion it claims is
// owed a test that runs (`src/spec/missing-tests.mjs`).
export function blocksOnMissingTests(config) {
  return config?.policy?.gates?.G3?.block_on_missing_tests ?? true;
}

// The kinds of ready work `sdlc next` weighs against each other, and the order it takes them
// in when more than one kind is ready (`src/runner/next.mjs`). The record orders the work
// inside a kind; which kind goes first is not something the record can settle.
export const NEXT_KINDS = Object.freeze(["proposals", "owed", "sequence"]);

export function nextOrder(config) {
  const order = config?.policy?.next?.order;
  return Array.isArray(order) && order.length ? [...order] : [...NEXT_KINDS];
}

// How many approved proposals that change what the oracle's calibration measures may merge
// after its suite last ran before `sdlc next` names a calibration ahead of owed and sequence
// work, or `null` when the project sets no cadence (`docs/decisions/0070`).
export function calibrateAfter(config) {
  const n = config?.policy?.next?.calibrate_after;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// Whether a change to a record file made outside a pipeline commit warns or fails `checks`.
export const DEFAULT_HAND_EDITS = "warn";

export function handEditSeverity(config) {
  return config?.policy?.checks?.hand_edits ?? DEFAULT_HAND_EDITS;
}

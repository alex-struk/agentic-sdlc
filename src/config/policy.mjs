// The policy values the engine acts on, each read in one place with its default.
//
// Every key here is optional in `.sdlc/config.yaml`, and every default is the value the
// engine applies to a project that sets nothing. A reader asks this module rather than
// reaching into `config.policy` itself, so a default is written once and a caller cannot
// quietly apply a different one (`docs/config.md`, `policy`).

export const DEFAULT_VERIFY_RETURNS = 3;
export const DEFAULT_RATIFY_FOLLOW_UPS = 2;
export const DEFAULT_RATIFY_ON_LIMIT = "escalate";
export const DEFAULT_POST_CHECK_REPAIRS = 1;
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

// The runner's own approval of a proposal, given in place of the persona that holds the gate
// (`docs/decisions/0105`). A gate's `auto_approve` names the stages whose proposals it may
// settle, and it settles one only where every check below holds; where any fails, the persona
// is asked exactly as it would have been, and nothing is said about the check that failed.
//
// Every check reads the proposal against the commit its branch was cut from on `main`, which is
// what the persona's diff is read against too (`git diff main...proposal/<name>`).
import { git } from "../lib/git.mjs";
import { autoApproveStages } from "../config/policy.mjs";
import { deliveredBy, proposalFamily } from "../stages/registry.mjs";
import { returnRecordedAt } from "../stages/proposals.mjs";
import { openOn, readAt } from "../spec/owed.mjs";
import { routeOf } from "./routes.mjs";
import { ownedDirectory } from "./typecheck.mjs";
import { DIFF_EXCLUDE, requestsShown } from "./persona.mjs";
import { coveredBy } from "./workspace.mjs";

// Who an approval the runner gives is recorded as.
export const AUTO_APPROVER = "runner:checks";

const ACCEPTANCE = "tests/acceptance";
const CONTRACT = "spec/contract";

const lines = (text) => String(text ?? "").split("\n").filter(Boolean);

// How many times a file's text calls `expect(` at `rev`.
function expectsAt(projectDir, rev, path) {
  return git(["show", `${rev}:${path}`], projectDir).split("expect(").length - 1;
}

// Each changed path between the two commits with its status letter. Renames are read as a
// deletion and an addition, so a test moved to another path counts as the deletion it is of the
// path every record names it by.
function changes(projectDir, base, branch) {
  return lines(git(["diff", "--name-status", "--no-renames", base, branch], projectDir))
    .map((line) => { const [status, path] = line.split("\t"); return { status, path }; });
}

// What each stage's proposal has to show for the runner to settle it, as the sentence the
// rationale gives it, or `null`. A derivation is the one place a test rewritten to assert less
// is caught, so a test deleted, changed to call `expect(` fewer times than it did, or added
// calling it not at all, is left to the persona. A contract that only adds to itself changes nothing anything is built on. A
// binding that changed only what its stage delivers (`deliveredBy`, the same list a ruling's
// conditions are held to) is a binding and nothing else; the run record, the journal, the
// proposal page and the state site are the runner's own records of the run and are not read.
const STAGE_CHECKS = {
  "derive-tests": (projectDir, { base, branch }) => {
    const changed = changes(projectDir, base, branch);
    if (changed.some((c) => c.status === "D" && coveredBy([ACCEPTANCE], c.path))) return null;
    const weaker = changed.some((c) => c.path.endsWith(".spec.ts") && (
      (c.status === "M" && expectsAt(projectDir, branch, c.path) < expectsAt(projectDir, base, c.path))
      || (c.status === "A" && expectsAt(projectDir, branch, c.path) === 0)));
    return weaker ? null : "no test file was deleted, no changed test asserts less than before and no new test asserts nothing";
  },
  contract: (projectDir, { base, branch }) => {
    const rows = lines(git(["diff", "--numstat", "--no-renames", base, branch, "--", CONTRACT], projectDir));
    // A binary file's row counts no lines (`-`), so a deletion cannot be ruled out of it.
    const deletes = rows.some((row) => { const deleted = row.split("\t")[1]; return deleted === "-" || Number(deleted) > 0; });
    return deletes ? null : `no line under ${CONTRACT} was deleted`;
  },
  "bind-adapter": (projectDir, { base, branch, stage }) => {
    const delivers = deliveredBy(stage);
    const changed = lines(git(["diff", "--name-only", "--no-renames", base, branch, "--", ".", ...DIFF_EXCLUDE], projectDir));
    return changed.every((p) => coveredBy(delivers, p)) ? `nothing outside ${delivers.join(", ")} changed` : null;
  },
};

// The typecheck the runner ran on this checkout, in its own terms: clean is what it reports as
// `passed`, the compiler having run and exited 0. A failed or unavailable check is not clean. A
// proposal the typecheck compiles no suite for — one that answers for no directory under
// `tests/` (`ownedDirectory`), which is every contract proposal — has nothing for it to report,
// and is held to the other checks alone; a proposal it does answer for that carries no result
// was never checked.
function typecheckHeld(projectDir, name, stage, typecheck) {
  if (typecheck) {
    return typecheck.status === "passed"
      ? `the acceptance typecheck of ${git(["rev-parse", "--short", typecheck.revision], projectDir)} is clean`
      : null;
  }
  return ownedDirectory(name) ? null : `the runner typechecks no acceptance suite for a ${stage} proposal`;
}

// Whether a ruler has asked anything of this proposal that only a ruler can say was done, read
// from the same ledgers on `main` the persona's prompt is shown (`buildPersonaPrompt`): an
// instruction an earlier ruling asked of this stage, or a revision request the prompt would put
// in front of the ruler or that was asked of this stage, or one this proposal's run took up, which
// the run marks taken before the proposal is ruled. And a revision of a returned proposal,
// whatever the ledgers say: its branch was cut from the commit that recorded the return
// (`returnRecordedAt`). The work a stage is routinely sent — an unbound row, a test to derive
// again, a missing test — is not among them: whether it was done is what the next verify
// measures.
function owed(projectDir, { name, stage, base }) {
  if (returnRecordedAt(projectDir, base)) return true;
  const opts = { familyOf: proposalFamily };
  if (openOn(projectDir, "condition", "main", opts).some((c) => c.stage === stage)) return true;
  if (requestsShown(projectDir, name).length) return true;
  if (readAt(projectDir, "request", "main", opts).some((r) => r.taken_by === name)) return true;
  return openOn(projectDir, "request", "main", opts).some((r) => r.stage === stage);
}

// Whether the runner approves `name` at `gate` itself, and the rationale it records when it
// does. `onEscalation` is whether the ruling is on an escalation or one stands on the proposal:
// either makes the ruling something other than the holder's own, and the runner stands in for
// the holder alone. `failed` names the first check that did not hold, for a caller that wants
// to know; the ruling records nothing about it.
export function autoApproval(projectDir, { name, gate, config, typecheck = null, onEscalation = false }) {
  const route = routeOf(name, config);
  const stage = route?.stage ?? null;
  const refused = (failed) => ({ approve: false, failed, rationale: null });
  if (!stage || !STAGE_CHECKS[stage] || !autoApproveStages(config, gate).includes(stage)) return refused("policy");
  if (onEscalation) return refused("escalation");
  const typechecked = typecheckHeld(projectDir, name, stage, typecheck);
  if (!typechecked) return refused("typecheck");
  const branch = `proposal/${name}`;
  const base = git(["merge-base", "main", branch], projectDir);
  if (owed(projectDir, { name, stage, base })) return refused("owed");
  const delivered = STAGE_CHECKS[stage](projectDir, { base, branch, stage });
  if (!delivered) return refused(stage);
  const held = [typechecked, "no condition is open against it", "no escalation stands on it", delivered];
  return {
    approve: true,
    failed: null,
    rationale: `Approved by the runner's checks, which policy.gates.${gate}.auto_approve lets settle ${stage} proposals: ${held.join("; ")}.`,
  };
}

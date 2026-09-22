// An escalation that hands the question to nobody.
//
// An escalation is a hand-off: the seat holding the gate will not rule, so the question
// goes to the role the policy names. A verdict that escalates to the role the escalating
// seat itself holds hands it to no seat at all — the same agent is named as the one who
// could not rule and as the one who will — and the pipeline wrote that as an ordinary
// escalation. A proposal could then sit at its gate indefinitely, each ruling costing a
// turn, with nothing on disk saying it was going nowhere.
//
// It is not refused. A refusal would throw away a verdict and a rationale the persona
// already produced, which every record since `0028` says is the wrong trade, and the
// remaining verdicts are not open to a ruler that has just said the decision is above the
// pipeline: asking it again for an approval or a return is asking it to rule the thing it
// said it could not. The ruling is recorded whole and marked, so the stall is a fact in
// the record rather than an inference somebody has to draw from two files.
//
// The test is a comparison of two names and nothing else. A role escalating to a different
// role is untouched, and so is a person in the seat: a human `--by <role>` never carries
// the `agent:` prefix, which is what makes a person ruling an escalation an agent of the
// same role raised the ordinary way out of a stall rather than another instance of it.
import { parse as parseYaml } from "yaml";
import { git, gitOk } from "../lib/git.mjs";

// Why this escalation advances nothing, in the words written to the gate file, the run
// record and whatever tells an operator the stage cannot run. `null` for every escalation
// that does hand the question on.
export function stallReason({ by, escalateTo }) {
  if (!by || !escalateTo || by !== `agent:${escalateTo}`) return null;
  return `${by} escalated to ${escalateTo}, the role it holds itself, so no seat this pipeline can fill is`
    + ` waiting on it: a person has to rule it, or the proposal has to be withdrawn.`;
}

// The stall recorded on a proposal's branch, or `null`. Read out of the branch without
// checking it out, the way `rulePending` reads a standing escalation, so a caller standing
// on `main` can say why a proposal it is blocked by is not going to clear itself.
export function stalledOn(projectDir, branch, name) {
  const rel = `.sdlc/gates/${name}.yaml`;
  if (!gitOk(["cat-file", "-e", `${branch}:${rel}`], projectDir)) return null;
  let doc;
  try { doc = parseYaml(git(["show", `${branch}:${rel}`], projectDir)); } catch { return null; }
  const stalled = doc?.stalled;
  return typeof stalled === "string" && stalled.trim() ? stalled.trim() : null;
}

// Who ruled, in the three kinds that exist.
//
// A gate ruling comes from one of three places. A **persona agent** read the gate holder's
// written brief and ruled in that role. A **person** ran the command themselves. And the
// **runner** writes a verdict of its own — `verify` records a failing acceptance run as a
// return at its gate — which no seat held, nobody was asked for, and no judgement produced.
//
// Every reader asked `held_by === "agent"` and took the false branch to mean a person, so
// the runner's automatic verdict was published as a human sign-off. That is the one
// direction this column must never be wrong in: it is the column that answers "did a
// person decide this?", and a record that invents human accountability is worse than no
// record, because a reader has no way to tell the invented sign-off from a real one.
//
// The mapping therefore lives here rather than at each reader, and it is total. A value
// none of the three names is `unknown`: an unrecognised seat is a fact about the gate
// file, and reporting it as unknown costs a reader one question, where reporting it as a
// person asserts a decision that may never have been made. Unknown is the default because
// it is the least consequential reading, not because it is the likeliest.
export const SEAT_AGENT = "agent";
export const SEAT_RUNNER = "runner";
export const SEAT_HUMAN = "human";
export const SEAT_UNKNOWN = "unknown";

// The three a gate file may record, in the order the site reports them.
export const SEAT_KINDS = [SEAT_AGENT, SEAT_RUNNER, SEAT_HUMAN];

// The kind a gate file's `held_by` names, or `unknown`. A gate file is read off disk, where
// it can hold anything — hand-edited, written by a version of the pipeline this one does
// not know, or missing the field entirely — so this takes any value at all and places it.
export function seatKind(heldBy) {
  return SEAT_KINDS.includes(heldBy) ? heldBy : SEAT_UNKNOWN;
}

// An unrecognised value is quoted back so a reader can go and look at the gate file, and
// quoted safely: a Markdown table cell ends at the first `|`, and the value comes off a
// YAML file that can hold anything. Whitespace collapses, the delimiters that would break
// a cell or reopen inline markup are dropped, and a long value is cut — the point is to
// identify the value, not to reproduce it.
function unknownLabel(heldBy) {
  const raw = String(heldBy ?? "").replace(/\s+/g, " ").replace(/[|`*_<>[\]]/g, "").trim();
  if (!raw) return "unknown seat (the gate file records none)";
  return `unknown seat (${raw.length > 40 ? `${raw.slice(0, 40)}…` : raw})`;
}

// What the seat is called wherever a ruling is shown. One vocabulary for both renderings
// of the site, so the Markdown record in the repository and the HTML page a person reads
// cannot come to differ about which of the three ruled.
//
// "the runner, automatically" rather than a third role-shaped name: the runner does not
// hold the gate and was not asked, and a chip reading like a job title would put it beside
// the two seats that were. What the phrase says is that nothing was held and nobody ruled.
export function seatLabel(heldBy) {
  switch (seatKind(heldBy)) {
    case SEAT_AGENT: return "persona agent";
    case SEAT_RUNNER: return "the runner, automatically";
    case SEAT_HUMAN: return "a person";
    default: return unknownLabel(heldBy);
  }
}

// What to record as the seat for a `by` a caller gave. `agent:<persona>` and
// `runner:<component>` each name what produced the ruling; a bare role is a person, since
// naming the role you are sitting in is how a person rules and nothing else does it that
// way. Total over its input for the same reason `seatKind` is: the one interpretation a
// derivation must not reach by default is the human one.
export function heldByFor(by) {
  const s = String(by ?? "");
  if (s.startsWith(`${SEAT_AGENT}:`)) return SEAT_AGENT;
  if (s.startsWith(`${SEAT_RUNNER}:`)) return SEAT_RUNNER;
  return SEAT_HUMAN;
}

// The vocabulary of a results row, in one place, because three readers have to agree
// about it: the suite that writes the rows (`src/testrun/playwright.mjs`), the stage that
// turns them into a verdict (`src/stages/verify.mjs`), and the section a ruling persona is
// shown (`src/runner/verify-evidence.mjs`).
//
// Two of the values settle a criterion without the application ever being asked about it.
// `not-testable` is a criterion the contract surface offers no way to exercise, recorded
// with its reason in `tests/acceptance/not-testable.yaml`. `attested` is a criterion
// somebody vouched for in place of a test. Neither is a failure, and neither is evidence
// about the application, so they are named apart from both — a result that was never
// established must not be reported as one that succeeded
// (`docs/decisions/0033-a-criterion-nobody-asserted.md`).

// Every value a row's `result` field can hold, in the fixed order any count reports them
// in, so a row can never fall outside every column and be counted nowhere.
export const RESULT_VALUES = ["pass", "fail", "unbound", "stale", "not-testable", "attested"];

// The two that assert nothing about the application.
export const NOT_ASSERTED = new Set(["not-testable", "attested"]);

export const isNotAsserted = (row) => NOT_ASSERTED.has(row?.result);

// Why this criterion was never put to the application. The text is the project's own —
// a not-testable entry's `reason`, or whatever stands beside an attestation — and it is
// carried on the row so that the one place it is written down reaches every reader of the
// result. A row with none says so rather than reading as a row with nothing to explain.
export const notAssertedReason = (row) => String(row?.reason ?? "").trim() || "no reason recorded";

// One entry per claimed criterion nobody asserted, in the order the ids were claimed.
export function notAssertedEntries(rows, ids) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .filter((id) => isNotAsserted(byId.get(id)))
    .map((id) => ({ id, result: byId.get(id).result, reason: notAssertedReason(byId.get(id)) }));
}

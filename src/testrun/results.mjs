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

import { createHash } from "node:crypto";

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

// Two rulings on a failure say the test that produced a row does not test the criterion as it
// stands: `test-wrong`, the test is wrong and is derived again, and `spec-wrong`, the criterion
// is rewritten. A row carrying either shows no test of the criterion ran.
export const DISOWNED = new Set(["test-wrong", "spec-wrong"]);

export const isDisowned = (row) => DISOWNED.has(row?.ruled);

// Which test file a row is a result of: git's object id for the file's content, the value
// `git hash-object <file>` prints and a commit's tree holds for it. A run writes it on every row
// that names a file (`file_sha`), so a reader can tell a result of the test as it now stands
// from a result of an earlier test for the same criterion at the same version.
export function testFingerprint(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

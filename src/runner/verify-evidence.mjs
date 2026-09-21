import { git, gitOk } from "../lib/git.mjs";
import { isNotAsserted, notAssertedReason } from "../testrun/results.mjs";

// What a build ruling turns on, put in front of the ruler on purpose.
//
// `verify` writes one result file per slice on the proposal's own branch: the verdict,
// a row per criterion the slice claims, and — where the adapter could not bind something
// a test calls — the adapter's own account of what the application did not provide. That
// file is what an approval is refused without (`buildVerified`, src/commands/rule.mjs),
// and it is the only place in the pipeline an unbound reason is written down.
//
// It is also a changed file on the branch, which is how it used to reach the ruler: last
// in a diff ordered by nothing in particular, first to be dropped when the budget ran
// out. Evidence a gate is decided on cannot depend on surviving a cap. It is read here,
// summarised, and carried in a section of its own.

const NAME = /^build-slice-(\d+)(?:-\d+)?$/;

// The slice a build proposal is for, or null for a proposal that is not a build. The
// same shape `buildVerified` matches, including the `-2` a re-proposed build carries.
export function buildSliceOf(name) {
  return NAME.exec(name)?.[1] ?? null;
}

export function verifyResultPath(slice) {
  return `tests/results/new/slice-${slice}.json`;
}

// Read off the proposal's branch rather than off disk: a ruling has the branch checked
// out, but a caller that has not checked it out yet (a batch deciding what to rule) reads
// the same evidence from the same place.
export function readVerifyResult(projectDir, branch, slice) {
  const rel = verifyResultPath(slice);
  if (!gitOk(["cat-file", "-e", `${branch}:${rel}`], projectDir)) return null;
  try { return JSON.parse(git(["show", `${branch}:${rel}`], projectDir)); } catch { return null; }
}

// What bounds the section: a reason is quoted rather than described — the text is a
// browser's, a runner's or a project's own — and each is cut at a length that leaves room
// for every other row.
const ROW_REASON = 500;
const PASSING_NAMED = 40;
const REASON_ROWS = 20;

function cut(text) {
  const one = String(text).replace(/\s+/g, " ").trim();
  return one.length > ROW_REASON ? `${one.slice(0, ROW_REASON)} […]` : one;
}

// A row that ran carries its reason in the first test that errored; a row that never ran
// carries it on the row itself, written by whoever recorded that the application would not
// be asked about this criterion.
function rowReason(row) {
  if (row.reason) return cut(row.reason);
  const t = (row.tests ?? []).find((x) => x.error);
  return t ? cut(t.error) : "";
}

const VERDICT_MEANING = {
  pass: "every criterion the slice claims was exercised against the application and met.",
  "pass-unasserted": "nothing the slice claims failed, and the criteria marked below as never asserted were not put to the application at all — nothing is established about those, in either direction.",
  fail: "a criterion the slice claims was exercised and not met.",
  unbound: "the adapter could not bind something a test calls, so nothing was established about the criteria below marked `unbound` — in either direction.",
};

// The section a build ruling is given, bounded by construction: a line per criterion that
// did not pass with its own reason, the passing criteria named up to a limit and counted
// past it. A suite with hundreds of criteria cannot spend the budget the diff needs.
export function formatVerifyEvidence({ result, slice, branchAppTree }) {
  const rel = verifyResultPath(slice);
  const head = [`## Verify result for slice ${slice}`, ""];
  if (!result) {
    return [...head,
      `There is no verify result for this slice on this branch (\`${rel}\`). Nothing has been`,
      "established about whether the application meets the criteria the slice claims, so an",
      "approval is refused. A return or an escalation asserts nothing about the application and",
      "is available to you whatever the evidence says.",
    ].join("\n");
  }

  const rows = Array.isArray(result.rows) ? result.rows : [];
  // Three groups, not two. A criterion that was exercised and came out wrong and a
  // criterion nobody ever asserted are different questions for the ruler, and a single
  // "did not pass" count answers neither of them.
  const unasserted = rows.filter(isNotAsserted);
  const notPassed = rows.filter((r) => r.result !== "pass" && !isNotAsserted(r));
  const passed = rows.filter((r) => r.result === "pass");
  const lines = [...head,
    `Verdict: **${result.verdict}** — ${VERDICT_MEANING[result.verdict] ?? "see the rows below."}`,
    `Recorded by \`verify\` for proposal ${result.proposal}, against application tree ${String(result.app_tree ?? "").slice(0, 7)}, at ${result.at ?? "an unrecorded time"}.`,
  ];
  if (branchAppTree && result.app_tree && branchAppTree !== result.app_tree) {
    lines.push(`The application on this branch (tree ${branchAppTree.slice(0, 7)}) has changed since this result was recorded, so it is evidence about code that is no longer here.`);
  }
  if (result.not_verified) lines.push(`No test ran: ${result.not_verified}`);
  lines.push("", `${rows.length} criteria claimed by the slice: ${passed.length} pass, ${notPassed.length} did not pass, ${unasserted.length} never asserted against the application.`, "");

  for (const r of notPassed.slice(0, REASON_ROWS)) {
    const reason = rowReason(r);
    lines.push(`- ${r.id} — **${r.result}**${reason ? `: ${reason}` : ""}`);
  }
  if (notPassed.length > REASON_ROWS) {
    lines.push(`- and ${notPassed.length - REASON_ROWS} further criteria that did not pass: ${notPassed.slice(REASON_ROWS).map((r) => r.id).join(", ")}. Read them in \`${rel}\` on the branch.`);
  }
  // Named whatever the verdict is: a slice can fail on one criterion and have another
  // nobody asserted, and the second is invisible in a list of failures.
  for (const r of unasserted.slice(0, REASON_ROWS)) {
    lines.push(`- ${r.id} — **${r.result}**, never asserted against the application: ${rowReason(r) || notAssertedReason(r)}`);
  }
  if (unasserted.length > REASON_ROWS) {
    lines.push(`- and ${unasserted.length - REASON_ROWS} further criteria never asserted against the application: ${unasserted.slice(REASON_ROWS).map((r) => r.id).join(", ")}. Read their reasons in \`${rel}\` on the branch.`);
  }
  if (passed.length) {
    const named = passed.slice(0, PASSING_NAMED).map((r) => r.id).join(", ");
    lines.push(`- passed: ${named}${passed.length > PASSING_NAMED ? `, and ${passed.length - PASSING_NAMED} more` : ""}`);
  }
  lines.push("",
    "An approval is refused unless this result is current for this proposal and nothing the slice",
    "claims failed, so on any other verdict the ruling is a return or an escalation. Both are open",
    "to you here whatever the verdict: neither asserts anything about the application, and neither",
    "is evidenced by a suite result.");
  if (unasserted.length) {
    lines.push("",
      `Nothing in the pipeline decides whether this slice can be accepted with ${unasserted.length} ${unasserted.length === 1 ? "criterion" : "criteria"} nobody`,
      "asserted against the application. That is the question in front of you: approve it on the",
      "strength of what was asserted, or return it saying what would have to be asserted first, and",
      "against what.");
  }
  return lines.join("\n");
}

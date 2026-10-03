import { git, gitOk } from "../lib/git.mjs";
import { isNotAsserted, notAssertedReason } from "../testrun/results.mjs";
import { caseOf, casesPhrase, failuresOf, quotedList, withoutColour, FAILURES_DESCRIBED } from "../testrun/failures.mjs";

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
  const one = withoutColour(text).replace(/\s+/g, " ").trim();
  return one.length > ROW_REASON ? `${one.slice(0, ROW_REASON)} […]` : one;
}

// The lines a criterion is listed with. A row that never ran carries its reason on the row
// itself, written by whoever recorded that the application would not be asked about this
// criterion. A row that ran carries its reasons in its tests, and where they failed in different
// ways each way is listed with the cases that failed so: the ruler sees every fix the criterion
// needs, not only the first (`docs/decisions/0094`).
function rowLines(row, head, fallback = "") {
  if (row.reason) return [`${head}: ${cut(row.reason)}`];
  const failures = failuresOf(row);
  if (!failures.length) return [fallback ? `${head}: ${fallback}` : head];
  if (failures.length === 1) {
    const phrase = casesPhrase(row, failures[0]);
    return [`${head}${phrase ? `, ${phrase}` : ""}: ${cut(failures[0][0].error)}`];
  }
  const lines = [`${head}, ${failures.length} different failures:`];
  for (const tests of failures.slice(0, FAILURES_DESCRIBED)) lines.push(`  - ${casesPhrase(row, tests)}: ${cut(tests[0].error)}`);
  const rest = failures.slice(FAILURES_DESCRIBED).flat();
  if (rest.length) lines.push(`  - and ${rest.length} more ${rest.length === 1 ? "case" : "cases"}: ${quotedList(rest.map((t) => caseOf(row, t)))}`);
  return lines;
}

const VERDICT_MEANING = {
  pass: "every criterion the slice claims was exercised against the application and met.",
  "pass-unasserted": "nothing the slice claims failed, and the criteria marked below as never asserted were not put to the application at all — nothing is established about those, in either direction.",
  fail: "a criterion the slice claims was exercised and not met.",
  unbound: "the adapter could not bind something a test calls, so nothing was established about the criteria below marked `unbound` — in either direction.",
  environment: "a criterion the slice claims could not be tested in this environment — its test reads a mail catcher the target declares none of, or is written for a configuration verify cannot start the target in. Nothing was established about those criteria in either direction, and none of it is the build's.",
};

// What a ruler is asked when verify left the build open rather than returning it: some failures
// stopped on a read that came back with nothing, and whether the adapter looked in the wrong
// place or the application drew nothing there is a question the page answers and the builder
// cannot (`docs/decisions/0091`). Every failure is listed as verify would have returned it, so
// a ruler who finds it the application's passes it on exactly as written.
const SORT_SHOWN = 40;

function sortSection(sort) {
  const conditions = Array.isArray(sort.conditions) ? sort.conditions : [];
  const empty = Array.isArray(sort.empty_reads) ? sort.empty_reads : [];
  return [
    "### Failures to sort before the build goes back",
    "",
    `Verify did not return this build itself. ${empty.join(", ")} stopped on a read that came back with nothing — an empty text, an empty list — and that is the adapter's fault as often as the application's: it looked in the wrong place, or the application drew nothing there. The builder cannot see the page and cannot change the adapter, so each failure is sorted here first.`,
    "",
    "For each one, open the picture and the outline of the page named at its end (with Read; they are on this machine and not committed), and read the adapter member its last step names in `tests/adapters/new/`. Then:",
    "",
    "- the application's — the page does not show what the criterion needs: return it with the failure as a condition, copied exactly as it is written below;",
    `- the adapter's — the page shows it and the adapter read somewhere else, or read it wrongly: \`addressed-to bind-adapter: <the criterion id>: <what the adapter read, what the page shows instead, and where>\`.`,
    "",
    "A failure that is not an empty read is the application's unless the evidence plainly says otherwise. Return the build with every failure accounted for one way or the other.",
    "",
    ...conditions.slice(0, SORT_SHOWN).map((c) => `- ${c}`),
    ...(conditions.length > SORT_SHOWN ? [`- and ${conditions.length - SORT_SHOWN} more, in \`sort.conditions\` of the result file on the branch.`] : []),
  ];
}

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
  // A criterion the environment could not test is named as that, with the reason verify
  // recorded, whatever its row's own result says: the row is what the harness reported, and
  // the gap is why that says nothing about the application.
  const gaps = new Map((Array.isArray(result.environment) ? result.environment : []).map((g) => [g.id, g.reason]));
  const notPassed = rows.filter((r) => r.result !== "pass" && !isNotAsserted(r) && !gaps.has(r.id));
  const passed = rows.filter((r) => r.result === "pass" && !gaps.has(r.id));
  const lines = [...head,
    `Verdict: **${result.verdict}** — ${VERDICT_MEANING[result.verdict] ?? "see the rows below."}`,
    `Recorded by \`verify\` for proposal ${result.proposal}, against application tree ${String(result.app_tree ?? "").slice(0, 7)}, at ${result.at ?? "an unrecorded time"}.`,
  ];
  if (branchAppTree && result.app_tree && branchAppTree !== result.app_tree) {
    lines.push(`The application on this branch (tree ${branchAppTree.slice(0, 7)}) has changed since this result was recorded, so it is evidence about code that is no longer here.`);
  }
  if (result.not_verified) lines.push(`No test ran: ${result.not_verified}`);
  lines.push("", `${rows.length} criteria claimed by the slice: ${passed.length} pass, ${notPassed.length} did not pass, ${unasserted.length} never asserted against the application${gaps.size ? `, ${gaps.size} not tested in this environment` : ""}.`, "");

  for (const r of notPassed.slice(0, REASON_ROWS)) lines.push(...rowLines(r, `- ${r.id} — **${r.result}**`));
  if (notPassed.length > REASON_ROWS) {
    lines.push(`- and ${notPassed.length - REASON_ROWS} further criteria that did not pass: ${notPassed.slice(REASON_ROWS).map((r) => r.id).join(", ")}. Read them in \`${rel}\` on the branch.`);
  }
  for (const [id, reason] of gaps) lines.push(`- ${id} — not tested in this environment: ${cut(reason)}`);
  // Named whatever the verdict is: a slice can fail on one criterion and have another
  // nobody asserted, and the second is invisible in a list of failures.
  for (const r of unasserted.slice(0, REASON_ROWS)) {
    lines.push(...rowLines(r, `- ${r.id} — **${r.result}**, never asserted against the application`, notAssertedReason(r)));
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
  if (result.sort) lines.push("", ...sortSection(result.sort));
  if (unasserted.length) {
    lines.push("",
      `Nothing in the pipeline decides whether this slice can be accepted with ${unasserted.length} ${unasserted.length === 1 ? "criterion" : "criteria"} nobody`,
      "asserted against the application. That is the question in front of you: approve it on the",
      "strength of what was asserted, or return it saying what would have to be asserted first, and",
      "against what.");
  }
  return lines.join("\n");
}

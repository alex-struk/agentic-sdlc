import { failedLine } from "./playwright.mjs";

// How a criterion's failing tests are told apart and named: for the builder a failure goes back
// to, and for the ruler who reads verify's result (`docs/decisions/0094`). A criterion's test file
// holds one test per case, and its cases can fail for different reasons. Each reason is a fix of
// its own, so each is named, and the cases that failed the same way are named together.

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// The runner's colour codes, dropped from anything a builder or a ruler is shown.
export function withoutColour(text) {
  return String(text ?? "").replace(ANSI_RE, "");
}

// The lines of an assertion's message that say what the running application did and what was
// expected of it: `Expected pattern: /x/`, `Received string: ""`, or the element that took a
// click meant for another.
const APPLICATION_LINE_RE = /^(Expected|Received)( [a-z]+)?:|intercepts pointer events/;

// A failed test's message on one line: the error's first line, and after it the lines that say
// what the application did. The test's locators and call log are not carried, since they describe
// the test rather than the application.
export function failureMessage(test) {
  const lines = withoutColour(test?.error ?? "failed").split("\n").map((l) => l.trim().replace(/^- /, ""));
  const said = [...new Set(lines.slice(1).filter((l) => APPLICATION_LINE_RE.test(l)))];
  return [lines[0], ...said].join(" — ");
}

// The line of the test file a failed test stopped at, or null where it is not known.
export function stoppedAt(row, test) {
  if (Number.isInteger(test?.line)) return test.line;
  return failedLine(withoutColour(test?.error), String(row?.file ?? "")) ?? null;
}

// A criterion's failures in the order its tests ran. Failed tests that stopped at the same line
// with the same message are one failure, met in more than one case.
export function failuresOf(row) {
  const failures = new Map();
  for (const t of (row?.tests ?? []).filter((x) => x.error)) {
    const key = `${failureMessage(t)}\n${stoppedAt(row, t) ?? ""}`;
    failures.set(key, [...(failures.get(key) ?? []), t]);
  }
  return [...failures.values()];
}

// How many of a criterion's failures are described. Past it, the rest are named by their cases,
// so one criterion cannot crowd out the others.
export const FAILURES_DESCRIBED = 3;

// Every title carries the criterion's statement (`derive-tests`), as `<statement> (<case>)` or
// `<statement> — <case>`. The statement is the start all of a criterion's titles share, up to its
// last separator, and the case is what follows it.
const SEPARATORS = [" — ", " ("];
const CASE_LENGTH = 200;

function sharedStatement(titles) {
  if (titles.length < 2) return "";
  const [first, ...rest] = titles;
  let n = 0;
  while (n < first.length && rest.every((t) => t[n] === first[n])) n += 1;
  const cut = Math.max(...SEPARATORS.map((s) => first.slice(0, n).lastIndexOf(s)));
  return cut > 0 ? first.slice(0, cut) : "";
}

// The case a test asserts, as its title names it beyond the statement. A title that shares no
// statement with its siblings is named by a closing parenthesised case, or else whole.
export function caseOf(row, test) {
  const title = String(test?.title ?? "").trim();
  const statement = sharedStatement((row?.tests ?? []).map((t) => String(t.title ?? "").trim()));
  let named = statement && title.startsWith(statement) ? title.slice(statement.length).trim() : "";
  if (named.startsWith("— ")) named = named.slice(2).trim();
  else if (named.startsWith("(") && named.endsWith(")")) named = named.slice(1, -1).trim();
  if (!named) named = /\(([^()]+)\)\s*$/.exec(title)?.[1]?.trim() ?? title;
  return named.length > CASE_LENGTH ? `${named.slice(0, CASE_LENGTH - 1)}…` : named;
}

// `"a"`, `"a" and "b"`, `"a", "b" and "c"`.
export function quotedList(names) {
  const quoted = names.map((n) => `"${n}"`);
  return quoted.length < 2 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

// `in the case "<case>"` or `in the cases "<a>" and "<b>"`, for failed tests of a criterion whose
// file holds several cases. Nothing for a criterion of one test, which needs no name for it.
export function casesPhrase(row, tests) {
  if ((row?.tests ?? []).length < 2) return "";
  const names = tests.map((t) => caseOf(row, t)).filter(Boolean);
  return names.length ? `in the ${names.length === 1 ? "case" : "cases"} ${quotedList(names)}` : "";
}

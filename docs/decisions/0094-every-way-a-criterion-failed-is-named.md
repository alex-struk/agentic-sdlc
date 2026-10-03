# 0094 · Every way a criterion failed is named

Status: accepted · 2026-10-03

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

`derive-tests` writes one test per case a criterion states, so a criterion's test file usually
holds several tests. When verify returns a build, it writes one condition per failing criterion.
A G3 ruler of a build verify escalated reads one line per criterion that did not pass. Both were
made from the criterion's first failing test.

A criterion's cases can fail for different reasons, and each reason is a fix of its own. A reason
behind the first one reached nobody. The builder fixed what it was told, and the next verify found
the next reason. Each reason found that way cost a build revision, a verify run and a ruling, and
counted toward the return limit. A ruler shown one reason sent one fix, to the stage that owned
it, and the other reason came back from the next verify. In one project, 5 of the 19 criteria that
failed verify had cases that failed for different reasons.

The case was named by the test's title. Titles carry the criterion's statement and then the case,
as `<statement> (<case>)` or `<statement> — <case>`. Only the first form was understood. A title
of the second form was named whole and cut at 200 characters, and a long statement left no room
for the case.

## Decision

**1. A failing criterion goes back with one condition for each different way its tests failed.**
Failed tests that stopped at the same line of the test file with the same message are one failure,
met in more than one case. Its condition names each case:
`<id>, in the cases "<case>" and "<case>": <message> — at <file>:<line>`, followed by the steps
and the page of the first such test (`docs/decisions/0091`).

**2. Three failures of a criterion are described.** The remaining cases are named in one more
condition, `<id>: <k> more cases failed, not described here: "<case>", …`, so one criterion cannot
crowd out the others.

**3. A case is named by what its title adds to the criterion's statement.** The statement is the
start all of a criterion's titles share, up to its last ` — ` or ` (`. A title that shares nothing
with its siblings is named by a closing parenthesised case, or whole.

**4. The ruler reads a criterion's failures the same way.** The section a G3 ruler is given lists
each different failure of a criterion with its cases, three at most, under the criterion's line.
The runner's colour codes are dropped from it.

**5. An empty read in any failing case leaves the build to be sorted.** A failing verify is left
open for its G3 ruler when any test of a failing criterion stopped on a read that came back with
nothing, not only the criterion's first.

## Consequences

- A criterion whose cases fail for two reasons costs one revision rather than two, and a ruler
  can send each reason to the stage that owns it in one ruling.
- A return carries more conditions where cases fail differently. Each still names its criterion
  first, and a criterion's conditions are bounded.
- An assertion's expected value is carried in whichever form the runner gives it
  (`Expected pattern:`, `Expected substring:`), alongside what it received.

# 0058 · A row the machine failed is no test run

Status: accepted · 2026-09-25

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

`0046` closes a missing test on a result row showing its test ran, and counts a `fail` row because
the question is whether a test runs, not whether the application passes it. `0056` then found a
class of `fail` row that answers neither: the harness could not reset the target to its seed, or
the browser could not reach it, so every failing test stopped before its first assertion. `0056`
halts a calibration on such rows past a threshold, and keeps them as failures at or under it.

A calibration whose target could not be reset wrote its rows to `main` before that halt existed,
and the missing-test sync that ran with it closed every item whose row was `fail`, the reset's
failures among them. Of fifty items it closed, forty-six were on rows whose tests had never asked
the application anything. Each closure recorded the fingerprint of the test file, so the re-check
of past closures, which judged only closures written without one, passed over all of them.

## Decision

**A `fail` row that is an environment fault is not evidence a test ran.** The definition is the
one calibrate halts on (`environmentFault`, `src/testrun/results.mjs`): a failing row with any
failing test whose error says the target could not be reset or reached. One definition serves
both, so a row calibrate would refuse to ask about is never the row that closes an item. It
closes nothing at a calibration, at an approval's merge or at `rule --settle`, and it does not let
a slice past the G3 guard, where the same reading decides whether the verify result shows the
test ran. A row kept under the calibration threshold stays a failure for `verify` and triage, and
is still owed a run of its test.

**Every runner closure is judged again by the rule as it stands.** The re-check reads each met
closure the runner made at the commit that recorded it, with or without a fingerprint, and reopens
the item where no row there satisfies the rule: the closure is kept under `reopened` with the
reason, and the item goes where an open item goes, to `calibrate` or `verify` where its test exists
and has not run. A closure that holds under the rule is left alone, so a second pass changes
nothing. The reason names the fault and does not quote the harness's message, which carries paths
of the machine that ran it.

**The next pipeline commit that touches the list applies it.** On a project already holding such
closures, that is the next calibration that writes results, the next approval, or `sdlc rule
<name> --settle` on any approval already on `main`, each committed as the pipeline.

## Alternatives

**Count a row as a fault only when every one of its failing tests is.** A row whose other test
reached the application and failed did run something. It would also be a second definition beside
the one calibrate halts on, and the two would disagree on exactly the rows that matter. A row the
harness could not reset for even one test is owed a clean run.

**Re-check only closures whose row was `fail`.** It is cheaper, and it states the cause of this
change in the re-check rather than the rule. Judging every closure by the rule as it stands keeps
the re-check correct for whatever the rule next learns to reject.

## What would reverse it

The same evidence that would reverse `0056`: a reset that fails only when the application itself
misbehaves would make such a row a result of the application, and so a test that ran.

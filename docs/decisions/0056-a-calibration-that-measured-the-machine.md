# 0056 · A calibration that measured the machine

Status: accepted · 2026-09-25

## Context

`calibrate` turns every failing row into a question: first the reviewer sorts it (the adapter's
fault, or a product question), then the product owner rules on what is left. That is right for a
row whose test asked the application something and disagreed with the answer.

A calibration ran against an oracle whose per-test reset had stopped working
(`docs/decisions/0055-a-reset-that-waited-on-the-application-it-was-resetting.md`). Of the 247
rows that put a test to the application, 225 failed before the test began: the fixture could not
reset the target and said so, in 496 tests. The stage recorded all 225 as failures of their
criteria, wrote them into `latest.json`, and opened a triage proposal asking the reviewer to sort
211 of them. No sorting of those rows can be right. The adapter did not cause them, and neither did
the product, and a reviewer persona handed them will still produce an answer for each.

The design spec already names this class. §7.1's `env-defect` — "the sandbox, seed or observable is
broken" — is routed to "runner halts, reports", with a person deciding. `verify` follows it for a
sandbox that did not start (`0017`). `calibrate` had no equivalent: its only failure path before
the result set was a suite that produced no report at all.

## Decision

**A row the machine failed is told apart by what its test reported.** A failing test whose error
says the harness could not reset the target to its seed, or that the browser could not connect to
the target at all, never reached the application. The first phrase is the harness's own, written
by the fixture the pipeline installs; the others are the browser's and the runtime's words for a
connection that did not happen. A row with any such failing test is an environment fault.

**Past a threshold the run halts, and records nothing about the criteria.** When more rows are
environment faults than `policy.calibrate.environment_faults` allows, `calibrate` writes no result
set, opens no proposal and closes no owed work. It commits a run-record line saying it halted, and
exits 1 with the evidence: how many of the rows that ran were affected, what their tests said
grouped by message and counted per test, and which criteria. Nothing is committed that a later
stage would read as the application's result.

**The threshold is policy, and it is zero by default.** Every such row is meaningless as a
calibration result, so the strict reading is that one is enough. A project with a long suite and
a flaky environment may prefer to keep a run that lost one or two rows to it and re-run those
later; at or under the threshold those rows are recorded as failures, with the reset's message on
them, like any other. That trade is the project's to make, and is ruled at G-POL like any other
policy change.

**`--skip-suite` checks the rows on file the same way.** It asks the next question over the
results already on `main`. Rows a broken run wrote there are no better evidence for being old, so
it halts on them too and says to run the full calibration.

## What was considered instead

**A new result value, `environment`, recorded instead of `fail`.** Rows would be kept and kept out
of both queues. But a result file where most rows say "not measured" is not a calibration, and
every reader of `latest.json` — `verify`, the missing-test accounting, the site — would have to
learn a value that means "ignore me". Halting keeps the file an account of what the application
did.

**Leaving it to the reviewer.** The reviewer can see the reset message on each row, and the triage
grammar has no verb for it: `adapter-wrong` sends the binding back to be redone, and
`product-question` sends it to the product owner. Both are wrong, and both cost a loop.

**Matching on the exit code or the `ETIMEDOUT` text.** The reset can fail many ways — a timeout, a
refused connection, a seed error — and all of them say the same thing about the application:
nothing. The harness's own sentence is the one stable signal it gives.

## What would reverse it

Evidence that a row failed this way still says something about the application — a reset that
fails only when the application itself is misbehaving, say — would make those rows questions again.
Short of that, a target with no reset has nothing to fail and never reaches this path, and a
harness that stops the whole run on its first failed reset would make the threshold moot while
costing every row after it.

# 0008 — A calibration's failures are sorted by the reviewer before any reaches the product owner

**Status:** accepted · 2026-09-14

`calibrate` runs the acceptance suite against a real target and turns each result into a row. A
failing row was put straight to the product owner at G1, on the reading that a failure is always
about the product, the criterion or the test. The first full calibration of a real project showed
that it usually is not, and this records where that fourth kind of failure is decided, and why it is
not decided by the product owner.

## 1 — A failure can be the harness's, and that is not a product question

**Decision.** Before the product owner sees a calibration's failures, the reviewer persona sorts them
at G3, through a proposal named `calibrate-triage-<target>-<n>`. It gives each failing criterion one
of two verdicts: `adapter-wrong <ID>: <why>`, or `product-question <ID>`. Only the second kind is put
to the product owner, in the usual `calibrate-<target>-<n>` proposal, with the usual three verbs.

**Why the product owner is the wrong role.** The pipeline simulates the people a delivery team has,
and it should ask each of them only what that person would be asked. A product owner decides what the
product must do. Whether the project's own test harness read the right element off a page is a
technical question with a right answer visible in the adapter's code; no product owner would be asked
it, and a simulated one asked it anyway will either refuse or answer it in the only vocabulary it has.

The first calibration showed both. Asked to rule 40 failures, the product owner persona ruled none,
because the evidence pointed at the adapter in every case it checked: a page's name compared against
the browser tab's title, three controls reported missing that the application renders, an identifier
read as empty on a page the adapter never reached. And the two verbs that could have been stretched
to fit do harm. `defect-in-old` records the adapter's bug as the old application's, which makes it an
obligation on the rebuild. `test-wrong` sends a sound test back to be written again by an agent that
cannot see the adapter, and the new test meets the same binding and fails the same way.

**Why the reviewer.** It is the persona that already rules on adapters at G3 and reads them against
the contract; the question is squarely inside what it is asked to judge. In a delivery team this is a
developer looking at a red test run before anybody takes it to the product owner.

**What would reverse it.** Evidence that the reviewer is sending real product questions back as
adapter faults — which is visible, because every `adapter-wrong` verdict names a criterion and what
the adapter did, and the binding run it triggers either fixes that or reports it unchanged.

## 2 — Most of the harness's failures never need a verdict at all

**Decision.** A failure whose every failing test ended in the adapter's own `unbound:` error is
recorded as `unbound`, not `fail`, and reaches neither persona.

**Why this is part of the same decision.** The pipeline was always meant to work this way, and a
defect stopped it. Playwright reports a thrown `Error` with its class name in front, so the adapter's
text never started the line, and the pattern anchored to the start of the line matched nothing. Every
unbound member — 76 in one run — was recorded as a failed criterion. Sorting by a persona is for the
failures a pattern cannot recognise; the ones the adapter already says are its own do not need
anybody's judgement.

## 3 — An adapter verdict lapses when the adapter changes

**Decision.** An `adapter-wrong` verdict takes its row out of both queues and puts the criterion on
`tests/adapters/rebind.yaml`, which the next `bind-adapter` run for that target reads into its prompt.
The verdict records the adapter's tree at the time, and `calibrate` drops it — and its rebind entry —
once it runs against an adapter that has changed.

**Why it lapses rather than being cleared by the binding run.** A binding proposal that is returned has
fixed nothing, and a revise of it still needs the findings, so the binding run cannot be the one to
clear them. And kept for ever, the verdict would hold a criterion out of both queues after the fix
meant for it had landed: a fix that did not work would never be noticed, because nothing would ask
about the row again. Lapsing on a changed adapter means a row still failing after a rebind is sorted
afresh.

## 4 — Rulings can be applied without running the suite

**Decision.** `calibrate --skip-suite` applies whatever rulings have come back and asks the next
question over the rows already on file, running nothing.

**Why.** Sorting and then ruling are two rulings in a row with no change to the application between
them. On the first real project the suite takes hours, and without this every calibration would run
it twice to learn nothing new the second time.

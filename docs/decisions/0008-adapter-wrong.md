# 0008 — A calibration failure may be the adapter's, and the grammar has to be able to say so

**Status:** accepted · 2026-09-14

`calibrate` runs the acceptance suite against a real target and turns each result into a row the
product owner rules on at G1. The grammar gave three answers, on the reading that a failing row is
always about the product, the criterion, or the test. The first full calibration of a real project
found that it usually is not, and this records the fourth verb and why it is not a loophole.

## 1 — `adapter-wrong <ID>: <why>` joins the ratification vocabulary for calibration

**Decision.** A fourth verb. It changes nothing about the criterion — no restatement, no version
bump, no note — and writes `{ id, target, why }` to `tests/adapters/rebind.yaml`, which the next
`bind-adapter` run for that target reads into its prompt and clears once its own checks pass.

**Why the three that existed could not carry it.** Asked to rule 40 failures, the product owner
persona returned the proposal having ruled none, and said why: the evidence pointed at the binding
in every case it could check. The adapter read the browser tab's title where the criterion meant
the page's heading, so a test comparing a page's name met that name with the site's own appended
to it. It reported three controls missing that the old application demonstrably renders. It
answered with an empty identifier where it could not read one, so a later page reported it had
been given nothing.

None of those is the old application failing, the criterion misdescribing it, or the test being
wrong. And the two verbs that could have been stretched to fit do real harm. `defect-in-old`
writes a note saying the old target fails this and the rebuild must pass it, which turns an
adapter's bug into an obligation on the product. `test-wrong` sends the test back to be written
again, blind, by an agent that cannot see the adapter — and the new test meets the same binding
and fails the same way, having cost a derivation.

**Why it is not a way out of ruling.** The verb makes a claim that can be checked: the criterion
is right, the test is right, and the binding is not. A persona reaching for it has to say what the
adapter did wrong, and the finding goes to a stage that will either fix it or report the same
member unbound a second time with an account of what it tried. What it cannot do is make a
criterion easier to pass, because it does not touch the criterion.

**What would reverse it.** An adapter good enough that this verb is never reached is not a reason
to remove it; a verb nobody needs costs nothing. What would reverse it is evidence of the opposite
failure — personas reaching for `adapter-wrong` where the product really does differ, using it to
avoid deciding. That is visible in the record, because every use of it names a criterion and a
reason, and a rebind that finds the binding was right all along says so.

## 2 — The finding goes to the adapter, not to the spec

**Decision.** `tests/adapters/rebind.yaml` is a list beside the adapters rather than a note on the
criterion, keyed by criterion id and target, cleared by the run that acts on it.

**Why not a note on the criterion.** A criterion is the record of what the product must do. "One
target's adapter misread this in September" is not that, and a spec accumulating such notes would
make every future reader wonder whether the behaviour or the harness was at issue. The same
argument already keeps `test-wrong`'s reason out of the domain file and in `redo.yaml`.

**Why keyed by target.** An adapter exists per target: the old application's and the rebuilt one's
are different code with different faults. A finding about one says nothing about the other, and a
list that did not distinguish them would hand the old adapter's bugs to the new adapter's author.

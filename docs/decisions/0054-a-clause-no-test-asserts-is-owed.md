# 0054 · A clause no test asserts is owed, and an approval can say so

Status: accepted · 2026-09-25

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A criterion stated two things: page-body markup is never executed, and the body renders the same
wherever it is shown. Its test writer had no observation reporting whether markup took effect, so
the derived test asserted the second clause only. The reviewer saw it and approved, with a plain
condition saying the first clause was asserted by no test and stayed open until the contract
offered such an observation. The reviewer's own account of why it approved rather than returned
was that the test writer could not act on it: a criterion was either tested or recorded
untestable, never both, and `checkTests` refuses a record beside a test.

Two things then held on `main`. The criterion's missing test was owed by `calibrate`, since a test
now existed and had not run, and the first calibration to run the partial test would close it as
met. And the reviewer's condition was recorded on the gate file and nowhere else: an approval's
plain conditions are read by no stage (`0032`), so nothing would ever hand the missing observation
to the contract or ask after the clause again.

`0042` exists for exactly this criterion, and requires that nothing a ruler says is still owed can
vanish, and that a missing test closes only on a test that runs. A test that runs and asserts half
of its criterion met the letter of the second and defeated its purpose.

## Decision

**A not-testable record may name a clause.** An entry in `tests/acceptance/not-testable.yaml`
with `clause` says that part of its criterion is asserted by no test; it carries `reason`,
`missing` and `owner` as any record does and sits beside the test that asserts the rest. Every
reader that takes a record to mean "this criterion has no test" leaves such a record out: the
check that refuses a record beside a test, coverage, the suite's `not-testable` rows, and the
deletion of a test a run has newly recorded untestable. `checkTests` refuses a clause record with
no test beside it, since that criterion is untestable as a whole. The record keeps the criterion's
missing test open while it stands, owed by its owner and handed to it, exactly as a whole record
does: the item closes on a test run only once no record stands. The test writer is told in its
skill that a clause it cannot assert must be recorded this way, and removed only when its test
asserts it.

**A ruler keeps a clause owed on any ruling, approval included.** The condition form

```
missing-test <ID>: <clause> — owed by <stage>: <what is missing>
```

puts the clause on the criterion's missing-test item and moves the item to the stage named,
stamped with the ruling, or opens an item where none is open. An item carrying a clause is not
closed by any run of its test and not handed to `calibrate` or `verify` for one; it is answered
when the test writer, handed it, has a derivation approved that records nothing for the criterion,
after which the whole test is owed a run like any other. A ruler withdraws one with the line every
missing test is withdrawn with. The line is applied in the approval's merge, or on `main` in a
commit of its own for a return, and is refused on both seats before anything is written where the
criterion is not accepted or is retired, the owner is not a stage, or the owner is `derive-tests`:
a clause the writer could assert and did not is the proposal's to fix, which is a return. A
malformed line gets the agent seat's one re-prompt.

**An approval's free-text conditions stay commentary, and the ruler is told so.** The ruling prompt
says a free-text line on an approval is kept on the gate file and owed by nobody, and names the
form that records a clause. The reviewer's brief says a test asserting part of its criterion with
no clause record is grounds to return, asking for the record.

**The G3 guard does not let a partial test through.** A slice's verify result showing the test ran
lifts `block_on_missing_tests` only where the run would close the item, so not while a record names
a clause of the criterion or the item carries one.

**A recorded ruling that said it in words is settled with its form.** `sdlc rule <name> --settle`
applies the `missing-test` lines a recorded ruling carries where `main` does not hold them, and
takes `--condition` lines restating what the recorded ruling said in words of its own. Each must
name a criterion one of the ruling's plain conditions names; it is recorded under the ruling's
seat with those conditions and their text beside it (`restates`), in a pipeline commit
`record(<gate>): <name> owes missing-test/<id>'s clause to <stage>`. A line naming a criterion
the ruling did not mention is refused: that is a new ruling, made at a gate. Settling again
changes nothing.

## Alternatives

**Record an approval's plain conditions as owed conditions.** Nothing in a sentence says which
stage owes it, the approved line of work has no later ruling to close it, and the conditions check
would fail on it at once. It would also leave the missing test to close on the partial test.

**Only the ruler's form, with no clause record.** The test writer, who is the one who knows which
clause it could not assert, would still have nowhere to say so but its journal, and a reviewer
catching the gap could only approve with the form rather than have the writer record it.

**Only the clause record, written by the ruling.** A ruling writing the test writer's file puts a
record into the one file a `--revise` run overlays from the returned branch, where the revision
would drop it; and the record is the writer's statement of what its test does not assert, not the
ruler's.

**A clause-level item beside the criterion's.** Two items for one criterion's test, each closed by
different evidence, where one item open until the test covers all of it says the same.

**Refuse an approval whose plain condition says something stays open.** Reading prose for intent
is a judgement, and one a guard would make wrongly in both directions.

## What would reverse it

Clause records whose owner supplies what is missing and whose clause the next derivation still
does not assert would say the writer records clauses it could have asserted, which is the
reviewer's to catch. Rulers routinely approving with the form where the writer could have recorded
the clause would argue for refusing the form on test proposals and keeping it for other gates.

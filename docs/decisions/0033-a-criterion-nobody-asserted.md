# 0033 · A criterion nobody asserted, reported as one that passed

Status: accepted · 2026-09-21

## Context

`verify --slice <n>` sorts the criteria a slice claims into a verdict. Six values can come
back on a row, and two of them settle a criterion without the application being asked
anything at all: `not-testable`, a criterion the contract surface offers no way to exercise,
recorded with its reason by whoever derived the tests; and `attested`, a criterion somebody
vouched for in place of a test. Both were pooled with `pass` in one set of results needing no
test, which meant neither was pushed to the failing list nor to the unbound list, and the
verdict collapsed to the bare word `pass`.

**What the run then printed was a universal the rows do not support.** A slice claiming eight
criteria, six of them exercised against the running application and met, two of them recorded
not-testable with their reasons, ended with *every claimed criterion passes against the
application* and exited 0 — the same sentence and the same exit code as a slice where all
eight were exercised and met. The result file on the branch labelled both rows honestly. The
verdict, and the one line a caller reads, did not.

**That sentence is what a reviewer reads before approving a build.** A quarter of the slice's
claims were never put to the application, and nothing in the verdict, the trailer or the
ruling prompt's summary said so. The truth existed in a file on a branch somebody would have
to think to open, which is the same as it not existing.

**The asymmetry makes the gap plain.** An `unbound` verdict gets a multi-paragraph account
with the adapter's own reasons quoted one per criterion and three named exits, because a
criterion that could not be exercised is a real thing that happened and the reader has to
decide what to do about it. A criterion nobody could assert is the same kind of fact, and it
got silence and a clean pass.

**And the reason was written down exactly once and reached nobody.** A not-testable entry
carries `reason`, which is the only account anywhere of why the application was never asked.
The row the suite built from that entry dropped it, so the result file, the terminal line and
the ruling prompt each had an id and a label and no way to judge either.

This is `0019`'s family arriving at the last step instead of an early one: a run that
reported something other than what happened. `0012`, `0017`, `0019` and `0027` are each a run
that did not do its job saying otherwise. This one did its job — the suite ran, the rows are
right — and reported a result it never established as one that succeeded.

## Decision

### A slice that was not wholly asserted has a verdict of its own

`pass-unasserted`: nothing the slice claims failed, and at least one criterion was never put
to the application. It sits between `pass` and `unbound` in precedence — a failure still
decides the verdict, and so does a criterion the adapter could not bind.

A fourth verdict rather than a qualifier hanging off `pass`, because every reader of this
result keys off the verdict word: the guard that decides whether an approval may be given,
the meaning line at the top of the ruling prompt, the commit message on the branch, the run
record's one line. A qualifier a reader has to remember to look for is one that will be
missed, and the whole defect is a reader being told `pass` and stopping there.

The result file carries `unasserted` beside the verdict — one `{ id, result, reason }` per
criterion nobody asserted — so a reader deciding what the verdict means does not have to
re-derive it by sorting the rows.

### Nothing about what may be ruled moves

`buildVerified` accepts both passing verdicts, so a slice that could be ruled at G3 before
this can be ruled at G3 now. Whether a build may be approved with a criterion nobody asserted
is a policy question with a seat that exists to answer it, and answering it here would settle
it in the machinery where nobody chose it and nobody can see it.

The exit code does not move either. `0019` reserves a non-zero exit for a run that finished
correctly and found that the thing it was asked about did not pass, and routes it through
`notPassed`; this route leaves that unset. A qualified pass that exited non-zero would stop
every wrapper and every CI step in front of the gate — the policy decision again, taken in
the one place it would never be read as a decision.

### The universal is printed only where it is true

*Every claimed criterion passes against the application* survives unchanged on the one route
it is true of. A qualified pass prints how many of the slice's claimed criteria were asserted
and met, names the ones that were not, quotes the reason each carries, and says that the
slice is ready for G3 on the strength of what was asserted and that the rest is the ruling's
to decide. The count and the ids are in the first line, which is the line the run record
keeps and the line a caller reads.

### The reason is carried on the row

A not-testable entry's `reason` goes onto the row the suite builds from it, so it reaches the
result file, the terminal, and the section the ruler is shown, by the routes each already
uses. The alternative is three readers each opening the project's own yaml, one of which
reads a branch it has not checked out.

### The ruling prompt separates three groups, not two

A criterion that was exercised and came out wrong, and a criterion nobody asserted, are
different questions for a ruler, and a single "did not pass" count answers neither. The
verify section counts and lists them apart, gives each unasserted criterion its recorded
reason, and closes by saying plainly that nothing in the pipeline decides whether the slice
can be accepted on that footing. They are listed on every verdict, since a slice can fail on
one criterion and carry another nobody asserted, and the second is invisible in a list of
failures.

### `attested` is handled with `not-testable`, and nothing writes one today

`attested` is a criterion result, and it is not `tests/acceptance/attestations.yaml`, which
is about the provenance of a test file and is read by `checks` alone. No stage writes an
`attested` row: it is a value the vocabulary holds and no producer fills. That is precisely
why leaving it pooled with `pass` was worse than the row that exposed it — the day something
writes one, it would be laundered in silence, with no failing test anywhere to notice. What
is true of it whenever it appears is that a person's word stands in for an assertion against
the application, so it is counted, named and reasoned about exactly as `not-testable` is.

### One list of what a row's result can be

`src/testrun/results.mjs` holds the six values and the two that assert nothing, and the
suite, the verify stage, the ruling prompt and the state site all read it from there. The
results page had been counting five of them, so a row in the sixth was counted in no column
and its own page's arithmetic came up short — the same shape as the defect above, one step
further out.

## Consequences

- A slice that is partly unassertable says so in the terminal, in the verdict on its branch,
  and in the section the ruler reads before approving a build.
- A reviewer approving a build with an unasserted criterion is doing it knowingly, and the
  reason is in front of them. The decision is still theirs.
- The run record's line for such a slice carries the count and the ids, so the history of a
  project says which slices were accepted on partial evidence.
- A caller that keys on the verdict word sees a value it has not seen before. That is the
  intended change: it was being told `pass` about a result nobody established.

## What was considered instead

**A count or a flag alongside a `pass` verdict.** Every existing reader goes on reading
`pass` and behaving exactly as it did, and the new field is read by whoever remembers it
exists. The failure mode is the one being fixed.

**Refusing the gate until every criterion is asserted.** It is a defensible policy and it is
not this change's to make. It would also make the pipeline unusable on any project with a
criterion the contract surface genuinely cannot reach, which is what the not-testable record
exists to represent, and it would arrive as a refusal nobody debated.

**Setting `notPassed`, so the run exits non-zero.** The run did what it was asked and the
slice may go to its gate; `0019` gives that field a specific meaning and this is not it. A
non-zero exit would stop the sequence in front of the gate, which is the policy question
above, decided in the layer with the least visibility.

**Having the ruling prompt read `not-testable.yaml` for itself.** It puts a reader of a
branch in the business of resolving the project's own files, and it answers only for
`not-testable` — an `attested` row has no such file to read. The row is what every reader
already has.

**Removing `attested` from the vocabulary as a value nothing writes.** It is named in the
brief that tells a reviewer what a result can say and in the row vocabulary every reader
shares. Deleting a value to avoid deciding what it means leaves the next writer of one to
decide it by accident.

# 0019 · A run that did not pass says so, and says which way

Status: accepted · 2026-09-20

## Context

`sdlc run verify --slice <n>` runs a slice's acceptance suite against the application its
open build proposal carries and records a verdict: `pass`, `fail`, or `unbound`. It is a
deterministic stage (`agent: false`), so `runStage` calls its `execute` directly and hands
whatever comes back to `finishDeterministicNoOp`, which commits anything dirty and returns
`ok: true`. `COMMANDS.run` then prints `run verify: ok` and exits 0.

**It prints that over every verdict.** A run that returned the slice to the builder, a run
that escalated it to a person after three failures, and a run that could not exercise three
of eight criteria at all each ended with the same trailer and the same exit code as a slice
that passed. The verdict itself was written correctly to the result file and to the gate
file every time; it simply never reached the one line a caller reads. A script, a CI step
and a person scanning the last line of the output all take `ok` and 0 for what they say.

This is the third instance of the same defect. `rule --pending` exited 0 while holding a
proposal branch open with proposals it had not ruled (0012). `verify` returned normally
when the sandbox never started, printing `ok` over a verification that had not happened
(0017). Each was fixed where it was found, and the shape underneath — a run that did not do
its job reporting something other than failure — was not named.

**And the remedy printed for `unbound` was the remedy for a different cause.** An unbound
row means a criterion could not be exercised, and there are two reasons for that. The
target may have no adapter yet, in which case nothing on it can be driven and the whole
binding sequence is what is needed. Or the adapter may be in place, have driven the
application, and reported that the control or the observation the criterion needs is not
there — which is what `bind-adapter` is asked to report and what it writes as `unbound:
<page>.<member> — <reason>`.

Only the first was ever printed. Against the second it asks for a sandbox, an adapter run
and a G3 ruling — half an hour — to drive the same application again and write the same
reasons back. It cannot come out differently, because nothing between the two runs changes
the application, and the reasons the adapter already wrote are the evidence for that.

## Decision

### A stage says when its run finished correctly and the thing it was asked about did not

`execute` may return `notPassed`, a short line naming the outcome. `runStage` carries it out
unchanged, and `COMMANDS.run` prints it in place of the `ok` trailer and exits non-zero. It
changes nothing a stage writes: the result file, the gate file and the three-strikes count
are settled before it is set, and a stage that leaves it unset is reported exactly as
before.

It is set by three of verify's four routes out, and the three read differently on purpose:

- `returned — <n> of <m> criteria fail against the application`
- `unbound — <n> of <m> criteria could not be exercised at all`
- `escalated to <role> — <n> of <m> criteria still fail after <k> builds`

A criterion that was exercised and came out wrong, a criterion that could not be exercised,
and a slice whose third failure now belongs to a person are three different things to do
next, and a single word for all of them puts the reader back in the output looking for
which one it was. The sandbox routes set it too, naming the sandbox rather than the
criteria, for the same reason.

The field is on the stage rather than in the runner because the runner cannot know. What
counts as a verdict is the stage's own vocabulary: `calibrate` measures a target and asks a
question about what it found, `ratify` mints what it can and opens a proposal for the rest,
and neither is pronouncing on whether something passed. Verify is the one stage today whose
answer is a verdict about the application, so it is the one stage that sets this.

### The unbound remedy is chosen by whether an adapter exists, not by what the reason says

`tests/adapters/<target>/index.ts` either exists or it does not, and that is the whole
discriminator. It is a fact about the project rather than a sentence to match — the same
reason 0017 reads container state instead of compose's error text. A target with no adapter
is reported unbound through a reason the suite writes on its behalf; a target whose adapter
ran and found nothing to bind is reported unbound through a reason the adapter wrote. The
two are indistinguishable in the text and never in the filesystem.

With no adapter, the binding sequence is printed as before, branch name filled in, ending
with the verify that picks the ruled adapter up (0016).

With an adapter in place, the adapter's own reasons are quoted, one per unbound criterion,
because they are the evidence and nothing else in the pipeline writes them down. What
follows them says that binding again would drive the same application and write the same
reasons, and that what is missing is in the application. The move is a person's and it is
one of two: rule the proposal at G3 with those reasons as the conditions, which returns it
and lets `build --slice <n> --revise` take them on; or, where that surface belongs to a
later slice, change what this slice claims in `plan/tasks.md` so its criteria match what it
builds. The output also says that nothing was written to the gate file, because nothing
about the application was tested and there is no verdict on it to record.

## Consequences

`sdlc run verify` exits 0 on exactly one outcome, and a caller that checks the exit code
gets the answer it was asking for. A wrapper that treated any verify run as success will
now stop on a returned or unbound slice, which is the intended change.

The verdict still reaches the gate file and the result file by the routes it always did,
and `buildVerified` reads the same files it always read. Nothing about which proposals may
be ruled has moved.

An unbound slice whose adapter is in place now ends with a question for a person rather
than a command to run. That is the honest shape of it: the pipeline has established what
the application does not do, and what to do about that is a scoping decision no stage owns.

## What was considered instead

**Returning `ok: false` from the stage.** `COMMANDS.run` already exits 1 and prints the
messages for that, and it would read as the run having gone wrong — the shape reserved for
a failed pre-check, a failed agent turn, a post-check that did not pass. This run went
exactly right. Collapsing the two loses the distinction the operator needs most: whether to
look at the pipeline or at the application.

**Deciding the trailer in the runner from the result file.** It would work for verify and
only for verify, and it puts the runner in the business of reading one stage's output
format. A stage that later grows a verdict of its own would have to teach the runner about
its files.

**Matching the unbound reason text for `does not exist`.** The message `runSuite` writes for
a missing adapter is not a contract, and a check that reads it turns one into a contract.
The file it names is the fact.

**Keeping the binding sequence and adding a note to ignore it when the adapter is present.**
Printed instructions are read as instructions. The reader who follows them loses half an
hour and ends where they started.

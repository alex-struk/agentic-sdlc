# 0074 · A loop that stops at a person

Status: accepted · 2026-09-29

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

`0042` put the choice of what runs next in the record, and `0045` said how `next` reads it. It
also fixed the order of what came after: printing the next command first; "a loop that runs it
and stops at a person, a failure or a dead end" once printing had run cleanly; restarting that
loop from a person's ruling once people hold seats.

Printing is built: every `sdlc run` and every `sdlc rule` ends with the next command, and a run
of anything else needs a recorded reason. The operator's remaining job between steps is to copy
it into the terminal, notice when it is the same command again, and notice when the agent CLI's
sign-in has lapsed or the oracle has not come up. Each of those is a judgement the record or the
step's own output could settle, and each is taken where it leaves no trace: a run that stopped
because the operator saw it going round in circles looks, afterwards, exactly like a run that
stopped because the operator went home.

## Decision

**`sdlc drive` runs what `next` names until it has to stop, and records why it stopped.** Each turn
reads `next` in-process from `main`, runs the command when it is a stage run or a ruling at a seat
an agent holds, and reads `next` again. It chooses nothing: the order is `next`'s, and a step is
never a deviation.

**A stage or ruling runs through the function its command runs.** A stage run goes through
`runStage` and the same reporting `sdlc run` prints; an agent's ruling through `ruleByAgent` and
the same reporting `sdlc rule` prints. There is no second copy of either, so a check added to a
stage or a ruling holds for the loop the moment it holds for a person typing the command. The
step runs in-process, which is what lets the loop tell a run that failed from a run that recorded
an outcome that did not pass (a verify that returned a build), where the command's exit code is 1
for both.

**It never runs a person's ruling.** A seat a person holds is a stop, even when `next` names the
command a person would type. The loop has no verdict to give for a person, and one it gave would
be a ruling recorded under a seat nobody at that seat made (`docs/decisions/0003`).

**Every stop has a reason, a line on the record and its own exit code.** Nothing left (0), waiting
on a person (3), a failure with no recovery (1), refused to start (2), an expired sign-in (5), no
progress (6), the step limit (7). A script tells them apart without reading the text, and a
person reading the run record afterwards sees why the loop ended where it did.

**No progress is judged from the record, not from the command.** Before each step the loop takes
a mark: `main`'s tree and every proposal and returned branch's tree, each without the account every
run writes about itself (run records, journal entries, the site, calibration result files); each
target's latest calibration as counts of result and ruling; and `next`'s `why`. When `next` names a
command that has run before and the mark equals the one taken before that command last ran,
nothing that command could change has changed, and running it again would reach the same place.
Comparing `main`'s commit alone would see progress in every run, because every run commits its own
run-record line; comparing the command alone would stop a loop that is making progress through the
same stage, as a `derive-tests --stale` run does domain by domain.

**One recovery, bounded to one attempt per step: an oracle that is not up.** A step that says the
oracle is not up is answered by `oracle up` and run once more. `oracle up`'s build, migrate and
start calls stop at `oracle.up_minutes` (30 by default), so one that hangs — a migration one-off
stuck in its package install is the case seen — fails instead of holding the loop; the oracle is
then taken down and brought up once more. A calibration that halted because the oracle was up and
unusable is answered by taking it down first. Anything else a step fails on is a stop: a recovery
the loop guessed at would be a decision nobody could see being taken.

**An expired sign-in is a stop, never a retry.** It is read from the executor's own account of it
(`authFailureReported`), not from any text that mentions signing in. Every later step would fail
the same way after spending a sign-in check, and only a person can sign in.

**A step's line rides in the step's own commit; a stop is committed on its own.** A step's line
waits in the ignored pending record and is written by the step's own commit ahead of its line,
the way a command a stage runs is recorded. A stop is committed by the pipeline on `main` from a
clean tree, and otherwise waits for the next pipeline commit, so the loop never sweeps up work
that is not its own and never leaves the tree dirty.

**The heartbeat is a local file, not the record.** `.sdlc/drive.local.yaml` says what the loop is
doing and since when, and `sdlc drive --status` reads it. It is ignored like every `.local.yaml`.
The alternative, a line in `sdlc status`, would put a timestamp into the state site, which is a
pure function of the record, and `sdlc status` rewrites tracked files, so reading the heartbeat
that way would dirty the tree under the loop being watched.

## Alternatives

**An external operator script around `sdlc next` and `sdlc run`.** It needs nothing from the
pipeline and was the quickest way to stop typing commands. It is untested, so its stop conditions
are whatever it happened to be written to notice. Its stops leave no record, so why a run of it
ended is known only to whoever was watching. And it makes the operator's seat depend on one
person's tooling: the pipeline promises that the seat is replaceable, and a loop that lives
outside the repository is a seat only its author can sit in.

**Shell out to `sdlc run` and `sdlc rule` for each step.** The same code path, with the output
kept whole and a crash contained in the child. It loses the one thing the loop needs from a step
beyond its exit code — whether a non-zero exit is a failure or a recorded outcome that did not
pass — and would have to recover it by matching the step's printed words.

**Stop when `main`'s commit has not moved.** Simple and wrong in both directions: every run moves
it with its own run-record line, and a calibration re-run that measured the same outcome writes
new result files.

**Retry a failed step a fixed number of times.** Most failures a step reports are its post-checks
or its agent's turn, which fail the same way again at the same cost. Retrying is right only where
the cause is known and something else fixes it, which is the oracle and nothing yet besides.

## What would reverse it

Recorded stops that routinely say "failed" for a cause a person then fixes the same way each time
are evidence for a second recovery, named and bounded like the first. No-progress stops on runs
that did move the project are evidence that the mark leaves out something a step changes. A
project whose people hold seats and want the loop restarted by their rulings is the level-3 work
`0042` names, and does not change this.

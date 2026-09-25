# 0057 · A proposal set aside without an answer

Status: accepted · 2026-09-25

## Context

A proposal leaves the open state one way: somebody rules it. Approve, return and escalate are
each an answer to its question, and each has consequences the pipeline carries out. An approval
merges and makes its conditions owed. A return sends the proposal's stage back to revise, and a
calibration return records a verdict per criterion. An escalation hands the question to another
seat.

Some proposals should not be answered at all. A calibration whose target could not be reset
opened a triage proposal asking the reviewer to sort 211 failures, almost all of which the machine
had caused (`docs/decisions/0056-a-calibration-that-measured-the-machine.md`). Any sorting of those
rows would be a verdict about the adapter or the product that nothing supports. An approval with
no conditions would still be read as the reviewer having looked. A return would send the stage
back to redo work it had done correctly. Leaving it open blocks the family: a stage that opens
numbered proposals waits for the open one to be ruled before it opens the next, so no fresh
calibration question could be asked. Two places in the pipeline already tell an operator to
withdraw a proposal — the refusal of a policy change at the wrong gate, and a stalled escalation
— and no command did it.

## Decision

**`sdlc withdraw <proposal> --by <seat> --reason "<why>"` closes an open proposal with verdict
`withdrawn`.** It writes a gate file with that verdict, the seat, the reason and the time. The
file is committed on the proposal's branch, which is where every reader that asks "is this still
open?" looks, and on `main`, where the proposal's number stays taken and the state site lists it.
Both commits are the pipeline's own, and the run record carries the line.

**`withdrawn` is a fourth verdict that no reader acts on.** Every reader compares a verdict with
the specific value it acts on (`approve`, `return`, `escalated`), so a fourth value is treated as
ruled and does nothing else. It merges nothing, owes nothing, sends no stage back and waits on
nobody. The one change it makes is that the proposal is no longer open.

**A withdrawal needs a reason and a seat that could have ruled.** The seats are the gate's holder
and its escalation target, read from the policy on the proposal's branch, the same as a ruling.
A person types the role and an agent passes `agent:<persona>`. The check is the same for both,
because a power given to one seat only is the one `CLAUDE.md` rules out. The reason is required
because a proposal that closes with nothing on record looks the same as one that was lost.

**Only an open proposal can be withdrawn.** An approved or returned one already has an answer,
and withdrawing it would contradict the record rather than complete it. An escalated one is still
open, since a person owes the answer, and can be withdrawn.

## What was considered instead

**Deleting the branch.** Nothing would be recorded, the proposal's number would be free to be
reused by the next of its family, and there would be no trace that a question was ever asked.

**Moving the branch out of `proposal/`, as a revision moves a returned one to `returned/`.** The
readers that enumerate `proposal/*` would stop seeing it. But the family's numbering reads branches
as well as gate files, and a proposal with no gate file on `main` would give its number back. It
also records nothing about who set it aside or why.

**A ruling verb.** Adding `withdraw` beside approve and return in `sdlc rule` would put it into
the persona's grammar too, and a persona asked to rule a proposal would then be offered a way not
to. A withdrawal is a decision about whether the question stands, which is a different decision
from answering it. It belongs to whoever is running the pipeline, from either seat, and not in a
ruling prompt.

## What would reverse it

A proposal family whose next run could safely replace an open proposal by itself would not need a
person to set the old one aside. The stage would still need to record that it did so, and that
record is this one.

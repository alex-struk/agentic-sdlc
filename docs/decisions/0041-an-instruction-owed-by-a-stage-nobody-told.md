# 0041 · An instruction owed by a stage nobody told

Status: accepted · 2026-09-24

## Context

A plain condition on a return is filed on `main` in `.sdlc/conditions.yaml` and stays open
until a later ruling writes `condition-met <ref>` or `condition-withdrawn <ref>` about it
(`0032`). Two readers were built for the open list. The ruler of every later proposal is shown
it under **Instructions an earlier ruling left owed**, read from `main`. And `sdlc checks` fails
once a proposal in the same line of work is approved past one nobody accounted for.

The third party to the instruction is the stage that has to carry it out, and it was shown
none of them. A `--revise` run reads one returned ruling — the newest in its line of work —
and its prompt carries that ruling's rationale and that ruling's conditions. A condition from
an earlier return in the same line of work is on nobody's list but the ruler's.

**The stage is judged against a list it is not given.** The sequence is ordinary, not a corner:
a return attaches a condition; the revision answers part of it; the next ruler, shown the
condition as owed and seeing it unmet, returns again for something else and leaves it open.
The revision after that is handed the newest ruling alone. The stage never reads the earlier
condition, cannot meet it except by accident, and its next ruler is shown it as owed once more.
Each return is correct on the evidence in front of it, and the line of work does not converge,
because the instruction holding it open reaches the one seat that judges it and not the one that
could satisfy it.

`0032` kept conditions out of the revision-request ledger so that a `--revise` run would never
*start* from one: a condition is a question about work already asked for, not a reason to run
a stage. That remains right. It never followed that a run which has started, from a return in
the same line of work, should not be told what that line of work still owes.

## Decision

### A revision from a return carries what its line of work still owes

Every stage whose `--revise` run starts from a returned ruling hands the stage, beside that
ruling's own conditions, every condition still open for the same line of work. Each is quoted
by its reference and in its ruler's words, with the seat that attached it and the proposal and
gate it was ruled on. The paragraph says plainly that the ruling which reads this revision will
be shown each one as owed and will expect it met or accounted for, and asks the stage to meet
each one or name, in its journal entry and by its reference, any it cannot.

It is assembled once, in `src/stages/proposals.mjs` (`withOwedConditions` on the revision a
stage's revision source builds, `owedConditionsNote` in its prompt), and every revise prompt
carries it. Archaeology's never has anything to show, since a G1 ruling's conditions are a
closed grammar the ledger does not file, and it carries the call so that stays a fact about the
ledger rather than about the prompt. A stage added later reaches it through the same two calls.

### The same list the ruler is shown

The open set is read from `main` through `openConditionsOnMain`, the function the ruling
prompt and the ruling guard already read. A revision works on a checkout, and a copy of the
ledger anywhere but `main` is whatever had been filed when that copy was made; a stage shown a
different list from its ruler is the defect again, one step removed.

### The line of work is the one the ledger records

Every ledger row carries the family its ruling computed with `proposalFamily` when it was
filed, and a row belongs to this revision where that family matches the revision's own. The
revision's family is given by the caller, because naming it takes the stage registry, which a
stage module cannot import: the registry's revision sources pass `proposalFamily(name)`, and
`build` passes `buildProposalBase(slice)`, the stem every proposal for that slice is numbered
from and therefore the same string. One slice's conditions are never another's —
`build-slice-1` and `build-slice-12` are two lines of work.

### The returning ruling's own conditions are listed once

A return's plain conditions are filed to the ledger when it is ruled, so they are open on `main`
when its revision runs. They are already listed as what the revision must now do, and rows
filed from the returning proposal itself are left out of the owed paragraph rather than shown
twice under two framings.

### Nothing owed, nothing added

Where the line of work owes nothing else, the prompt is exactly what it was. A revision opened
by revision requests rather than a return has no line of work in the ledger's sense and is not
given the paragraph.

## Consequences

- A condition that outlives the ruling that attached it reaches the stage on every revision in
  its line of work until a ruler closes it, and the stage is asked to account for it by the same
  reference the ruler closes it with.
- A revise prompt grows by one paragraph per line of work with something still owed, and by
  nothing otherwise.
- The stage says what it could not meet in its journal, which the ruler reads; closing the
  condition remains the ruler's, on either seat, with the same two lines as before.

## What was considered instead

**Carrying the owed conditions as a revision source.** It would make a stage runnable by a
condition alone, which is the thing `0032` ruled out: a condition is a question about work
already asked for, and whether it was met is a ruling, not a run.

**Appending the paragraph in the runner, beside the workspace scope note.** It reaches every
stage without touching any prompt. It also sits after everything the stage was told about the
revision, away from the conditions it belongs beside, and a stage's prompt read on its own —
in a test, or in a repair turn — would not show it.

**Folding the owed conditions into the returning ruling's list.** One list reads more simply
and loses who asked for each and when, which is what tells the stage why a condition it has not
seen before is being put to it.

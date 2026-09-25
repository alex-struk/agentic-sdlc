# 0045 · What runs next is read from `main`, and running something else is recorded

Status: accepted · 2026-09-24

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

`0042` decided that the next stage is read from the record rather than chosen by the operator,
that `next` only reads, that running something else is allowed with a recorded reason, and that a
change to a record file outside a pipeline commit is flagged, warning or failing by policy. It left
open what `next` reads, how it chooses when several things are ready, what counts as running
something else, and which history the flag reads. Each is a choice a later reader would otherwise
have to reverse-engineer from `src/runner/next.mjs` and `src/checks/hand-edits.mjs`.

## Decision

**The record is `main`, read through git objects.** `next` reads the gate files, proposal and
returned branches, owed-work lists, criteria index, domain files, spec headers, calibration
results and plan out of the `main` commit with `git show`, `cat-file`, `ls-tree` and `grep`. It
never checks anything out and never reads the working tree. A run ends on `main` and a return
ends on the proposal branch; reading git objects gives both the same answer, and a read that
needed a checkout would be a write to the working tree. A test asserts that `HEAD`, the checked-out
branch, every ref and the working tree's status are the same after `next` as before, including
with another branch checked out and uncommitted files present.

**Open means what the rest of the pipeline means by it.** A proposal is open when no gate file for
it exists on its branch or on `main` (`openProposalOn`), escalated or returned when its branch
carries that verdict and `main` does not hold the same file. A proposal is passed over when a later
proposal in its line of work exists, numbered by `proposalFamily` or, for a proposal no stage
opens, by a trailing `-<n>` or `-v<n>`: what it asked has been asked again, and a stale return or
a dead end replaced by a later ruling is not work.

**Phase exit criteria are closed by the record.** Each step of the sequence is closed by an
approval in its line of work on `main`, except two that are closed by their output: `ratify` by
the criteria index (accepted rows for the domain, none still provisional, every criterion in the
domain file indexed) and `calibrate` by the latest results (every row passing or ruled), because
neither holds a gate of its own. A step is offered only when every earlier phase is closed. That
is the design's phase order taken literally: a project that has moved on to building with
calibration still unclean is told to finish calibration first, and deciding otherwise is a
deviation with a reason.

**Three kinds of ready work; the record orders within a kind, policy orders the kinds.** Within
open proposals the oldest is first, which is the order `rule --pending` rules them in. Within owed
work the upstream stage is first, because downstream work reads what upstream produces, then the
project's domain order. Within the sequence the phase order decides. Between kinds the record says
nothing: a proposal waiting at an agent's seat, a test owed to `derive-tests` and the next slice
are all ready, and which goes first is a project's preference, so it is `policy.next.order`. The
default, `proposals, owed, sequence`, settles what is in flight before starting anything and pays
what is owed before moving on, which is the order in which nothing is started on top of work that
may change under it.

**Who waits is never offered.** A proposal at a person's seat, an escalation to a person and an
escalation that reached the role that raised it (`0039`) are listed with who they wait on and the
command that person types. When nothing else is ready, `next` exits 3; when nothing at all is
left, 4; when something can run, 0.

**A deviation is any run other than the one named.** A `sdlc run` matches when its stage and
`--stale`/`--revise` are the ones `next` named and so is each of `--domain`, `--target` and
`--slice` that `next` named. Anything else, including any run while `next` names a ruling or
nothing, is a deviation. Without `--reason` it is refused before anything is written. With one,
the run record gains `deviation: next named <command>; ran <command>; reason: <reason>` in a
commit of its own, made before the run starts so it is on file whatever the run then does. The
line passes through the run record's redaction. A dry run writes nothing and needs no reason.

**The hand-edit check reads commits from the day it exists.** It reads commits on the checked-out
branch made on or after `HAND_EDITS_SINCE`, skipping merges, and flags any not authored as
`SDLC_AUTHOR` that changes an owed-work list, a gate file or `.sdlc/lock.json`. Findings name the
commit and files, not the author. Warning is the default (`policy.checks.hand_edits`).

## Alternatives

**Read the working tree.** Every existing helper that answers "is this stage done" reads the
working tree, and reusing them would have been shorter. It would give a different answer on a
proposal branch than on `main`, and on a dirty tree than a clean one, which is the opposite of
what a record is for.

**Order everything by the pipeline's stage order alone.** One rule, no policy. It puts every owed
item and every proposal behind the earliest incomplete step of the sequence or ahead of it by
accident of which stage owns it, and it cannot express "finish what is in flight first", which is
what most projects want.

**A per-kind priority number in policy.** More expressive than an ordered list and no more useful
with three kinds.

**Count a run as matching when it is anywhere in the ready list.** More permissive, and it makes
the choice between ready things the operator's again, which is what `next` exists to take away.

**A window of the last N commits for the hand-edit check.** A finding would age out of the window
without anyone acting on it, so a failing check would start passing on its own. A window from the
day the check exists never forgets a finding and never reports history written before anyone
could have known it would be read.

**Recognise `sdlc init`'s own commit to `.sdlc/lock.json`.** `init` leaves the commit to the
project's owner, so its output and an edit by hand are the same kind of commit. Telling them apart
would need `init` to commit as the pipeline, which is a change to what `init` does.

## What would reverse it

Recorded deviations that routinely say the same thing — the operator running the sequence ahead of
owed work, say — are evidence that a project's `policy.next.order` is wrong for it, and a pattern
across projects is evidence the default is. Deviations that name a step as not really closed are
evidence against that step's exit rule. A project in which the hand-edit check's findings are
mostly `sdlc init` upgrades argues for `init` committing its own output as the pipeline.

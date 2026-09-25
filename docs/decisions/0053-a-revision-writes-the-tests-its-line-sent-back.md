# 0053 · A revision writes the tests its line of work sent back

Status: accepted · 2026-09-25

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A `derive-tests --stale` run was returned at G3 with three conditions: a `test-overreaches` line on
one criterion it had not derived, a plain condition on one it had, and an `addressed-to contract`
request. The `test-overreaches` line filed a redo entry on `main` (`0021`), which a `--stale` run
takes up. Once the request was answered, `sdlc next` named `derive-tests --revise`, because a
returned proposal is revised, and its `--stale` offer for the domain is withheld while the domain's
test proposal is in flight (`0045`).

The revision was handed the plain condition and nothing else. `returnedRulingOn` splits a ruling's
conditions by addressee (`0024` §3), and a `test-overreaches` line is addressed to `derive-tests`,
so the revision's prompt listed it among the conditions "addressed to another stage", told the
writer to leave it alone, and `derive-tests-revise-drift` would have refused a change to that
test's file had the writer made one. The revision fixed the plain condition, left the over-reaching
test as it was, and was returned with the same `test-overreaches` line. The entry was already open,
so nothing new was filed, and `next` named `--revise` again. Nothing in that loop could end it: the
run that takes redo entries was never offered, and the run that was offered was never handed them.

## Decision

**A `derive-tests --revise` run takes up the redo entries its own line of work's rulings filed.**
The line is read back from the returned proposal the way an approval reads it (`revisionLine`,
`0051`), oldest first. An entry is handed to the revision when it is open on `main`, belongs to the
domain, and its criterion was named by a `test-overreaches` line on a ruling in the line more
recently than any run in the line derived it again, where a run derived an entry when its branch
closes one that was open where the branch was cut. The rest of the revision proceeds as it did.

Each taken entry is given to the writer as `0021` §2 requires: the criterion's statement and
version, the ruler's reason verbatim, the header a derivation writes, and the instruction to write
the test from its criterion rather than edit the returned branch's file. The `test-overreaches`
lines the revision answers are not listed as another stage's work, the drift check exempts their
files, the loop limit counts them (`policy.loops.redo`), and the run closes them on its branch as a
`--stale` run does. The approval that merges a revision brings the closure onto `main`, and one
that approves a later revision closes it through the line (`0051`).

**Entries filed by rulings outside the line are not taken.** A `test-wrong` from calibration, or a
`test-overreaches` on a build proposal's return, asks for a test the returned proposal was never
judged on, and stays with the `--stale` run `next` offers once the line is no longer in flight.

## Alternatives

**`next` names the `--stale` run first, then the revision.** The re-derivation and the revision
would each open a proposal for the same domain's tests, both at G3, and the revision would be cut
from a `main` that does not yet hold the re-derived test unless the `--stale` proposal were ruled
and approved in between. Two proposals for one line of work, and a revision whose drift baseline
is the returned branch rather than the approved re-derivation, is two more rulings to close one
condition, and `0051`'s reading of a line would have to take in a proposal that is not in it.

**Keep the `test-overreaches` line among the revision's own conditions.** The writer would be
handed the reason as a condition and could edit the test to answer it, but would be editing the
test the ruling said reached past its criterion, and the redo entry would stay open with nothing
to close it, so `next` would offer `--stale` for it again once the line was approved.

**Take every open redo entry for the domain.** A revision would then derive again tests nobody on
its line of work asked about, and its reviewer would be judging work the return did not send.

## What would reverse it

A reviewer routinely returning a revision on a test it re-derived, with the re-derivation reaching
past the criterion in a new way each time, would say the blind re-derivation belongs in a proposal
of its own after all, ruled on that question alone.

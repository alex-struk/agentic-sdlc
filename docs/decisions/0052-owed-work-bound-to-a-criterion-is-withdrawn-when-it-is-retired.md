# 0052 · Owed work bound to a criterion is withdrawn when the criterion is retired

Status: accepted · 2026-09-25

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

`0048` decided that a missing test for a criterion another has superseded, or one made obsolete,
is owed no test — `derive-tests` derives neither — and withdrew it, stamped by the runner, on the
same occasions an approval settles what its run was handed. Other kinds bound to a criterion carry
the same defect and none of them were fixed: a redo entry (`0051`) asks the same writer to derive
a test for the same excluded criterion, and nothing ever closed it. A project met this on one
domain's `--stale` line of work: the criterion an entry named had been superseded before the run
that took the list up, so the run correctly derived nothing for it, the entry stayed open on
`main` through every approval since, and `sdlc next` kept naming the same `derive-tests --stale`
run for it, which would derive nothing for it again.

## Decision

**A criterion's retirement is read once, and given to any kind bound to one.** `retired` and
`retiredWhy` (`src/spec/missing-tests.mjs`) are the one definition of "no test is derived for this
any more" — superseded by another, which carries what it asked, or made obsolete — and the one
wording for why. Every caller that withdraws a criterion-bound owed item reads a criterion's
retirement through them, rather than each kind re-deriving what counts.

**Withdrawing is generic; knowing what a criterion is, is not.** `withdrawRetired(projectDir,
kind, retired, reason)` (`src/spec/owed.mjs`) closes every open entry of a kind whose item
`retired` accepts, as withdrawn, stamped by the runner, with the reason `reason` gives. The
module that keeps owed work stays ignorant of what a criterion is — `retired` and `reason` are
the caller's — so the same call is safe for a kind whose item is never a criterion at all: a
rebind's item names an adapter member, and matches nothing.

**A redo entry is withdrawn on the same occasions a missing test is.** An approval's own merge,
and `rule --settle` for one already on `main`, each close what the approved line of work answered
(`0051`) and then withdraw, by criterion, whatever is left open — the same two moments
`syncMissingTests` already runs at. An entry closed as met by the same commit is not reopened as
withdrawn; only what is still open by the time retirement is checked is touched.

**`sdlc next` never names a stage for one, whether or not the withdrawal has been committed yet.**
A retired criterion's redo entry is still counted as owed — it is real, unanswered work, until
something closes it — but it is left out of the runnable commands `next` groups owed work into,
the same way a criterion's retirement already keeps `acceptedCriteria` from ever handing the entry
to a run. This holds from the moment ratification retires the criterion, not from the moment a
later pipeline commit gets around to writing the withdrawal down, so the loop cannot open even in
the gap between the two.

## Alternatives

**Teach `derive-tests --stale` to close a redo entry it was handed but excluded.** The run already
knows, at `resolveCriteriaToDerive`, that a criterion in its redo list is retired — it is the same
exclusion `acceptedCriteria` applies. Closing it there needs the run to write a kind of entry it
does not otherwise touch (a withdrawal is a runner stamp, not the run's own account), and does
nothing for an entry that retires after the run that would have taken it up already finished,
which is exactly what happened here: the closing has to happen at the same read-and-reconcile
moments every other retirement is caught at, not inside the run.

**One withdrawal function per kind, as `syncMissingTests` has for missing tests.** Correct, and a
third copy of the same predicate and the same sentence the moment a third kind needs it. Reading
retirement once and handing it to a generic closer keeps the definition singular while leaving
each kind's own bookkeeping — what a redo entry stores beside `item`, what a rebind's item even
means — exactly where `0044` put it.

## What would reverse it

A kind whose "retired" is not a criterion's `supersededBy` or `obsolete` state at all — a rebind
answering an adapter's own retirement, say — would need its own predicate passed to
`withdrawRetired` rather than reusing `retired`; the function already takes one as an argument for
exactly this reason. A project where `sdlc next` counting a retired criterion's redo entry as
owed, with nothing runnable behind it, reads as confusing rather than honest would argue for
dropping it from the count too, not only from what is offered.

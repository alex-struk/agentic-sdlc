# 0051 · A redo entry is answered by the line of work that is approved

Status: accepted · 2026-09-25

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A `derive-tests --stale` run closes the redo entries it derives again, on its own proposal branch,
so the approval that merges the proposal brings the closure onto `main` (`0021`, `0044`). A
proposal that is returned instead goes to `derive-tests --revise`, whose branch is cut from `main`
after the return is recorded there. The entries are still open on `main`, and the revision does
not close them: it is handed the ruling's conditions, not the redo list. When a later revision is
approved, the tests the `--stale` run wrote are merged and the closure is not, because it exists
only on the returned branch. `sdlc next` then offers `derive-tests --stale` for the same criteria
again, and the `test-wrong` records those entries were filed from stay in `applied.yaml`.

A project met this in one domain: ten entries taken up by a `--stale` run, returned three times,
approved on the fourth proposal, and all ten still open.

## Decision

**The approval of a line of work closes what the line answered.** When a proposal is approved,
the proposals it rests on are read back from its branch point. A revision's pre-check records the
return it answers on `main` (`recordReturnOnMain`), and nothing commits to `main` while a stage
runs (`0047`), so the commit a revision's branch was cut from adds exactly one gate file: the
returned proposal it revised. That proposal's branch is kept as `returned/<name>`, and its own
branch point names the one before it, back to a proposal no return led to
(`revisionLine`, `src/stages/proposals.mjs`). Only proposals of the same stage and subject belong
to the line.

Each entry a run in the line closed on its branch, and which was open where that branch was cut,
is the entry that run was handed and answered. Where it is still open on `main`, the approval
closes it as met, in its merge commit: the evidence names the run that derived it again, and the
closure is stamped with the approval (`by: <proposal>`, `gate`, `approved_by`), the way `0048`
stamps a hand-on. The calibration records the entry was filed from are dropped with it, as the
run's own approval would have dropped them. Entries are matched as filings, everything stored but
the closure, so an item filed again since is a second send and stays open.

**`sdlc rule <name> --settle` applies the same to an approval already on `main`.** It reads the
approval's merge, closes what the line answered and `main` still holds open, and commits it as the
pipeline author. A second settle finds nothing open and commits nothing.

## Alternatives

**Carry the closure forward on each revision's branch.** A `--revise` run would copy onto its own
branch the closures the returned branch held, so the approved branch always carries them. It is
simpler per run, but it fixes nothing already approved: every revision cut before it lacks the
closure, and a settlement would still have to read the line back. One reading, used by the
approval and the settlement alike, keeps one account of what a line answered.

**Close on `main` when the `--stale` run finishes.** Closing a request its proposal has not yet
been approved for says the test is written when a ruler may still send it back.

**Close whatever the approved tree re-derived.** Comparing the approved spec files with `main`
needs no lineage, but a revision can change a test for a condition without ever having been
handed the redo entry's reason, and `0021` §2 rests on the writer having been told why.

## What would reverse it

A revision whose branch point is not the commit that recorded its return, for instance if `main`
could move while a stage runs, would end the line early and leave the older runs' closures unread;
the line would then need to be recorded on the revision's proposal when it opens.

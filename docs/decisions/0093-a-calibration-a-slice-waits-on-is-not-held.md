# 0093 · A calibration a slice waits on is not held

Status: accepted · 2026-10-02

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Two rules could stop the Build phase dead.

- **A slice is approved only once every criterion it claims has had a test run.** That is
  `policy.gates.G3.block_on_missing_tests`. A test that is owed is a `missing-test` item, owned by
  the stage that has to supply what it needs. A run of the slice's own tests in verify closes an
  item, where verify could run the test.
- **A calibration of the oracle waits out the Build phase** (`docs/decisions/0089`). That covers
  owed work answered by calibrating, which includes a missing test owed a run by `calibrate`.

Where a slice claims a criterion whose test is owed a run by `calibrate`, and the slice's verify
could not run it, the slice waits on the calibration and the calibration waits on the slice. A
test written for a configuration that the target reads at start-up is such a test, because verify
cannot start the new target in a configuration (`docs/decisions/0071`). Nothing could move.

Running that calibration with a stated reason freed the slice, and showed a second gap. The phase
was decided by the oracle's calibration even while slices were being built. A calibration made
then that carried rows from the run before it, or found a row nobody had sorted yet, put the
project back in the Tests phase. Slice work then stopped for full calibrations of the oracle, which
is what 0089 exists to prevent.

## Decision

**The calibration a slice waits on is offered in place of the ruling.** For an open build whose
verify result is approvable, `next` reads the missing tests that would block its approval. Where
any is owed a run by `calibrate`, the build is not put to its ruler. One calibration of each domain
those tests are in is offered instead, `sdlc run calibrate --target <oracle> --domain <d>`, and it
is not held for the Build phase. It stays scoped to that domain even when `policy.calibrate.full_every`
would otherwise make the next calibration full. Once the run closes the items, the build goes to
its ruler as before.

**A calibration that did not close the item is not offered again.** Where the latest calibration
measured the criterion at or after the moment the item was last handed to `calibrate`, and the item
is still open, its test did not run for a reason no calibration answers. The build then goes to its
ruler, who can return the slice or withdraw the item with its reason.

**While slices are being built, the oracle's calibration does not decide the phase.** Slices are
being built from the plan's approval until the last slice is approved. In that span, the Tests
phase's calibration step counts as closed. Rows a calibration made then found are sorted through
their own triage proposals as usual, and rows it carried stay carried. Once every slice is
approved, the step is judged as before, so the full calibration that closes the Tests phase again
is the first thing `next` names.

## Consequences

- A slice whose only gap is a test that needs a configuration on the oracle is approved after one
  calibration of one domain, without anybody running it by hand.
- Slice work is not interrupted by calibrations of the whole suite. Old-application rows that
  change during the phase are settled together at its end.
- A ruler of the build sees the same blocking items it saw before. The guard that refuses the
  approval is unchanged, and so is the route for withdrawing an item.

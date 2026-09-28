# 0070 · A calibration cadence

Status: accepted · 2026-09-28

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Calibration is the only stage that runs the acceptance suite against the oracle. `sdlc next`
offers it in two ways: as the last step of the Tests phase, once the contract, the oracle's
binding and every domain's tests are approved, and as owed work when a missing test is owed a
run or an unbound row's adapter has changed. Neither says anything about how long it has been.

In the Tests phase the upstream work regenerates: each test-writer ruling can send work to
contract, each contract approval sends work to the binding and back to the test writer, and all
of it is owed, so it goes before the sequence's calibration step. Tests, bindings and contract
changes merge for hours with nothing running them. A test that cannot pass against the oracle,
a binding that no longer reaches its page, a seed record that no longer resets, are found only
when calibration next runs, by which point the next round of work has been built on them. An
operator who wants the suite run has to run calibration against what `next` names and record a
deviation.

## Decision

**`policy.next.calibrate_after: <n>`**, unset by default. Once `n` approved proposals that change
what the oracle's calibration measures have merged into `main` since its suite last ran, `next`
names `sdlc run calibrate --target <oracle>` before any owed or sequence work, with a `why`
naming the proposals. Unset, nothing changes.

**What counts is an approved change to what calibration measures.** A proposal counts when the
merge that approved it changes, against `main` before it, the acceptance tests
(`tests/acceptance/`), the oracle's adapter (`tests/adapters/<oracle>/`), the contract
(`spec/contract/`), the oracle's seed or its Compose override. Those are what the suite, its
bindings and the oracle it runs against are made of. Anything else — a design, a plan, a ruling
file — changes nothing calibration would see. Proposals are counted rather than commits or hours
because an approval is the unit that changes what the suite would report, and because the count
is read off `main` alone, like everything else `next` reads.

**The suite last ran at the newest first-parent commit on `main` that added a dated result file
under `tests/results/<oracle>/`.** Only a run of the suite writes one. A `--skip-suite` run
rewrites `latest.json` and measures nothing, so it does not restart the count. A run narrowed to
one domain writes a dated file and does restart it: it ran the suite, and its rows are merged
into the whole.

**Placement.** The due calibration goes before owed and sequence work because the point is to
run it before more work is built on what it has not measured. Proposals keep the place
`policy.next.order` gives them, so under the default order an open proposal an agent can rule is
ruled first, and its approval is counted. It replaces any other offer of the same calibration in
the list, so it is never named twice.

**When it is not due.** Before the first calibration, since the sequence brings that one; while a
calibration or triage proposal for the oracle is open, since the calibration is then waiting on
that ruling; and in a project whose profile does not calibrate or whose config names no oracle,
where `checks` refuses the key because it would apply to nothing.

It is a policy key because how often to pay for a suite run is a project's trade: the suite's
running time against how much work it is willing to build on unmeasured tests.

## Alternatives

**Calibrate after every contract approval.** Too narrow: bindings and tests change what the
suite reports as much as the contract does, and a contract change with no test change behind it
is measured by the test-writer and binding runs it causes.

**A time-based cadence.** Rejected: `next` reads the record and is triggered by changes of state,
never by time (`docs/operating-model.md` §8), and hours say nothing about how much has changed.

**Run calibration inside each approval.** Rejected: a suite run is long, and an approval would
then wait on it.

## What would reverse it

A suite fast enough to run on every approval would make a count unnecessary. Calibrations named
by the cadence that find nothing new, run after run, would say the project's `n` is too low.

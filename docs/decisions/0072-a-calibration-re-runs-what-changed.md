# 0072 · A calibration re-runs what changed

Status: accepted · 2026-09-29

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Every calibration runs the whole acceptance suite against the oracle. On a real project that is a
few hundred criteria and most of an hour, and in the Tests phase calibration runs after every round
of test, binding and contract work (`docs/decisions/0070`), where a round typically changes a
handful of tests or a few adapter members. The rest of the suite is re-run to report what it
reported last time.

The oracle is the old application, and it does not change. A row's result can only change when
something the row ran with changes: its own test file, the target's adapter, the contract and seed
the oracle is started and reset with, the oracle's Compose override, or the harness the suite runs
in. Rows already record two of those (`file_sha`, `docs/decisions/0046`; `adapter`,
`docs/decisions/0067`).

## Decision

**Every row records what it ran with, and the run that measured it.** A row a calibration measured
carries `file_sha`, `adapter`, `contract_seed` (one hash over the trees of `spec/contract/` and the
oracle's seed), `override` (the Compose override's blob), `harness` (one hash over
`tests/fixtures/`, `tests/generated/`, the Playwright configuration and the harness's package
files and TypeScript configuration), `measured_in` (the run's id, its dated file's name without
`.json`) and `rulings_seen` (the gates whose rulings in `applied.yaml` named its criterion). A row
carried forward keeps all of them, and is marked `carried` in `latest.json`. The dated file holds
only the rows its run measured; `latest.json` holds every row. `latest.json` also records the run,
how it chose its rows (`scope`), the last full run and how many suite runs have followed it.

**`policy.calibrate.scope: changed` re-runs a row only when a reason says to.** A row is re-run when
its test is new or its file changed; when it has no provenance; when its test failed because the
target could not be reset or reached (`docs/decisions/0058`); when it is neither passing nor ruled
and the adapter changed; when an open rebind entry for the target, an open redo entry or an open
missing test owed a run by calibration names it; when the gates that have ruled on it differ from
the ones it recorded; and when its test has become stale or stopped being stale. Every other row
is carried. A missing test owed a run is no reason to re-run a row closed as `persona-unavailable`
(`docs/decisions/0068`): it needs a persona the approved contract marks unavailable on the target,
so no run there can pass or fail it. Configuration runs (`docs/decisions/0071`) follow the same rule for their tagged tests,
and a configuration none of whose tests is re-run starts no copy of the oracle.

**A passing row whose only changed input is the adapter is carried.** An adapter change is usually
a binding fix for a few members. Re-running every row for it would make the scope useless in exactly
the phase it exists for, where the adapter changes most. A passing test broken by an unrelated
adapter change is caught by the next full run, which the two guards below bring.

**Any change to what every row shares makes the run full**: the contract and seed, the override, or
the harness. So do `--full`, having no results on file, and a plan that would re-run every row
anyway. `scope` defaults to `full`, today's behaviour, so a project is unchanged until it opts in
at G-POL.

**The first calibration after a project opts in is full.** Results written before rows recorded
their provenance give a plan nothing to compare against, so while no row on file records what it
ran with, the plan runs every row and `next` names `--full`, each saying so. It costs one full run,
once, and no row is carried on inputs somebody inferred.

**A missing test owed a run on a row nobody can run is handed to a ruler.** Calibration owes a run
to a missing test whose test exists and has not produced a pass or a fail. On a row needing a
persona the approved contract marks unavailable, no run ever will. `next` lists such an item under
`waiting on a person`, as waiting on a ruler, naming the target and the criteria, rather than
offering a calibration for it; `condition-withdrawn missing-test/<id>: <why>` on any ruling closes
it. This is read from the row, the way 0068 reads which unbound rows are owed to nobody, so nothing
new is written, and the item is offered to calibration again if a later contract makes the persona
available.

**Two guards bring the full run.** `policy.calibrate.full_every: <n>` makes every n-th calibration
of a target full: after a full run, `n - 1` scoped runs follow. `next` names
`sdlc run calibrate --target <t> --full` when one is due, and its `why` says so. And the Tests phase
closes only when no row in `latest.json` is carried: rows that all pass or are ruled close it only
when the last run measured every one of them. When carried rows are all that keeps it open, `next`
names `--full` with a `why` naming the runs they came from.

**`--full` is an override, not a deviation.** It runs every row whatever the scope, and is recorded
in the run record and on the result set (`full_because`). A full run where `next` names a scoped
one needs no `--reason`; a scoped run where `next` names a full one does.

**Visibility.** The run's summary says `N of M re-run (reasons), K carried from <run>`, or why a full
run was full, and how many scoped runs are left before one is full. The reviewer's and the product
owner's pages mark a carried failing row with the run it came from. The state site marks carried
rows on each domain's criteria page and says how many rows the last run measured and carried.
`sdlc run calibrate --dry-run` prints the plan and writes nothing. It plans before applying the
rulings approved since the last run, which the run itself applies first, so the run can re-run a
few rows the dry run did not list.

## Where the design needed a detail the code decides

**The harness is a shared input.** Every test imports the fixtures and the code generated from the
contract, and runs under one Playwright configuration and one lockfile, so a change there can change
any row. It is hashed with the other shared inputs and makes the run full.

**Staleness is a reason.** A `spec-wrong` ruling or a re-run of archaeology moves a criterion's
version without touching its test file. A row carried across that would go on reporting a result
for a test that is now stale, so a row whose staleness no longer matches what it recorded is re-run.

**"A ruling since its measurement" is compared, not timed.** `applied.yaml` records which gates
ruled on a criterion but not when. The row records the gates it saw when it was measured, and a
difference either way, a ruling added or one lapsed, re-runs it.

**The phase closes on a run that measured every row.** A full run measures every row, so no row can
be carried from a run older than the latest full one. The guard is read as: no row carried from any
earlier run. That is what makes a passing row carried across an adapter change get measured before
the phase closes. It holds under `scope: full` too, so after a `--domain` run, which carries every
other domain's rows, the phase closes on the next full calibration.

## Alternatives

**Work out which rows depend on which adapter members, and re-run only those.** Rejected: the
adapter is TypeScript in shared files, each spec reaches it through fixtures and page objects, and a
member's behaviour can depend on a helper several calls away. Static dependency analysis over it
would be unreliable, and a row it wrongly carried would report a pass it no longer earns with nothing
saying so.

**Carry every row whose test did not change, and rely on full runs alone for adapter changes.**
Rejected: a failing or unbound row is exactly the row an adapter change is written to fix. Carried,
it would stay failing in front of the reviewer and the product owner, and its rebind would go
unanswered, until the next full run happened to come round.

## What would reverse it

A suite fast enough to run whole on every calibration would make the scope unnecessary. Full runs
that keep finding passing rows broken by adapter changes a scoped run carried would say the adapter
rule is too generous, and that a changed adapter should re-run every row.

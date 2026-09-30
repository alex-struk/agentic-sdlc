# 0073 · A ruling applies to the test it judged

Status: accepted · 2026-09-29

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A calibration ruling answers a question about one row: this failure, of this test, against this
criterion. `calibrate` records each applied ruling in `tests/results/<t>/applied.yaml` with the
criterion's version after it was applied, and on every run marks a row `ruled` where a ruling names
its criterion at the version the criterion carries now. Everything downstream reads that mark: a
ruled row is not a failure nobody has answered, so it is not sorted or put to the product owner; it
closes the Tests phase; and a row ruled `test-wrong` or `spec-wrong` is a result of a test ruled not
to test its criterion, so it never closes a missing test (`docs/decisions/0046`, `0058`).

Binding a ruling to the criterion's version alone is right for rulings about the application, but a
`spec-wrong` ruling is also about a test. It rewrites the criterion, which moves its version on, and
the version it records is the one its own edit produced. The test that failed was written for the
version before; it goes stale, and `derive-tests` writes it again for the corrected criterion. That
new test runs at exactly the version the ruling recorded, so its row is marked `ruled: spec-wrong`
as well, although nobody has ruled on it. Two things follow. A missing test owed a run is never
closed, because every run of the new test is disowned by a ruling about the old one, so `next` names
the calibration again after every calibration, with nothing left that could close the item. And a
failure of the new test is hidden from triage by a ruling made about a different test.

`test-wrong` has the same shape at one version: the ruling is about one test file, and the test
derived again is another. `dropTestWrongRulings` removes the record when `derive-tests` writes the
test again, but a test that changes any other way keeps a ruling it was never given. The reviewer's
`product-question` sorting is a verdict about the test that failed, and is dropped with it.

## Decision

**A calibration ruling applies to a row only while the criterion and the test are the ones it was
made on or produced.** Every ruling is bound to the criterion's version. On top of that:

- **`spec-wrong` applies to a row whose test was written for an earlier version than the one the
  ruling produced** — the row's `version`, which is the test's own header, is below the version the
  ruling recorded. A row of the test derived for the corrected criterion is a result nobody has ruled
  on: a `pass` or a `fail` there is evidence and closes a missing test as any run does, and a `fail`
  is sorted and put to the product owner like any other.
- **`test-wrong`, and the reviewer's `product-question` sorting, apply to a row of the test file
  they judged.** Each is recorded with that file's `file_sha`, taken from the row on file when the
  ruling is applied, since no calibration runs between a ruling being asked for and being applied.
  A ruling recorded without one applies to whatever test the row ran, and is removed when
  `derive-tests` writes the test again.
- **The other verbs are bound to the criterion's version alone.** `defect-in-old` is about the
  application. An `oracle-cannot` ruling stands whatever the adapter becomes and lapses when the
  criterion moves on (`docs/decisions/0068`). An `adapter-wrong` verdict lapses with the adapter it
  was about. `persona-unavailable` is worked out again from the approved contract on every run.

A ruling that still applies to its row is kept exactly as it was.

**Readers of a row judge a `spec-wrong` mark against the criterion's version now.** `calibrate`
works every mark out afresh when it writes `latest.json`, but a results file on `main` can carry a
mark an earlier calibration wrote. The rule for `spec-wrong` needs nothing beyond the row and the
index, so it is one function (`standingRuling`, `src/testrun/results.mjs`) that every reader uses:
missing-test closure and the check of past closures, `next`'s reading of whether the Tests phase is
closed and which unbound rows are open, a scoped calibration's reading of which rows a changed
adapter could close, and the state site's per-criterion results. A `test-wrong` mark is taken as
written there: a row carrying it is a result of the test it judged, and a run of any other test
rewrites the row and its mark.

A scoped calibration's `ruled since measured` compares the gates that named a criterion with the
ones its row recorded, and needs no version: a ruling stops applying only when the criterion's
version or the test file changes, and each of those already re-runs the row.

## Consequences

A project whose results carry a `spec-wrong` mark on a row of a re-derived test sees it lapse on the
next calibration, `--skip-suite` included: missing tests owed a run on those rows close, and each
failing row among them is a new question for the reviewer's triage. `next` still names that one
calibration, because an open item on `main` closes only when something writes the list; after it,
the item is closed and `next` moves on.

A `spec-wrong` ruling whose statement matched the criterion already changed nothing and bumped no
version. It judged a test written for the criterion's current version, so it does not apply to that
test's rows, and a failure there is asked about again.

## Alternatives

**Record, on every ruling, the version of the test it judged, and compare the row against that.**
Rejected: `spec-wrong` already records what is needed, the version its rewrite produced, and every
row names the version its test was written for. A second field would say the same thing and would
be missing from every ruling already on file.

**Drop the per-criterion record of a `spec-wrong` ruling when the test is derived again, as
`dropTestWrongRulings` does for `test-wrong`.** Rejected: a record removed by one stage depends on
that stage being the only way a test changes, and it would leave every project whose results already
carry the mark in the same loop until somebody edited `applied.yaml` by hand. A rule over the row
and the ruling holds however the test came to change.

## What would reverse it

A test derived for a corrected criterion that is routinely the same test as before, with only its
header moved on, would say the new test's failures are the ruled failure again, and that the ruling
should follow the test's content rather than its version.

# 0087 · A later build is checked against what earlier slices passed

Status: accepted · 2026-10-01

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Verify runs the acceptance tests of the criteria one slice claims, against the application its
build proposal carries. Every build changes the same application. A build for a later slice can
break a screen or a service an earlier slice delivered. Before this decision, nothing ran the
earlier slice's tests again, so the break was found only by a person using the application.

## Decision

Verify also runs, against the same application and in the same suite run, the tests of every
criterion an already approved slice passed. Those criteria are read from the approved slices'
verify results on `main` (`tests/results/new/slice-<n>.json`).

- **Only what passed is checked again.** A criterion an earlier slice never passed is owed where
  it already is (an environment gap, an unbound row, a criterion nobody asserted). It is not a
  later build's to answer.
- **A criterion this slice claims is judged as its own**, and is never checked again as an earlier
  slice's.
- **One that fails now is a regression.** It returns the build as a failing criterion of its own
  would. Its condition names the slice it passed under, so the builder knows the break is in work
  that was already accepted. A regression counts toward the verify return limit like any other
  failure.
- **One the run could not exercise is reported, and nothing is charged to the build.** That covers
  a test written for a configuration, a row the adapter could not drive, and a test stopped by the
  environment. None of these says anything about the application.
- **The result keeps the slice's own rows apart.** It records the earlier criteria that still pass
  (`rechecked`) and the ones that no longer do (`regressed`), each with its slice. Its `rows`
  remain the slice's own criteria, so routing and owed work read exactly what they read before.

## Consequences

- A verify takes longer as the application grows: it runs the slice's tests and every passing test
  before it. The suite is run once, against one sandbox, so the cost is the tests themselves.
- A build that changes something shared, such as the page layout, is checked against every screen
  the earlier slices proved, not only its own.

# 0112 · An earlier criterion that fails and then passes is not charged to the build

Status: accepted · 2026-10-19

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Once a slice's own criteria pass, verify runs again the criteria that earlier, approved slices
passed, against the same running application, and one that fails there returns the build as a
regression (`docs/decisions/0087`). The return says the build broke something that worked.

That is not true of a test whose outcome depends on more than the application. A test that waits for
a read can run out of time when the application is slow under the whole suite running at once, and a
test can pass or fail by the order the tests ran in or by what another test left behind. Such a test
fails on a build that never touched what it reads. The builder is handed a condition nothing in the
application answers, spends a revision on it, and the verify after that fails it again or passes it,
by chance. Each return also counts towards verify's limit, so a build can be escalated for failures
that were never its own.

## Decision

**An earlier criterion that fails is run once more before it is charged.** Its test runs again,
apart from the rest of the suite and against the same application, straight after the run that
failed it. One that fails again is charged to the build as before, with the failure the first run
saw. One that passes changed its outcome with nothing changed between the two runs, and is not
charged: it does not return the build, it is not counted among the earlier criteria that still pass,
and it is not carried into the slice's next verify as measured (`docs/decisions/0104`). The result
lists it under `flaky`, with the slice it passed under and the first failure, and the summary names
it.

**Its test is filed to be written again.** Verify opens a redo entry for the criterion on
`tests/acceptance/redo.yaml` on `main`, with `verb: test-flaky`, the version the criterion carries
now, `from` the build proposal, `by: runner:verify`, and a `why` that says what happened and quotes
the failure. `next` offers `derive-tests --domain <d> --stale` for it as for any redo entry. The
writer is told what verify saw in a paragraph apart from what rulings sent back, since neither thing
a ruling says of a test is true of this one, and is asked for a test whose outcome depends on what
the application does and nothing else. A criterion the contract does not hold is not filed, because
nothing could derive it and the entry would never close. `policy.loops.redo` bounds how often one
criterion is sent back, as it does for every redo entry.

**Only the earlier slices' criteria are run once more.** A slice's own criteria are not. Their
failures are the common case on a build still being written, and are what its revision answers; a
second run of each would add a suite run to most verifies. An earlier criterion's failure is rare,
and it is a claim about code the build may never have touched.

## Consequences

- A build is not returned, and its return count not spent, for a failure that changes with nothing
  changed.
- A failure that is the build's and happens only some of the time, a race the build introduced, can
  pass when run once more and go uncharged. Its test is filed to be written again, and every later
  slice's verify runs the criterion again, so a race that keeps happening is seen again.
- A verify in which an earlier criterion fails takes one more run of the suite, of only the criteria
  that failed.
- A test whose outcome depends on the adapter rather than on the test, a read the adapter makes that
  takes too long under load, is still sent to `derive-tests`, whose writer cannot change the adapter.
  The redo entry quotes the failure, and a criterion sent back more often than `policy.loops.redo`
  allows is escalated to a person.

# 0104 · An earlier criterion measured on the same inputs is not measured again

Status: accepted · 2026-10-04

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Once a build's own criteria pass, verify runs again every criterion an approved slice passed
(`docs/decisions/0087`, `0089`). That run grows with the project, about ten seconds for each
criterion added, and it is the longest step in the Build phase. When it fails, the failure is
often the test's rather than the application's: a test that asserts more than its criterion says,
re-derived and approved on `main` while the application stays exactly as it was. The next verify
then ran every earlier criterion again, although all but the re-derived tests had already passed
against the same application with the same tests.

## Decision

**A verify records what each earlier criterion that passed was measured against**, in its result
file (`measured`): a digest of the harness beside the application tree it already records, and,
for each criterion, the blob of its test file. The harness is everything a run reads besides the
application and the test file: the new target's adapter, the fixtures, the generated surface, the
seed, the suite's own configuration and packages, the project's configuration, every file beside
the tests that is not a ledger or a note, and the pipeline's own runner, sandbox and stack profiles.

**The slice's next verify carries a pass it would measure again unchanged.** It reads the latest
result of this slice, on any branch the slice's build has gone under, that measured the same
application tree with the same harness digest. An earlier criterion whose test file is the blob
that passed there is carried as a pass and not run; every other earlier criterion runs as before.
What was carried is recorded again, so the next verify can carry it too, and the summary line says
how many were carried and from which proposal's run.

## Consequences

- A re-derived test is run again on its own, with whatever else changed, rather than with every
  earlier criterion.
- A change to the application, the adapter, the fixtures, the seed, a helper beside the tests, the
  project's configuration or the pipeline's runner runs every earlier criterion again, as before.
  So does every slice's first candidate build, since nothing of another slice is ever carried.
- A pass is carried only from a run on exactly the same inputs, so the approval rests on a
  measurement of every earlier criterion against the application being approved. A test that
  passes and fails on the same inputs by chance is the one thing a carried pass can hide until the
  next slice's verify runs it again.
- The adapter is one input. A change to any part of it runs every earlier criterion again, because
  its pages are built from shared helpers and which tests a change reaches cannot be read off the
  change itself.

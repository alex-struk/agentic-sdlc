# 0089 · The Build phase measures the candidate, not every attempt

Status: accepted · 2026-10-02

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Two runs had made a build slice slow, and both measured more often than the result needed.

- **Verify ran the full regression suite every time.** It ran the tests of every criterion earlier
  slices passed (`docs/decisions/0087-a-later-build-is-checked-against-what-earlier-slices-passed.md`)
  on every run, including runs whose own criteria were still failing. The test database is reset
  before each test, so a run grew from about ten tests to about a hundred, and from minutes to
  about forty. A slice that needs several builds paid that on every one, and the answer on those
  attempts was always going to be "return".
- **The oracle was calibrated in the middle of the Build phase.** Owed work answered by a
  calibration, and the cadence `policy.next.calibrate_after`, both fell due there. Each
  calibration runs the whole suite against the oracle and stops slice work while it runs.

## Decision

**Verify runs the slice's own tests first.** It checks again what earlier slices passed only when
those tests come out `pass`, `pass-unasserted` or `environment`, which means the build is a
candidate for approval. The second run uses the same application, in the same sandbox. A build
whose own criteria fail is returned for those alone, and the account says that the earlier
criteria are checked once its own pass. A regression still returns the build. It is found on the
candidate rather than on every attempt before it.

**A calibration of the oracle waits out the Build phase.** This covers a calibration the cadence
makes due and owed work answered by calibrating. While the phase is Build, `next` holds both and
says why. Once every slice is approved the phase is complete, and they are offered as before.

## Consequences

- A build that breaks an earlier slice while its own criteria still fail is told about the break
  only once its own criteria pass, one round later than before.
- Tests rewritten during the Build phase are measured against the oracle at the end of the phase,
  not when they are approved. In the meantime every verify measures them against the new
  application.

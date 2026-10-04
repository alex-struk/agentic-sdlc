# 0100 · An adapter error a test caught is still the adapter's

Status: accepted · 2026-10-04

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A member the adapter cannot bind throws `unbound: <page>.<member> — <reason>`, and a row whose every
failing test ended in that error is `unbound`: owed to `bind-adapter`, not charged to the build
(`docs/decisions/0067`). A member whose page the application does not serve throws `absent:`, and
verify leaves such a failure for the build's ruler to sort (`0098`). Both were read from the
failing test's own error.

A test can catch what an adapter member throws and go on with what it is left with. One read a
proposal's score through a `catch` that turned a failed read into an empty string, then failed on
its own check: "the proposal carries no score". The adapter had thrown `unbound:`, because the page
had gained a score since it was bound, but the test's error said nothing about the adapter. The row
counted as the application's failure, verify returned the build to its builder, and the builder,
who cannot change the adapter, spent a build on it. The steps the test took were recorded with its
failure (`0091`), and the last of them said the read had thrown `unbound:`.

## Decision

**A failing test whose last recorded step threw the adapter's `unbound:` stopped at the adapter,
whatever its own error says.** The harness counts it toward an unbound row exactly as it counts a
test whose error is that message, and the reason the binding is shown is read off that step where
the error carries none. A failing test whose last recorded step threw `absent:` is sorted by the
build's ruler as one whose error does (`0098`).

Only the last step counts. A test that caught an adapter error and then went on to take other
steps through the surface stopped somewhere else, and its failure is read as before.

## Consequences

- A build is not returned to its builder for a gap in the binding that a test happened to catch.
- The binding run is shown the adapter's own reason for such a row, not "the adapter gave no reason".
- The step record is truncated where it is written, so a reason read off it can be cut short.

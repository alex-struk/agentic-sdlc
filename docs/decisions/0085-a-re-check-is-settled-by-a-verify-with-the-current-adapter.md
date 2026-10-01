# 0085 · A re-check is settled by a verify with the current adapter

Status: accepted · 2026-10-01

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A verify of a build slice files each row its suite found unbound on the new target as a rebind
entry stamped with the slice and with the adapter it was found under
(`docs/decisions/0075-what-a-verify-charges-to-the-build.md`). When a binding run changes
`tests/adapters/new`, `next` routes such an entry to the slice's verify, as a row "to check again
now that its adapter has changed", rather than to a calibration, which never measures the new
target.

That verify settles the entries for the criteria the slice claims (`syncUnbound`,
`src/spec/unbound.mjs`): it lapses each one found under the replaced adapter, and files the row
again under the current adapter while sends remain for the build it measured
(`docs/decisions/0083-a-rebind-limit-counts-per-application-build.md`). It touches nothing outside
the slice's criteria. A plan revised after an entry was filed can move its criterion to another
slice, and then no verify of the slice that filed it ever lapses it. The entry stays open under the
replaced adapter, `next` names the slice's verify for it again, the verify measures the same build
with the same adapter, and `next` names the same verify once more. `drive` runs it each time.

The same open entry also counted as a binding the build was owed, so the build was never put to
its G3 holder as one that did not pass.

`drive` stops when `next` names a command again and nothing a step could change has changed since
it last ran (`docs/decisions/0074-a-loop-that-stops-at-a-person.md`). It compared each proposal
branch's whole tree. A verify merges `main` into its build branch before it runs, so what the
previous verify wrote on `main` reached the branch one step later, and the repeated step read as
progress once more than it was.

## Decision

**A re-check is settled once the slice's verify has measured with the current adapter.** An entry
a verify filed, found under an adapter its target has since replaced, is owed the slice's verify
until that verify has run with the adapter the target has on `main` now. The evidence is the
slice's latest verify result, `tests/results/new/slice-<n>.json` on the build branch a binding for
the slice runs against (the newest open build proposal, else the newest of the slice), which
records the adapter tree it ran with as `adapter`. When that tree is the current one, `next` does
not offer the verify for the entry, whatever the verify found. A result that records no adapter
settles nothing.

**What the verify found falls to the routes that already exist.** A row it found unbound again was
filed afresh under the current adapter while sends remained, and is owed to `bind-adapter` as that
entry. A row whose sends were spent was not filed, so no binding is owed, and the build is ruled as
one that did not pass, by its G3 holder, who can return it or escalate it. A settled entry no
longer counts as a binding the build is owed.

**A verify withdraws what its slice no longer claims.** After it settles the slice's rows, a verify
closes as withdrawn every open unbound entry its slice filed for a criterion the slice no longer
claims (`withdrawUnclaimed`, `src/spec/unbound.mjs`). The slice that claims the criterion now files
its own when it is verified.

**`drive` reads a branch as its own changes.** The progress mark digests each proposal and returned
branch as the files it changed since the commit it shares with `main`, with the blob each has now.
`main`'s digest counts what a step wrote on `main`, and merging it into a branch is not counted
again.

## Consequences

- `next` never offers a verify to re-check a row that the verify has already measured with the
  adapter in use; the third offer of an identical step with an unchanged record is stopped by
  `drive` as no progress.
- An entry left open for a criterion its slice no longer claims stays in the owed count until the
  slice is verified again, when it is withdrawn. Nothing routes it in the meantime.
- The rule is per target and per slice, read from the result file every verify already writes. It
  does not depend on why the entry was left open.
- A branch whose own changes are untouched by a step, while `main` moved only by what is excluded
  as the account of runs, is the same branch to `drive`, however many times `main` is merged in.

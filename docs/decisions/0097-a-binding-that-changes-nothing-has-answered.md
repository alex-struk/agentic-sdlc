# 0097 · A binding that changes nothing has answered

Status: accepted · 2026-10-04

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A row the adapter reports unbound is owed to `bind-adapter` as a rebind entry, filed under the
adapter it was found under (`docs/decisions/0067`). The entry is closed by the run that measures
with a changed adapter: calibration on the oracle's target, verify of the slice on the new target
(`0075`, `0085`). `policy.loops.rebind` bounds how often a row is filed, so a binding that keeps
changing the adapter without reaching the row stops after two sends (`0068`, `0083`).

A binding run can also find nothing to change. On the new target that is the expected answer when
the build does not serve the page a test needs: the route answers the application's own
not-found page, and no binding can reach what is not there. Such a proposal is approved with the
adapter as it was. Nothing then measures again, because nothing a run measures with has changed,
so the entries stay open under the adapter the target still has, and `sdlc next` offers
`bind-adapter` for them again. The limit never applies, because it is counted when an entry is
filed and no run files one. On one project this offered the same seven rows to binding run after
binding run, each changing nothing, with the build that needed the pages never ruled.

## Decision

**A binding approved with the adapter unchanged has answered what it was handed.** A binding run
is handed every open rebind entry for its target. When its proposal is approved and the merge
leaves `tests/adapters/<target>` as it was, the approval closes each unbound entry for that target
that was open where the proposal's branch was cut and was filed under that adapter. Each is closed
as met, naming the binding (`answered_by`). An entry filed after the branch was cut was not handed
to the run, and one filed under another adapter is owed the run that measures with this one; both
stay open. `sdlc rule <binding> --settle` applies the same to a binding approved before this
decision.

**A row a binding answered is not sent again under the same adapter and the same build.** Its row
goes where a row whose sends are spent goes: on the oracle's target to the reviewer's triage, on
another calibrated target to a ruler, and on the new target to the open build's G3 ruling, where
an `unbound` verdict cannot be approved (`0082`). That ruler can return the build to make the page,
move the criterion to another slice through a request to `plan`, or send the test to be derived
again. Calibration and verify do not file the row again while the adapter and, for verify, the
application are the ones the binding answered under. A new adapter or a new build of the
application is owed the binding again, as a new build earns its sends again (`0083`).

## Consequences

- A binding that finds nothing to bind takes one turn, not one turn per pass of `sdlc next`.
- The build that lacks a page reaches its ruler with the adapter's own reasons in the verify
  result, rather than waiting on bindings that cannot reach the page.
- The closure is written in the approval's merge commit, so a returned binding closes nothing,
  and the record of what the binding answered is on `main` with the approval.

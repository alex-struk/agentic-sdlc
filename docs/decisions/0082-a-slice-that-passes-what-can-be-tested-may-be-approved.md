# 0082 · A slice that passes what can be tested may be approved

Status: accepted · 2026-09-30

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

`verify` gives an `environment` verdict when no claimed criterion failed and at least one could
not be tested in this environment, such as a test written for a configuration the new target is
not started in (`docs/decisions/0071`, `0075`). Nothing about that verdict is the builder's, so
verify does not return the build for it and `next` offers the ruler `approve` or `return`.

G3's approval check accepted only `pass` and `pass-unasserted`. A ruler who chose `approve` on an
`environment` verdict was refused with "did not pass verify", although every criterion the
environment could test had passed. The only remaining ways to finish such a slice were a return
the builder could do nothing with, or an escalation raised for the sake of approving it.

## Decision

An `environment` verdict is approvable at G3 on the same footing as `pass-unasserted`: in both,
nothing failed and a criterion was not asserted against the application, and whether the slice is
accepted on that footing is the ruler's decision. Both are governed by
`policy.gates.G3.approve_unasserted` (true by default); where a project sets it to false, neither
is approvable by either seat.

An `environment` verdict is not approvable while the result also lists an unbound criterion.
Verify names the environment gap ahead of an unbound row, so the verdict alone does not show that
the adapter failed to drive something; the check reads the result's `unbound` list and refuses,
naming those criteria.

## Consequences

- A slice whose only gap is a configuration verify cannot start is approved in one ruling, with
  the untested criterion named in the verify result the ruling rests on.
- The untested criterion stays unverified on the new target until verify can start a
  configuration; approving the slice does not claim otherwise.
- A human in the G3 seat meets the same rule as an agent: the check reads the verdict, not the
  seat.

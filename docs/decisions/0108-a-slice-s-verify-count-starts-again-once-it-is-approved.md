# 0108 · A slice's verify count starts again once it is approved

Status: accepted · 2026-10-17

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Verify escalates a slice to G3's escalation target once it has returned the slice's build as many
times as `policy.loops.verify_returns` allows (three by default). The count runs over every build
proposal the slice has ever had and starts again only after a person's return (decision 0076).

A slice that is approved can be built again: a later design or contract change asks for its screens
or behaviour to change, and the new build is proposed in the same family (`build-slice-<n>-<k>`).
Its first failing verify then counted every return from before the approval, so a slice whose first
line of work had needed three attempts was escalated on the first failure of the new one. The
escalation replaces verify's return, whose conditions name each failing criterion and what the
application did, with a gate file asking the escalation target to sort the failures from scratch.

## Decision

**An approval starts the count again, as a person's return does.** Only verify's own returns (and a
ruler's return of a build verify left open for sorting) after the slice's latest approval or latest
person's return, whichever is later, count toward the limit. An approval ends a line of work: what
was returned before it was answered by the build that was approved.

An agent seat's return still does not start the count again, for the reason decision 0076 gives.

## Consequences

- A later build of an approved slice is returned to its builder with the failing criteria on its
  first failure, and reaches the escalation target only after it has failed the limit itself.
- A slice that has never been approved is counted exactly as before.

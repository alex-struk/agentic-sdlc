# 0079 · An adapter is ruled before it is measured with

Status: accepted · 2026-09-30

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Two runs measure with a target's adapter. A verify merges `main` into the build proposal's branch
and runs the slice's tests against the new target, through the adapter `tests/adapters/new/`
holds on `main` (`docs/stages/verify.md`). A calibration runs the suite against its target through
`tests/adapters/<t>/` on `main` (`docs/stages/calibrate.md`). A `bind-adapter-<t>-<n>` proposal
changes that adapter, and the change reaches `main` only when the proposal is approved and merged.

`sdlc next` orders ready work by kind (`policy.next.order`) and, within the `proposals` kind, oldest
proposal branch first. A build proposal with no verify result is offered in that kind as `sdlc run
verify --slice <n>`, so where a build proposal's branch was older than an open adapter proposal for
the new target, `next` named the verify first. The verify then measured the build with the adapter
the open proposal was about to replace. Rows that proposal would bind came back unbound or failing,
a verify round was spent, and what the verify found was the adapter's, not the build's
(`docs/decisions/0075`). The same held for a calibration: under an order that puts `sequence` or
`owed` before `proposals`, or with the adapter proposal at a seat a person holds, `next` named
`calibrate --target <t>` while a proposal for that target's adapter was open.

Which of the two is older says nothing about which should go first. What decides it is that one
changes what the other measures with.

## Decision

**A proposal that changes what another step measures with is ruled before that step runs.** For
each target `t` with an open `bind-adapter-<t>-*` proposal, `next` reads every ready item that
measures with `t`'s adapter: `sdlc run verify` for the new target, and `sdlc run calibrate --target
<t>` in any of its forms (sequence, owed, or due under `policy.next.calibrate_after`).

- **Where an agent can rule the adapter proposal now**, its ruling is moved to just ahead of the
  first such item in the ready list, whatever kind either is. Its `rule` says so and names the step
  it goes before. Everything else keeps the place the order gave it.
- **Where the adapter proposal waits on a person** (a seat a person holds, or an escalation to one),
  every item that measures with `t` is held, listed under `held:` with the proposal it waits for,
  and offered again once that proposal is ruled. With nothing else ready, `next` reports that it is
  waiting on a person.

An open adapter proposal for one target changes nothing about a step that measures with another.
The rule reads targets off proposal names and step arguments, so it holds for whatever targets a
project configures.

## Consequences

A verify always measures a build with the adapter the pipeline intends it to be measured with, and
what it finds unbound or failing is charged to the build only when the build is what changed. A
calibration likewise measures the adapter that is about to be on `main`, rather than producing rows
that the next calibration re-measures under the adapter that replaced it.

Verify and calibration now wait on an adapter ruling a person holds. That is the cost: a person
who is slow to rule an adapter stops the slice's verify and the target's calibration with it. The
alternative is a run whose result is known in advance to be about the wrong adapter.

A proposal that has been returned is not open, so a returned adapter proposal does not hold a verify
or a calibration; its revision, once proposed, does. A build that has already been verified, and did
not pass, is ruled as before: the rule orders runs that measure, not rulings of what an earlier run
measured.

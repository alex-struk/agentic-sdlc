# 0106 · A revision that asks the builder nothing runs no session

Status: accepted · 2026-10-05

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A G3 ruling that returns a build often finds the build sound and something else at fault: a test
that asserts more than its criterion says, an adapter member that reads the page too early. The
ruling then addresses every condition to the stage that owns the fault, and the builder is asked for
nothing. The only way on was still `sdlc run build --revise`, a full builder session with an empty
list of conditions. Such a session either changed nothing or changed something no one asked for (one
edited its unit-test configuration), and any change to `app/`, however small, made the next verify
measure every earlier criterion again rather than carry what it had already measured
(`docs/decisions/0104`).

## Decision

**A build revision whose ruling asked the builder for nothing is proposed without a session.** It
applies when every condition on the returned ruling is addressed to another stage and no condition
an earlier ruling attached to the same line of work is still open. The run builds the workspace a
session would have had (the returned branch's `app/` and `docs/decisions/` over the ordinary
archive), collects it as it stands and goes through the same post-checks, journal and proposal as
any build. In place of a session's account, the journal and the proposal page say that no builder
session ran and why, naming each condition and the stage it went to.

**A return with no conditions at all is still revised by a session.** Its rationale is then the only
statement of what the ruler wants, and only a builder can read it.

The stage declares this (`withoutTurn` on the stage definition) and the runner honours it for any
stage, so the same rule is available to another stage whose revision can be asked for nothing.

## Consequences

- The new proposal carries the application tree the returned one carried, so a verify after the
  other stages' work has merged reuses every earlier criterion's pass that the change does not
  reach, and runs the rest.
- A post-check that fails on the unchanged application still earns its one repair turn, which runs
  a session.
- A builder no longer gets the chance to improve a build nobody asked it to change. Anything the
  ruler wants of the build has to be a condition addressed to it.

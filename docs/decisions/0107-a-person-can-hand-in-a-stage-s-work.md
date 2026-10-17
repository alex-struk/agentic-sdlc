# 0107 · A person can hand in a stage's work

Status: accepted · 2026-10-17

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Every gate's seat can be held by a person, but the work in front of a gate could only come from a
stage's own agent session. `sdlc propose` run by hand opens a decision page and carries no files, so
work done outside an agent session had no route onto `main` that a gate would rule on. The ways
round it each broke something: committing the work to `main` by hand bypasses the gate and the
stage's checks, and asking the stage's agent to redraw the work from a description rewrites what a
person has already checked.

Teams that run the pipeline will have people doing some of a stage's work themselves: a designer
working in a design tool and a component catalogue, a developer building a slice by hand. The gap is
in the pipeline, not in any one project.

## Decision

**`sdlc run <stage> --hand-in <branch>` takes the stage's work from a person's branch in place of an
agent session.** Everything else about the run is the stage's own: its pre-checks, its workspace, its
post-checks, its journal, its run record and its proposal at its gate.

- **Only the stage's outputs are taken.** Every path the stage collects is replaced outright by the
  branch's version, deletions included. Anything else the branch changed stays on the branch, so a
  hand-in can deliver no more than the stage's agent could.
- **The branch must be current with `main` at those paths.** Taking the branch's version replaces
  what `main` holds there, so a branch that `main` has moved past would undo the newer work. The
  run is refused, naming the paths, until the branch is brought up to date.
- **The stage's checks judge the work as they judge an agent's.** A check that fails ends the run
  with the failure recorded and the branch's files taken back out of the working tree. No agent
  repair turn runs: repairing it would put work in front of the gate that nobody handed in. The
  person corrects the branch and hands it in again.
- **The record says who did the work.** In place of a session's account, the journal entry and the
  proposal page say that a person handed the work in, from which branch and at which commit, with
  the reason given for the run as the person's own word on it. The run-record line says the same.
- **Only a stage with a gate takes a hand-in, and only one that works in its own workspace.** A
  gate-less stage's work reaches `main` with no ruling, so a person's files would land there
  unreviewed. A stage that works in the project tree has no workspace to take the branch's outputs
  into. A hand-in is new work, so it is refused alongside `--revise`, which answers a ruling.

The runner builds this from two things it already does: laying a commit's version of a stage's paths
into the workspace, as a revision does, and finishing a run that had no agent turn, as decision 0106
does.

## Consequences

- A person's work and an agent's reach `main` the same way, judged by the same checks and ruled on
  at the same gate, which is the same symmetry the gate seats already have.
- `next` names agent runs. A hand-in that is not the run `next` names needs `--reason`, like any
  other run, and the reason is kept in the run record.
- A failed hand-in leaves a journal entry and a run-record line on `main`, and nothing else; the
  work stays on the person's branch.

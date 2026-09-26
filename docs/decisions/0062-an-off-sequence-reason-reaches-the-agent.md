# 0062 · An off-sequence reason reaches the agent

Status: accepted · 2026-09-25

## Context

`sdlc next` names work from the project's recorded state. An operator may run a different
stage by giving `--reason`, which records the deviation before that stage starts. A reason
can contain evidence found after `next` made its choice: a target that failed during a
calibration, for example. Recording that evidence for later readers does not put it in
front of the agent being asked to act on it. The agent then sees its ordinary stage task
and may repeat work without examining the condition that prompted the run.

The operator's reason is not a gate ruling. It must not change which paths a stage may
read or write, who judges its proposal, or the checks that accept its output.

## Decision

When a run differs from what `next` names, `--reason` is given to an agent stage as a
separately labelled context note beside its ordinary prompt. The note tells the agent to
investigate the reason and says it is not a ruling or permission to exceed the stage's
scope. The same note reaches a fix turn. A run that follows `next` has no note, even if
the operator supplied a reason.

The reason is scrubbed of local home paths, including mounted Windows home directories,
before it is recorded, put in a prompt, or
saved in the project-local run state that a resumed run reads. A dry run still needs no
reason and writes nothing; if an off-sequence reason is supplied, its prompt preview
includes the note a real agent turn would receive.
Where a user folder contains spaces, a following path separator establishes its boundary;
without one, the operator must omit that ambiguous bare folder name from the reason.

A reason in a common credential-bearing form — a named password, token, secret or key
assignment, a Bearer value, or a private-key header — or carrying a nine-digit social
insurance number (SIN) shape is refused before any of those sinks are reached. The
refusal names the category and never repeats the input. The check cannot recognise every
secret, so the operator remains responsible for supplying a safe summary.

## Alternatives

**Leave the reason only in the run record.** The run record is an account for readers of
the repository, not part of the agent's prompt. The stage would have to discover it and
decide that the newest line was meant for its own work.

**Make the reason a new instruction channel that can override a stage.** That would let
an operator bypass stage scope or a gate through ordinary command text. A context note
keeps the evidence visible while the existing stage rules still govern the work.

**Require a ruling request for every deviation.** A ruling's `addressed-to` condition is
the route for work one seat asks of another. An operator can also diagnose a broken
environment before there is a sound proposal to rule on. Requiring a ruling in that case
would force a verdict on unreliable evidence.

## What would reverse it

A structured, recorded handoff of operator evidence to the agent could replace the
single reason note, provided it stays within the same stage scope and gate rules.

# 0049 · An adapter the contract has outgrown is owed a binding

Status: accepted · 2026-09-25

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

An adapter binds every member the contract's surface declares. The bind-adapter post-check
holds it to exactly that: `tests/adapters/<t>/bindings.yaml` names every action and observation
of every page once, and nothing the surface does not declare. An approved adapter therefore
agreed with the contract on the day it was ruled.

A contract revision that adds members breaks that agreement for every target at once, and
nothing noticed. `next` offered a target's adapter only for the `rebind` entries a calibration
triage had filed against it, and the run's prompt carried only those findings. A project whose
revised contract added 66 members was sent to fix 6 rebinds; the run fixed them, and its
post-check failed on the 66 members nobody had asked it to bind. The repair turn did not bind
them either. The run could not pass on what it was asked to do.

Tests have had the equivalent protection from the start: a criterion's version bump marks the
tests written against the older version stale, and `next` owes them a derivation.

## Decision

**An adapter is stale when its bindings disagree with the contract by name.** Read from `main`:
a member the surface declares that `bindings.yaml` does not name, or a name `bindings.yaml`
carries that the surface no longer declares. The comparison is `bindingGaps`
(`src/spec/surface.mjs`), and it is the same function the post-check uses, so a run is offered
for exactly what it will be judged on. A target with no `bindings.yaml` on `main` is not stale;
it has not been bound.

**A stale adapter is owed work, and one run answers it with the target's rebinds.** `next` groups
the unnamed members, the undeclared names and any open rebind entries for a target into one
`sdlc run bind-adapter --target <t>`, and its reason counts each. Nothing is written to record
it: like a stale test, it is read from the record every time, and the approval that brings the
adapter up to date is what clears it.

**The run is told what it lacks.** The stage computes the same gaps from the adapter and contract
it runs against and puts them in the prompt, page by page, with the instruction that the
existing bindings stand and are added to rather than rebound from the start. The workspace,
the tools and the blindness are unchanged (`0006`): the gaps are names from `bindings.yaml`
and `surface.yaml`, both already in the workspace.

**The oracle's adapter first; any other target's in the Build phase.** A target that is not the
oracle is bound against an application that exists on a build proposal until it merges, so its
stale adapter is offered once the phases before Build are closed, and until then `next` lists
it under `stale adapters` with the phase it waits for. When both are offered, the oracle's comes
first, because calibration measures the suite against it before anything is built. A target
whose binding proposal is already open is not offered again.

## Alternatives

**Stamp each adapter with the contract version it was approved against.** Exact about when the
contract moved. Nothing records that version today, so every existing adapter would read as
unknown until something backfilled it. It would also mark every adapter stale on a contract
revision that changed only the seed, the personas or the observables, which spends a browser
binding run per target to change nothing. And it says that the adapter is behind, not what it
lacks, so the prompt would still need the name comparison.

**Reopen the sequence step.** Treat `bind-adapter --target <oracle>` as not closed while its
adapter is stale. It covers only the oracle, and a sequence step is what the phases call for,
not what a change to an approved artifact owes; stale tests are owed work for the same reason.

**Leave the rebind-only run and give the repair turn the missing names.** The repair turn
already received them as post-check messages and did not bind them. A repair corrects a run's
own work; binding sixty members is the run's work, and it belongs in the task the run is given.

## What would reverse it

A contract change that keeps every member's name and changes its route or its parameters is
not a gap this comparison sees. If such changes turn out to be common, a record of the contract
each adapter was approved against becomes worth keeping beside the comparison, and the prompt
would name the changed members too.

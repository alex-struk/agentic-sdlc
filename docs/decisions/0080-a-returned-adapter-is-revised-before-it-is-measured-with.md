# 0080 · A returned adapter is revised before it is measured with

Status: accepted · 2026-09-30

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A verify measures a build with the new target's adapter on `main`, and a calibration measures
with its target's adapter on `main` (`docs/decisions/0079`). While a `bind-adapter-<t>-*` proposal
is open, `next` rules it before either runs. A proposal the reviewer returns is no longer open,
and `sdlc run bind-adapter --target <t> --revise` is owed instead. `next` offers that revision
as owed work, and a verify is a `proposals` item that the default order puts first. So with a
returned adapter proposal for the new target and a build proposal awaiting verify, `next` named
the verify, which measured the build with the adapter the reviewer had just rejected.

Two things stand between the revision and its run on the new target. The binding runs against
the application a build proposal carries, started with `sdlc sandbox up --target new --from
<branch>`, and bind-adapter names that branch when it refuses a sandbox that is not up
(`docs/decisions/0078`). It named only the newest open build proposal of the slice its rebind
entries name, and refused where none was open. A verify that returns a build with failures
beside its unbound rows leaves no build proposal of that slice open: the returned one is
`proposal/<name>` with its ruling on it until `build --revise` records the return on `main` and
renames the branch `returned/<name>` (`recordReturnOnMain`, `src/stages/proposals.mjs`). The rows
the binding owes were found on that build's application, and it is still on that branch.

And bind-adapter's revise pre-check records the return on `main` when it finds it, which renames
the adapter proposal's branch to `returned/<name>`. Pre-checks all run, so a revision refused
because the sandbox was not up had spent its return all the same. The run that followed, with the
sandbox started, found no return to revise from, and `next`, which reads returns off `proposal/*`
branches, no longer offered the revision at all.

Nothing records which application a binding ran against.

## Decision

**A returned adapter proposal is revised before a step that measures with it.** For each target
`t` whose `bind-adapter --target t --revise` is ready, `next` moves that revision to just ahead of
the first ready item that measures with `t`'s adapter (`verify` for the new target, `calibrate
--target t` in any of its forms), whatever kind either is. For the new target it also goes ahead
of a ready `build --slice <n>`: the build measures nothing, but its verify will measure with the
adapter, so the revision is preferred when both are ready. Its `rule` names the step it goes
before. The revision is proposed as an open adapter proposal, and `docs/decisions/0079` then rules
it before the same steps. A revision held on work its ruling asked of another stage
(`docs/decisions/0050`) holds nothing: that work may itself be a build whose verify would wait on
the revision.

**A binding runs against the newest build of its slice when none is open.** The branch
bind-adapter names is found in this order: the newest open build proposal of the slice the rebind
entries name, as before; where none of those slices has one open, the newest build proposal of
that slice whatever its state, by proposal number, under `proposal/` or `returned/`. An entry that
names no slice belongs to the slice in `plan/tasks.md` that claims its criterion. With no entries —
a run catching up with the contract, or a revision whose entries are spent — every slice in the
plan is a candidate, and the answer is the newest build of the slice furthest on in the plan that
has one, which carries every slice approved before it. An open build proposal for more than one
slice, or none open and a ruled one for more than one of the slices the entries name, is a
person's call, and the refusal says so with no branch. The same branch is what `next` names beside
an owed binding for a slice. `sdlc sandbox up --from` accepts any branch in the repository, and
drive passes a `returned/` branch to `sandbox up` and `sandbox down` exactly as the step named it.

**A revision's return is spent only by a run that can go ahead.** bind-adapter's revise pre-check
finds the return in every run, and records it on `main` only when every pre-check ahead of it
passed. A revision refused because the sandbox was not up leaves its return on `proposal/<name>`,
where the run after `sdlc drive` or a person has started the sandbox finds it.

## Consequences

A verify or calibration no longer measures with an adapter a ruler has returned while its revision
is ready to run. The build that `next` would otherwise name first waits one binding run, and its
verify then measures with the adapter the revision proposes, once that is ruled.

A binding owed after a verify returned its build runs without a person choosing a branch, and
`sdlc drive`'s sandbox recovery reaches it. The application it binds against is one a verify has
returned; the rows it binds were found there, and the build revision that follows changes what
the builder was answerable for, not the controls the adapter binds.

A return a refused run has already recorded on `main` is on `returned/<name>`, where neither the
revise pre-check nor `next` looks for one, and its revision is not offered. A person answers it,
by moving the branch back to `proposal/<name>` and removing the recorded gate from `main`, or by
running the binding afresh.
Other refusals added to a run after a stage's own pre-checks — the owed-work limit, a backend that
cannot run the stage — still follow the revise pre-check, and a revision refused by one of them
spends its return as before.

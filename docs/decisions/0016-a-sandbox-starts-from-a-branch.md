# 0016 · A sandbox starts from a branch, and leaves HEAD where it found it

Status: accepted · 2026-09-20

## Context

`build` writes one slice of the rebuilt application under `app/` — including
`app/compose/compose.yaml`, where the stack profile has the application declare its own local
services — and opens the result at G3 as `proposal/build-slice-<n>`. That branch is not merged
into `main` until a reviewer approves it, which is the point of the gate.

`verify` runs the slice's acceptance tests against the application, and its first act is to check
that proposal branch out, so it sees one. A criterion whose adapter has no binding on the target
is reported `unbound`, and the next step named is `sdlc run bind-adapter --target new`.

That step cannot run. `bind-adapter` starts from `main` and pre-checks that the target answers
HTTP, because its agent drives a real browser against a running application and never reads source.
Only `sdlc sandbox up` makes the target answer, and `sandbox up` resolves `targets.<t>.compose`
against the working tree it is run in — on `main`, that file does not exist, and the command
refuses with `app/compose/compose.yaml is missing`. Binding needed the application running, the
application ran only from the proposal branch, and nothing but `verify` knew how to get there.

This is structural rather than a first-slice artifact. Every slice's new screens exist on that
slice's proposal branch alone until it merges, so binding an adapter to them always needs a tree
that is not `main`.

## Decision

**`sdlc sandbox up|down|reset|status` takes `--from <branch>`.** The action runs with the working
tree on that branch, and HEAD goes back to where it started. Without the flag every action behaves
exactly as before: the tree it is run in is the one compose reads.

**The borrow is the one `verify` already makes**, now a pair in `src/lib/git.mjs` that both call.
`enterBranch` refuses a branch name nothing resolves and refuses a dirty tree — `git checkout`
carries uncommitted changes across, and a command that borrows a tree cannot promise to return
changes it did not make. `leaveBranch` goes back only once the branch it is leaving is clean, and
hands back the porcelain status it refused to leave behind, so residue stays visible on the branch
that produced it instead of riding onto `main`, where every command needing a clean tree would then
refuse on files nobody there touched.

**A sandbox action that dirties the tree exits non-zero**, even where the stack itself came up.
HEAD is then still on the borrowed branch, and the next `sdlc run` refuses anywhere but `main`, so
that is what the caller has to deal with first.

**`--from` is on all four actions, not only `up`.** Compose resolves the target's compose file
against the tree it is run in, so `down`, `reset` and `status` find nothing to read on `main`
either; a stack that could be started and not stopped would be a worse hole than the one being
closed.

**`verify`'s `unbound` report names the whole sequence**, with the branch filled in: start the
sandbox from the proposal branch, bind, rule the adapter proposal at G3, tear the sandbox down. It
ends by saying what verify itself then needs — the slice's build proposal has to carry the ruled
adapter, and a proposal branch opened before that ruling does not, since verify runs the suite on
the branch and not on `main`.

## Why this is enough

A container does not read the working tree. `docker compose up -d --build --wait` reads the build
context while it builds, the containers run from the images that build produced, and `up`'s own
seed step has already loaded by the time it returns. Restoring HEAD afterwards changes nothing the
running stack depends on, which is what makes a borrow — rather than a second checkout of the repo,
a worktree per proposal, or a build that reads its context out of `git archive` — the whole of the
fix.

The exception is an application whose compose file bind-mounts the working tree into a container.
The stack profile's does not: its services are built images. A project that adds a mount of its own
source ties its containers to whatever branch is checked out, and `--from` will not serve it.

## What was considered instead

**Merging the proposal into `main` before binding.** That is the gate, decided in full; approving a
build so an adapter can be written inverts the order 0011 is built on, where the reviewer rules on
evidence the suite has already produced.

**Running `bind-adapter` from the proposal branch.** The stage requires `main` for the same reason
every gated stage does: `propose` opens a proposal branch off `main`, and a run started elsewhere
would branch off that branch and diff against the wrong base — the adapter proposal would carry the
build's changes as if they were its own.

**A second checkout or a dedicated worktree for the proposal.** It would work, and it costs a copy
of the repository, a path to manage and a second place for a stale tree to survive — for a build
whose output the containers hold anyway the moment it finishes.

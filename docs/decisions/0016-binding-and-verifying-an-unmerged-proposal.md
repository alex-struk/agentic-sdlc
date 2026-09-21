# 0016 · Binding and verifying an application that is still in an unmerged proposal

Status: accepted · 2026-09-20

## Context

`build` writes one slice of the rebuilt application under `app/` — including
`app/compose/compose.yaml`, where the stack profile has the application declare its own local
services — and opens the result at G3 as `proposal/build-slice-<n>`. That branch is not merged
into `main` until a reviewer approves it, which is the point of the gate.

`verify` runs the slice's acceptance tests against the application, and its first act is to check
that proposal branch out, so it sees one. A criterion whose adapter has no binding on the target
is reported `unbound`, and the next step is to bind one.

Two things stood in the way of that, one behind the other.

**Binding could not start the application.** `bind-adapter` runs from `main` and pre-checks that
the target answers HTTP, because its agent drives a real browser against a running application and
never reads source. Only `sdlc sandbox up` makes the target answer, and `sandbox up` resolves
`targets.<t>.compose` against the working tree it is run in — on `main` that file does not exist,
and the command refuses with `app/compose/compose.yaml is missing`.

**A branch could not pick an adapter up once it existed.** `rule` merges an approved adapter
proposal into `main`. The slice's build proposal was cut from `main` before that, and nothing
brought it forward, so verify checked out a branch with no adapter on it and reported the same
criteria unbound again. Nothing in the pipeline could change that: the `unbound` route writes no
gate file, so `build --revise` is refused for want of a returned ruling, and a fresh `build` is
refused because the first proposal is still open.

Neither is a first-slice artifact. Every slice's new screens exist on that slice's proposal branch
alone until it merges, so binding an adapter to them always needs an unmerged tree — and the
adapter that binds them always lands on `main` after that branch was cut.

## Decision

**`sdlc sandbox up|down|reset|status` takes `--from <branch>`.** The action runs with the working
tree on that branch, and HEAD goes back to where it started. Without the flag every action behaves
exactly as before: the tree it is run in is the one compose reads. `--from` is on all four actions,
not only `up`, because compose resolves the target's compose file against the tree it is run in —
a stack that could be started and not stopped would be a worse hole than the one being closed.

**`verify` merges `main` into the proposal branch before it runs the suite.** The branch then
carries whatever the project's test rig has become since it was cut, a newly ruled adapter
included, and the slice's next verify sees it. The merge commit stays on the proposal branch, so
what the suite ran against is what a reviewer reads at G3.

**A proposal that no longer merges is verify's finding, not the reviewer's.** The merge is undone,
the branch is left exactly as it was, the conflicted paths are named, and the run fails. Nothing is
written to a gate file and nothing is returned to the builder: a conflict is not a verdict about
the application, and the slice needs rebuilding on top of what `main` now has.

A merge can also fail for a reason that is not a conflict — an unresolvable ref, a hook, a refused
commit. Those are told apart by whether git named a conflicted path, and reported with git's own
reason, because prescribing a rebuild for a hook that declined the commit would send a person to
fix the wrong thing.

**The merge commit stays even when the run that followed it failed.** A sandbox that will not
start, or a suite that throws, leaves the branch merged and carrying no result. That is the honest
record — the merge did happen — and the next verify finds the branch already up to date and
creates no second commit.

**The borrow is one pair of functions, `enterBranch` and `leaveBranch` in `src/lib/git.mjs`**, used
by both the sandbox command and verify. `enterBranch` refuses a branch name nothing resolves and
refuses a dirty tree — `git checkout` carries uncommitted changes across, and a command that
borrows a tree cannot promise to return changes it did not make. `leaveBranch` goes back only once
the branch it is leaving is clean, and hands back the porcelain status it refused to leave behind,
so residue stays visible on the branch that produced it instead of riding onto `main`, where every
command needing a clean tree would then refuse on files nobody there touched.

**Where HEAD was left is reported before any failure is rethrown, and on the failing path too.** An
action that threw after dirtying the tree is exactly when a caller needs telling: otherwise they
read the docker failure, fix docker, and the next `sdlc run` refuses with `must start on main` for
a reason nothing has mentioned. A teardown that fails as well is recorded without displacing the
failure already on its way out. A sandbox action that leaves the tree dirty exits non-zero even
where the stack itself came up, because HEAD is what has to be dealt with first.

**`verify`'s `unbound` report names the whole sequence**, with the branch filled in: start the
sandbox from the proposal branch, bind, rule the adapter proposal at G3, tear the sandbox down,
verify again. Every step of it runs.

## Why a borrow is enough for the sandbox

A container does not read the working tree. `docker compose up -d --build --wait` reads the build
context while it builds, the containers run from the images that build produced, and `up`'s own
seed step has already loaded by the time it returns. Restoring HEAD afterwards changes nothing the
running stack depends on, which is what makes a borrow — rather than a second checkout of the repo,
a worktree per proposal, or a build that reads its context out of `git archive` — enough.

The exception is an application whose compose file bind-mounts the working tree into a container.
The stack profile's does not: its services are built images. A project that adds a mount of its own
source ties its containers to whatever branch is checked out, and `--from` will not serve it.

## Why verify merges, rather than reading the adapter off `main`

The alternative was to leave the branch alone and resolve `tests/adapters/<t>/` from `main` when
the suite runs. It is smaller, and it is the wrong shape.

A suite run is evidence about a tree. Sourcing part of the rig from somewhere else makes the run
describe a combination no branch ever held, and `tests/results/new/slice-<n>.json` — the evidence
a G3 ruling turns on, down to `app_tree` — would name a proposal that was never the thing tested.

It also fixes one symptom of a general staleness. The adapter is what this deadlock made visible,
but the fixtures, the generated surface types, the seed and the ratified criteria index move on
`main` too, and a branch cut months of slices ago is stale in all of them. Merging brings the whole
rig forward at once; a special case for adapters leaves the rest to be discovered as test failures
that look like the application's fault.

Two consequences of merging are wanted rather than tolerated. A proposal that no longer merges is
found by verify, with the conflicting paths named, before a reviewer spends a turn on it. And the
`app_tree` recorded in the result is the tree an approval would put on `main`, because the branch
now carries `main`: where another slice has changed `app/` as well, the suite runs against the
combination approval would produce rather than against a version of the application that exists
nowhere else.

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

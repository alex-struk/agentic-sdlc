# 0078 · Drive starts the new sandbox for a rebind

Status: accepted · 2026-09-30

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A verify of a build slice files the rows its suite found unbound on the new target as owed to
`bind-adapter --target new`, each stamped with the slice (`docs/decisions/0075`). That binding
runs against the application the slice's open build proposal carries, which is on the proposal's
branch alone until it is ruled, so it is started from `main` with `sdlc sandbox up --target new
--from proposal/build-slice-<n>[-k]`, the binding runs, and the same `--from` takes it down
(`docs/decisions/0016`). `sdlc next` says so beside the offer.

`sdlc drive` runs what `next` names and has one recovery, for an oracle that is not up
(`docs/decisions/0074`). It had none for the new target, so a drive that reached a rebind stopped
on bind-adapter's pre-check, and an operator started the sandbox by hand.

Two facts about the machine shape the answer. `sandbox up` refuses before it starts anything when
a host port its compose file publishes is already held. And the oracle and a rebuilt target can
be given the same port: `oracle up` keeps the port `oracle.base_url` names whenever it is free,
and `targets.<t>.base_url` is fixed in configuration. With the oracle up on that port, the new
sandbox cannot start, and bind-adapter's probe of the new target's address is answered by the
oracle, so a binding run then would bind the old application under the new target's name.

## Decision

**bind-adapter's refusal names the sandbox and the branch.** For any target other than the
oracle's, the pre-check refuses on two findings: nothing answers at the target's `base_url`, or
the copy of the oracle that `oracle up` recorded is on that address's port. Either refusal reads
`bind-adapter: the <t> target's sandbox is not up — <finding>; run sdlc sandbox up --target <t>
--from <branch> first`. The branch is the newest open build proposal of the slice the owed
entries it is handed name; an entry that names no slice belongs to the slice in `plan/tasks.md`
that claims its criterion, and a run handed no entries, one catching up with the contract, takes
every slice in the plan as a candidate. Exactly one candidate with an open build proposal is
named. None, or more than one, is said in the refusal instead, with no branch: one sandbox runs
one application, and which of two to bind against is a person's call.

**drive acts on that sentence, the way it acts on the oracle's.** A step that failed with it is
answered in order: the oracle is taken down when `oracle up` has a copy recorded as running;
`sdlc sandbox up --target <t> --from <branch>`; the step is run once more; and `sdlc sandbox down
--target <t> --from <branch>`, whatever became of the start or the step. Each action is a recovery
line on the record before it runs. A sandbox that does not start stops the loop with 1 and the
tail of its output, without running the step again. A sandbox that cannot be taken down stops the
loop with 1 and the command to take it down by hand, since a stack left running holds the ports
the next calibration's oracle expects. The sandbox is taken down after the step and not after the
binding's ruling: the ruling reads the adapter and typechecks it, and the verify that follows
starts its own sandbox from the same branch.

**A sandbox that could not start on a held port, while the oracle is up, is answered by taking the
oracle down.** A verify brings the new sandbox up itself, and refuses the same way on the port the
oracle holds. That step is run once more after `oracle down`. With the oracle not up, a held port
is something else on the machine and a stop.

**The sandbox password stays in the environment.** `sandbox up`, compose and the binding's browser
tool read `SDLC_SANDBOX_PASSWORD` from the process drive runs in, which is the operator's. drive
passes it in no argument and writes it into no record line, heartbeat or file.

## Alternatives

**bind-adapter starts and stops the sandbox itself.** The stage knows what it binds against, and
this would make a typed `sdlc run bind-adapter --target new` need no preparation. It would also
make a stage run take the oracle down, which is a change to the machine a person running one
command does not expect and cannot see coming; and it would replace a sandbox a person had already
started from the branch they chose. An agent stage has pre-checks, which are synchronous, and no
teardown that runs whatever the session did; verify has one because it is its own `execute`. The
lifecycle belongs with whoever sequences the commands: a person typing them, or the loop.

**drive reads the branch from `next`'s `why`.** `next` already prints it beside the offer. That is
advice written for a person and worded for one, and a loop matching on it would change behaviour
whenever the advice is reworded. The refusal is the stage's own account of why it did not run,
which is what the oracle recovery reads too.

**Start the sandbox before every `bind-adapter --target new`, failed or not.** It would save the
first, refused attempt. The refusal costs a pre-check and no agent turn, and recovering on it keeps
one rule for every recovery: the step says what it lacked, and the loop supplies that and nothing
else.

## What would reverse it

Recorded drives that take the oracle down for a rebind, in a project whose oracle and new target
publish on different ports, only to bring it straight back up for the next calibration, are
evidence for taking it down only when it holds a port the sandbox publishes. A plan whose slices are built side by side, with more
than one open build proposal owing bindings at once, would need a rule for which to bind first
before this could proceed without a person.

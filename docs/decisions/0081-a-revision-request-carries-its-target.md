# 0081 · A revision request carries its target

Status: accepted · 2026-09-30

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A ruling's `addressed-to <stage>: <why>` condition files a revision request on
`.sdlc/revision-requests.yaml`, and a run of the addressed stage takes it up
(`docs/decisions/0050-a-request-reaches-a-stage-that-takes-it-up.md`). A request recorded the stage,
the reason, and the ruling that asked. It recorded nothing about which domain, target or slice the
addressed stage was to run on, so `next` offered it with the subject left as a placeholder:
`sdlc run bind-adapter --target <target> --revise`.

A person reading that line fills the target in. `sdlc drive` does not: it hands the step's
arguments to the stage as they stand, and bind-adapter, with no target, refuses the run. A G3
ruling that returns a build with conditions addressed to bind-adapter is the ordinary way an
adapter fault found by a verify is sent back, and each one stopped the drive. The build's own
revision waits for that request to be answered (`docs/stages/next.md`, Held), so nothing else in the
slice could move either.

The target was knowable in each case. A build proposal is about the build target's application, and
its verify measured with that target's adapter (`docs/decisions/0075`). A `bind-adapter-<t>-*`,
`calibrate-<t>-*` or `calibrate-triage-<t>-*` proposal names its target. A reason written about an
adapter usually quotes its path, `tests/adapters/<t>/…`. And `bind-adapter --revise` took up every
open request addressed to bind-adapter whatever target it was run on, so a request about one
target's adapter could be answered by a run revising another's.

## Decision

**A ruling records the subject of what it asks.** When a ruling files a request to a stage that
runs on a domain, target or slice, the entry records that subject under the stage's own flag name
(`target:`, `domain:`, `slice:`) where it can be read from the ruled proposal or the reason. For a
target, the ruled proposal names it when it is a binding or calibration proposal; a build proposal
is on the build target; failing both, the reason names it when it quotes exactly one configured
target's adapter path. For a domain or a slice, the ruled proposal names it when it is about the
same kind of thing. A request whose subject cannot be read is filed without one. The subject is not
part of a request's identity, so a request filed twice is still filed once.

**`next` runs a request on what it is about, and never offers a placeholder.** A request is offered
with the subject it records, and a request filed without one is read the same way the ruling would
have read it (`requestSubject`, `src/runner/routes.mjs`), which places the requests already on file.
A request nothing places is listed under `waiting on a person` as waiting on a ruler, grouped by
stage, with the reason and the run to complete by hand. As a guard, anything that reaches `ready`
or `held` with a placeholder in its command is moved to waiting on a ruler rather than offered.

**`bind-adapter --target T --revise` takes up the requests about `T`.** The round a revision answers
from requests holds the open bind-adapter requests whose subject is `T`, and those nothing places on
a target: a person who names the target on the command line has said which, and a request no run
could otherwise take up would stay open. A request about another target is left for that target's
run. A revision from a returned ruling lists the same requests as open and not its own.

The build target is one named constant, `BUILD_TARGET`, beside the routes that read proposal names,
and `next` reads it from there.

## Consequences

A build returned with conditions for its adapter is followed by `sdlc run bind-adapter --target new
--revise` under `sdlc drive`, and the build's revision waits for that proposal's approval as before.
The requests on file before rulings recorded a subject are placed the same way at read time, without
a migration.

A request whose subject nothing names stops being runnable work and becomes a ruler's item. The run
that answers it is still `sdlc run <stage> --<subject> <value> --revise`, completed by hand; drive
does not guess.

Domain and slice subjects are read only from the ruled proposal. A request to a per-domain stage
from a ruling on a build, a plan or a contract names no domain, and waits on a ruler; a reason that
names a domain in prose is not read for one.

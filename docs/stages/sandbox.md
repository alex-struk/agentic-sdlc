# `sdlc sandbox`

## Purpose

Start, stop, reseed and report on the rebuilt application's own local deployment — the counterpart
of `sdlc oracle` for target `new` rather than the old application. `verify` calls the same
functions this command wraps (`sandboxUp`, `sandboxDown`) to stand the application up for a slice's
acceptance run and tear it down after (`docs/stages/verify.md`).

This is the deploy step for this phase (`docs/decisions/0011-build-verify-review.md`): the
project's own Docker Compose file, built from the working tree, waited on, then seeded. It is local
only. Deploying to OpenShift needs a namespace and credentials a person supplies, and no agent
stage holds one.

Like `sdlc oracle`, this is not part of a proposal/gate sequence: it manages a running process on
this machine, not something a human rules on.

## Inputs

`sdlc sandbox up|down|reset|status [--target <t>] [--from <branch>]`, run from inside the
project's working tree. `--target` defaults to `new`.

`--from <branch>` runs the action with the working tree on that branch and puts HEAD back
afterwards, which is how an application that exists only on an unmerged proposal branch is started
from `main` (`docs/decisions/0016-binding-and-verifying-an-unmerged-proposal.md`). It is the same
borrow `verify` makes to run a slice's suite against its own build proposal — `enterBranch` and
`leaveBranch` in `src/lib/git.mjs` are what both use. Without the flag every action behaves as it
always has: whatever tree it is run in is the one compose reads.

Here `--from` takes a branch name. It is the same spelling `sdlc new --from <config.yaml>` uses for
a file to create a project from, and the two are unrelated: the argument means whatever the command
it is passed to reads, and this command reads a branch.

Reads `.sdlc/config.yaml`'s `targets.<t>`: `base_url`, `identity`, `compose` (default
`app/compose/compose.yaml`) and `seed_service` (default `seed`). Nothing here is written by the
pipeline the way `contract` writes the oracle's compose override — the compose file is the
project's own, declared once when the first slice builds the application and extended by later
slices as they need to.

`SDLC_SANDBOX_PASSWORD`, when set, is passed to every compose invocation as an environment
variable and nowhere else — never an argument, never a log line, never a file — so the sandbox
identity provider's test users can sign in without the password ever appearing on disk.

## Outputs

- `up` — builds and starts the compose project (`docker compose ... up -d --build --wait`), waits
  for the application to answer at its configured `base_url` with anything short of a server
  error, then runs `reset`. Prints `sandbox <target> up at <base_url>` and exits 0, or the compose
  failure's own tail and exits 1.
- `reset` — runs the target's `seed_service` (`docker compose ... run --rm <service>`), which puts
  the data back to what `tests/seed/manifest.yaml` describes. Prints `sandbox <target> reseeded`,
  or the service's own failure.
- `down` — `docker compose ... down -v`. Always prints `sandbox <target> down` and exits 0.
- `status` — `docker compose ... ps`, or `sandbox <target>: nothing running`.

No run-record line and no local port file the way `sdlc oracle` writes one: a sandbox target's
`base_url` is fixed in configuration rather than chosen from whatever port happens to be free, so
there is nothing about a particular run worth recording that the config does not already say.

## Checks that block

- `--from` with no branch name after it — the shell form `sdlc sandbox down --from` — is refused
  rather than read as "the tree you are standing in": a `down` that silently acted on `main` would
  report a stack torn down while the containers the branch declares went on running.
- `--from <branch>` refuses, before anything is started, when nothing resolves that branch name —
  `sandbox <action>: there is no branch <branch> in this repository` — and when the working tree is
  dirty, naming the paths, since a checkout carries uncommitted changes onto the branch and back
  again and a borrowed tree has to be returned as it was found.
- `up` refuses, before touching anything, when the target's compose file does not exist on disk —
  `<compose path> is missing; the stack profile has the application declare its local services
  there`.
- `up` fails when `docker compose up` itself fails, or when the application never answers at its
  `base_url` (`the application did not answer at <base_url>`) — health is polled every two seconds
  for up to two minutes.
- `up`'s own seed step is the same one `reset` runs on its own: a failing seed service fails the
  whole `up`, reported with the service's own tail.

## Exit criterion

`up` exits 0 once the application answers and the seed has loaded. `down` always exits 0. `reset`
exits 0 once the seed service exits 0. `status` always exits 0.

## Starting the application from a proposal branch

A slice's application lands under `app/` on `proposal/build-slice-<n>` and stays there until a
reviewer approves it at G3, so on `main` there is no compose file to start. `bind-adapter`, which
runs from `main` and pre-checks that the target answers HTTP, needs it running before it can bind
anything to the screens that slice added. `--from` is the whole of what connects the two:

```
sdlc sandbox up --target new --from proposal/build-slice-<n>
sdlc run bind-adapter --target new
# rule the bind-adapter proposal at G3
sdlc sandbox down --target new --from proposal/build-slice-<n>
sdlc run verify --slice <n>
```

Every later action against that stack takes the same flag, because compose resolves
`targets.<t>.compose` against the tree it is run in: `down`, `reset` and `status` find nothing to
read on `main` either. The stack itself does not care where HEAD goes once `up` has returned —
compose reads the build context while the images are being built, the containers run from those
images, and the seed has already loaded.

An application whose compose file bind-mounts the working tree into a container is the exception,
and the stack profile's does not: its services are built images. A project that adds a mount of its
own source is tying its containers to whatever branch is checked out, and this flag will not serve
it.

## Re-run behaviour

`up` is not idempotent the way `sdlc oracle up` is: it always rebuilds (`--build`) and always
reseeds, on every call. A build slice's compose file changes between slices, and `verify` calls
`up` once per run, so a stale image or leftover data from a previous slice's test run is never what
a fresh `up` leaves behind.

## Failure modes

- The branch named by `--from` does not exist, or the tree is dirty: refused before Docker is
  touched and before HEAD moves.
- Something dirties the tree while the action runs: HEAD is left on the borrowed branch with the
  residue visible on it rather than carried back, the paths are named, and the command exits 1 even
  where the action itself worked — the next `sdlc run` refuses anywhere but `main`, so that is the
  thing to deal with first. This is reported on the failing path too, before the failure itself is
  re-raised: a caller who reads only a docker error, fixes docker, and is then refused by the next
  `sdlc run` has been told nothing about where they are standing.
- The action fails *and* HEAD cannot be put back — a checkout blocked by something the action left
  behind: both are reported, and the failure that was already on its way out is the one raised,
  never the teardown's.
- The compose file is missing: refused before Docker is touched.
- `docker compose up` fails, or the application never comes up within its timeout: `up` exits 1
  with the compose output's own tail; whatever containers did start are left running, not torn
  down, so `sandbox down` or `sandbox status` is the next step.
- The seed service fails: `up` exits 1 naming the service and its own tail; the application is left
  running unseeded.

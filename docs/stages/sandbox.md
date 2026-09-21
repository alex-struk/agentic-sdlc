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
`app/compose/compose.yaml`), `seed_service` (default `seed`) and `depends_on` (default none — the
addresses the target is not usable without, as a map of a name to a URL). Nothing here is written by the
pipeline the way `contract` writes the oracle's compose override — the compose file is the
project's own, declared once when the first slice builds the application and extended by later
slices as they need to.

`SDLC_SANDBOX_PASSWORD`, when set, is passed to every compose invocation as an environment
variable and nowhere else — never an argument, never a log line, never a file — so the sandbox
identity provider's test users can sign in without the password ever appearing on disk.

## Outputs

- `up` — checks that every host port the compose file publishes is free, builds and starts the
  compose project (`docker compose ... up -d --build --wait`), waits
  for the application to answer at its configured `base_url` with anything short of a server
  error, waits the same way for each address the target declares under `depends_on`, establishes
  that the project's services are actually running, then runs `reset`. Prints
  `sandbox <target> up at <base_url>` and exits 0, or names what failed and exits 1.
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
- `up` refuses, before anything is started, when a host port the compose file publishes is already
  held on this machine, with the cause `environment` — `the sandbox was not started: <compose file>
  publishes a host port this machine is already using — port <n>, held by <what>`, followed by what
  to do: free it, or publish this target somewhere else, which is `targets.<t>.base_url` in
  `.sdlc/config.yaml` and the compose file that has to match it. Every held port is named at once,
  in ascending order, so freeing one and re-running does not lead straight to the next.

  The ports come from `docker compose config`, the same reading the declared-address check below
  makes. What holds a port is established only as far as it can be without privileges — a container
  of another compose project, or a listening process of this user — and where nothing answers, the
  port is named on its own. A port one of this project's *own* containers is already publishing is
  not a conflict: bringing a stack that is already running up again is the ordinary case.
- `up` fails when `docker compose up` itself fails, or when the application never answers at its
  `base_url` (`the application did not answer at <base_url>`) — health is polled every two seconds
  for up to two minutes.
- `up` fails when an address the target declares under `depends_on` never answers — `the sandbox is
  not up: its <name> dependency did not answer at <url>`, polled the same way for the same length
  of time. A target that signs its tests in through an identity provider of its own is not a usable
  sandbox until that provider answers, and a provider whose realm import failed never answers at all
  while the web tier in front of it serves normally throughout.
- `up` refuses a declared address on a port the target's compose file does not publish, with the
  cause `environment` — `no service in <compose file> publishes port <n>`, naming the key and the
  ports that are published. The ports come from `docker compose config`, not from the running
  containers: compose reports no publisher for a container while it is looping or stopped, which is
  exactly when this is asked. `sdlc checks` warns, without failing, where a target signs in through
  `sandbox-idp` and declares no `depends_on.identity`, since that is the shape `up` cannot otherwise
  settle.
- `up` fails when any service of the project is not running once both waits have passed. `--wait`
  gates only on services that declare a healthcheck, and the base-URL poll asks one service one
  question, so an identity provider that dies on startup and is restarted for ever satisfies both;
  that is a sandbox that is not up, and everything downstream signs in through it. The refusal
  names the service, what became of it and the end of its own log.
- `up`'s own seed step is the same one `reset` runs on its own: a failing seed service fails the
  whole `up`, reported with the service's own tail.

## What `up` waits for

`base_url` first, then each address under `depends_on` in the order the file declares them, each
polled every two seconds for up to two minutes until something answers with anything short of a
server error.

Each address is polled for up to two minutes, so a target declaring N of them can wait (N+1) times
that in the worst case, where nothing answers anywhere.

**The services are watched throughout every one of those waits, not only after them.** Between
attempts the project's containers are read, and a container compose has finished with — dead, or
exited non-zero — ends the wait immediately: the refusal then names the service and quotes its log,
rather than describing an address that stayed quiet while the container behind it was already gone.

Nothing else ends a wait. Every other state a container can be in is one a healthy project passes
through on its way up: `created` is a container compose has not started yet, a healthcheck reports
`unhealthy` for as long as a service is inside its start period, and a container that exits retrying
a database it depends on is restarted, loops for ten seconds and then runs — which `docker compose
--wait` returns in the middle of. Nothing in a `ps` row tells that loop from one that never ends, so
a loop is left to the address itself: if the service recovers, its address answers and the wait ends,
and if it never does, the wait ends at its ceiling and the watch below reads `restarting` and refuses
with the container named. Ending a wait early on a loop would return a build proposal for a sandbox
that was seconds from healthy, and spend one of the slice's three attempts on it.

A `ps` that could not be read does not end a wait either. While the project is coming up this
sampling is an opportunity to find a failure early and never the thing that establishes there is
none; reading every failure, and refusing on an answer nothing could parse, belongs to the watch
below, which runs once every wait has passed and nothing is still on its way up.

**Which address to declare matters.** A service often answers on its root before the thing a test
needs is loaded: a Keycloak serves HTTP while its realm import is still running, and goes on serving
if that import fails. The address to declare is the one that is only there once the service is
genuinely usable — the realm's own endpoint rather than the server root.

## Which services count as failed

Read from `docker compose ps --all --format json` after both waits: a service that is restarting,
that is dead, that has exited non-zero, or that is running while its own healthcheck calls it
unhealthy.

A service that has exited 0 has not failed. The compose file legitimately contains services that
run once and stop — a migration step, a seed step — and the exit code is what tells those from a
service that died, rather than the service's name: the file is the project's own and no list of
which of its services are transient would survive the next slice. Compose draws the line in the
same place, since `service_completed_successfully` is satisfied by exit 0 and by nothing else.

Both of compose's state fields are read: `State`, the machine-readable one, and `Status`, the
sentence written for a person (`Up 3 seconds`, `Restarting (1) 3 seconds ago`). A version that
spells one differently, or reports `running` while its own sentence says otherwise, is still caught.

The project is sampled up to three times, two seconds apart, because a crash-looping container is
reported `restarting` for the whole of its backoff and `running` for the seconds between, so a
single `ps` can catch it in the half that looks healthy. A longer backoff widens the window rather
than narrowing it. What sampling does not reach is a container that outlives the watch and dies
after it; the acceptance suite is what finds that one. Sampling stops at the first failure found,
and stops immediately when compose names no container, so a healthy stack does not pay for the wait.

**An unreadable `ps` is not a clean bill of health.** If `docker compose ps` exits non-zero, answers
in a spelling this version does not parse, or answers with records that name no container, the
sandbox is not reported up and the cause is the machine. Compose printing nothing, or an empty
array, is a different answer: it means the project has no containers, and the sandbox is up.

Anything quoted out of a container passes through a redaction of `SDLC_SANDBOX_PASSWORD` first — the
compose tail, a service's log, an unreadable `ps`, and `status`'s own output: it reaches compose
through the environment and nowhere else, and a log that is about to be printed — and, from
`verify`, written into a gate file and a commit — must not be where it lands. The redaction knows
only the value in the environment, so a password hard-coded into a project's own compose file is not
covered.

## Whose fault a failed `up` is

Every refusal carries a `cause`, one of `application` or `environment`, and `failures`, one entry
per service that failed. The discriminator is the container's state rather than whether its process
executed: a container that reached a state of its own and failed out of it ran an image this build
produced, and a failure with no such container behind it is the machine.

A missing compose file, nothing answering at the base URL, and a failing seed are the
application's. A declared address on a port the target's compose file does not publish is neither:
it is the configuration, and it is reported as `environment` so that the run halts and nothing is
written against the build.

That discrimination reaches a wrong port. A wrong host on a port the project does publish is
attributed to the application, since only the port is compared. A wrong path is too, and that is
the whole of what a wrong path amounts to here: a path that is wrong on a server that is up answers
404, which `up` accepts as an answer the same way it accepts one from the base URL. It declines to
decide at all where the compose file could not be resolved or read, and where it publishes no host
port anywhere. An image that never builds is the machine's, deliberately: compose reports a
Dockerfile defect and a registry that would not answer the same way, and no container exists to
ask. A container the kernel killed for memory exits 137 and is reported as the application's, which
is the wrong side — `ps --format json` carries no `OOMKilled` field and nothing here can know.
`docs/decisions/0017-a-sandbox-that-is-not-up.md` has the reasoning for the split and
`docs/decisions/0018-a-sandbox-is-ready-when-what-it-serves-through-answers.md` for what `up` waits
for; `docs/stages/verify.md` has what `verify` does with each.

## Exit criterion

`up` exits 0 once the application answers, every address the target declares it depends on answers,
every service of the project is running or has finished with exit 0, and the seed has loaded. `down` always exits 0. `reset`
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
- A host port the compose file publishes is already held by something else on this machine: `up`
  exits 1 naming every such port and what holds it, with the cause `environment`, and nothing of
  the project is started. The port is not something a build can see or fix, and a bring-up that
  discovers it at the end has spent a container build, every service and every wait to arrive at
  Docker's own bind error.
- `docker compose up` fails, or the application never comes up within its timeout: `up` exits 1
  with the compose output's own tail; whatever containers did start are left running, not torn
  down, so `sandbox down` or `sandbox status` is the next step.
- A service of the project is restarting, dead, exited non-zero or unhealthy: `up` exits 1 naming
  it and quoting the end of its own log, and does not seed. The containers are left running for
  the same reason.
- `docker compose ps` will not run, or answers in a form this does not read: `up` exits 1 saying
  whether the services are running could not be established, with the cause `environment`. Nothing
  is claimed about the application on an answer nothing could parse.
- An address under `depends_on` never answers, on a port the project does publish: `up` exits 1
  naming that dependency and the address, with the cause `application` — the service behind that
  port is one the build's own compose file stands up. Whatever containers did start are left
  running, and are not seeded.
- An address under `depends_on` names a port the compose file does not publish: `up` exits 1
  with the cause `environment`, naming the key, the port and the ports that are published. That
  address is a string in `.sdlc/config.yaml`, which no build writes or is shown, so returning the
  proposal would spend one of a slice's three attempts against somebody who can neither see the
  cause nor fix it.
- A container dies while one of those addresses is still being waited for: `up` exits 1 naming the
  service, what became of it, the end of its own log and the dependency whose wait it interrupted.
- The seed service fails: `up` exits 1 naming the service and its own tail; the application is left
  running unseeded.

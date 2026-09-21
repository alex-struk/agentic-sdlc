# 0017 · A sandbox that is not up, and whose fault it is

Status: accepted · 2026-09-20

## Context

`sdlc sandbox up` starts the rebuilt application's local deployment: `docker compose up -d --build
--wait`, then a poll of the target's `base_url` until something answers, then the seed service. It
prints `sandbox <target> up at <base_url>` and exits 0 once both waits have passed. `verify` calls
the same function to stand a slice's application up before it runs the acceptance suite.

**Neither wait covers the services around the one being asked.** `--wait` gates on the services that
declare a healthcheck and skips the ones that do not. The base-URL poll asks a single service one
question. A compose project whose web tier is serving and whose identity provider is dying on
startup and being restarted, over and over, satisfies both: `--wait` never looked at the identity
provider, and the base URL is not its address.

That sandbox is not up, and everything downstream is built on the claim that it is. Where
`targets.<t>.identity` names the sandbox's own provider, signing in goes through the container that
is down, so `bind-adapter` drives screens that cannot be reached and writes "this control does not
exist" across most of the surface — a file that is ruled at a gate and committed. The acceptance
suite fails the same way for the same reason, and reports it as the criteria failing.

**And the pipeline had nowhere to put the answer once it had it.** The malformed file that kills the
container is the builder's own output, on the proposal branch, but no route existed to tell the
builder so:

- `verify` classifies a slice with no adapter `unbound`, and the `unbound` path deliberately writes
  no gate file.
- `buildVerified` (`src/commands/rule.mjs`) refuses any ruling on a build proposal whose verify
  result is not `pass`, so a reviewer cannot return it either.
- `build --slice <n> --revise` requires a returned ruling to start from
  (`checkBuildRevisionSource`).

No acceptance criterion can express "the identity provider will not start", so the suite cannot fail
on it; verify cannot pass; the reviewer cannot rule; the builder cannot be told. Every route out is
shut at once.

## Decision

### `up` establishes that the services are running, and says which one is not

After the compose up and the base-URL wait, `up` reads `docker compose ps --all --format json` and
looks at every container the project has. A service that is restarting, that is dead, that has
exited non-zero, or that is running while its own healthcheck calls it unhealthy, means the sandbox
is not up. The refusal names the service, what became of it, and the end of its own log — which is
where the reason lives, since the failing service is not the one the base URL points at and nothing
else in the pipeline has read it.

**A one-shot service is told from a failed one by its exit code, not by its name.** A compose file
legitimately contains services that run once and stop: a migration step, a seed step. The pipeline
does not own that file and cannot hold a list of which services are meant to be transient. It does
not need one. A container that has exited 0 has finished whatever it was for; a container that has
exited non-zero has failed, whether it was meant to run once or for ever. Compose settles the same
question the same way: `service_completed_successfully`, the condition a dependant declares on a
one-shot, is satisfied by exit 0 and by nothing else.

**The services are watched rather than glanced at.** A crash loop spends part of every cycle
running, so a single `ps` can catch the container in the half of the cycle that looks healthy. The
project is sampled up to three times, two seconds apart, and the first sample that reports a failed
service is the answer. Sampling stops as soon as a failure is found, and stops immediately when
compose names no container at all, so nothing that is actually healthy pays for the wait.

Anything quoted out of a container — a compose tail, a service's own log — passes through a
redaction of `SDLC_SANDBOX_PASSWORD` first. The password reaches compose through the environment and
never through an argument or a file, and a container is free to print what it was handed; a log that
is about to be written into a gate file and a commit must not be where it lands.

### The result says whether the application or the machine is at fault

`sandboxUp` returns `cause` on every refusal, one of `application` or `environment`, and `failures`,
the same answer in parts so a caller can write one condition per service.

**The discriminator is whether a container of the project ran its own process.** A container that
started and then died, restarted, or went unhealthy ran something this build wrote: the fault is the
application's. A failure with no such container behind it is the machine's — a port already bound,
an image that would not pull, a daemon that is not there — and nothing the builder produced ever
executed, so there is nothing to tell a builder to fix.

Three cases are decided directly rather than by that rule:

- **A missing compose file is the application's.** It is written by the build that declares the
  application's local services, and it lives under `app/` with the rest of that build's output.
- **Nothing answering at the base URL is the application's.** That address is the one the build is
  told to publish on and the one the acceptance suite drives, whatever state the containers around
  it are in.
- **A failing seed is the application's.** The seed container is created and run against a stack
  that is already up, so what failed is the process inside it: the seed, the migrations it depends
  on, or the schema they expect.

An image that never builds is reported as the machine's. Compose reports a Dockerfile defect and a
registry that would not answer through the same failure, and no container exists to ask, so the
pipeline cannot tell the two apart. Halting on a build failure costs a re-run; returning one wrongly
spends one of the three attempts a slice has before a person is asked, so the guess goes the safe
way.

### Verify returns the build when the cause is the application, and halts when it is the machine

An `application` cause is written to the proposal's gate file exactly as a failing criterion is: the
same file, `by: runner:verify`, `held_by: runner`, one condition per failed service carrying the
service, what became of it and the end of its log. `build --slice <n> --revise` picks it up like any
other return. No verify result is written, because no suite ran, so `buildVerified` still refuses a
ruling on that proposal — the return is the only thing that moves, which is the whole of what was
missing.

An `environment` cause halts the run, non-zero, with nothing recorded against the build.

**A result that names no cause is treated as the machine's.** A missing field is not evidence, and
the two errors cost different amounts: halting costs a re-run, and returning a build wrongly spends
an attempt the slice does not get back.

### A sandbox return counts toward the three-strikes ceiling

The third return by verify escalates to the G3 policy's `escalate_to` instead of asking for a fourth
build, and a sandbox return is counted alongside a criteria return toward that same ceiling. The
ceiling exists to bound the rebuild loop, and a slice whose application has failed to start three
times running is the strongest case there is for a person to look: what is wrong may be the compose
file, the stack profile or the machine, and a fourth build would not find out which. An
`environment` halt writes no gate file, so it cannot count and cannot spend an attempt on a port
collision.

## What was considered instead

**Reading the cause out of compose's error text.** Matching `address already in use`, `pull access
denied` or `failed to solve` would classify a build failure correctly and would also classify a
registry timeout as a Dockerfile defect, because buildkit reports both with the same phrase. Container
state is a fact compose reports about the project; the text is prose that changes between versions.

**Requiring every service to declare a healthcheck.** It would make `--wait` sufficient, and it puts
the pipeline in the business of dictating the contents of a compose file the project owns — and a
build that forgot one would be reported as healthy again, which is the defect rather than a fix for
it.

**Listing the one-shot services in `targets.<t>`.** A list has to be maintained against a file that
changes with every slice, and a slice that adds a migration step and forgets the list gets a sandbox
reported as broken for doing exactly what it was asked.

**Letting the reviewer rule on an unverified build.** Relaxing `buildVerified` would open a route out
of the deadlock, and it would open it by letting a G3 approval be given on no evidence, which is what
0011 exists to prevent.

**Failing the run and leaving a person to tell the builder.** That is the state this replaces. It
halts correctly and hands the operator a container log to turn into a build instruction by hand,
once per slice, for a defect the pipeline had already diagnosed.

# 0031 · A port checked before the bring-up, not after

Status: accepted · 2026-09-21

## Context

`sandbox up` runs `docker compose up -d --build --wait` and finds out about the host ports it
publishes the way anything does: by asking the kernel for them at the moment compose binds. A
port an unrelated process on the machine is already holding — a dev server somebody left
running, a container of another project, anything — fails that bind.

The bind is the last thing that happens. Ahead of it is a container build, every image pull,
every service start and every dependency `--wait` gates on, all of which succeed. What the
operator sees is minutes of build output followed by a raw Docker error naming a port, at a
point where nothing that was started is of any use.

**Everything needed to ask the question first was already here.** `declaredPorts` reads the
host ports out of `docker compose config --format json`, for the declared-address check
(`0018`), and it reads them off the compose file rather than off the running containers
precisely because it is asked when the containers cannot answer. The ports were known before
anything started; nothing asked whether they were available.

`verify` is where this costs the most. It calls `up` once per run, so a slice's verification
becomes a full bring-up that fails at the end over a line the build did not write and cannot
see.

## Decision

### Every port the compose file publishes is probed before anything is started

Right after the compose file's own existence is checked and before `up` runs. The ports come
from the resolved compose file, not from a list — this pipeline does not own any project's
compose file and has no business knowing which ports it chooses.

Availability is tested by opening a real listening socket. Asking the OS for a list of ports in
use differs by platform and misses a port a process holds without a listener. Only `EADDRINUSE`
counts as taken: a port below 1024 refuses an unprivileged bind with `EACCES` while the Docker
daemon that would publish it is not bound by that, and reading that as "in use" would refuse a
sandbox that was going to work.

### The failure is the machine's, and it says what to do

`environment`, so the run halts rather than returning the proposal (`0017`). A port an unrelated
process holds is not something a builder can see or fix, and a return would spend one of a
slice's three attempts against a build that may be sound.

The message names every held port at once, in ascending order — an operator who frees one and
re-runs only to be told about the next has paid for the whole preflight twice — and each with
whatever could be established about what holds it. Then the two things that can be done about
it: free the port, or publish this target somewhere else, which is `targets.<t>.base_url` in
`.sdlc/config.yaml` and the compose file that has to publish what it names.

### What holds a port is established only as far as privileges allow

A container of another compose project first, because `docker` is already this command's own
dependency and a stale container is the likeliest cause; then a listening process, through
`lsof`'s field output, which prints a pid and a command name and nothing else — no user, no
path, so there is nothing in it that must not be written down. Neither probe is required to
answer. Where both are silent the port is named on its own, which is an honest unanswered
question rather than a guess, and the refusal is identical either way.

### A port this project's own containers already publish is not a conflict

Bringing a stack that is already running up again is the ordinary case, and a preflight that
refused it would make `up` runnable exactly once. Which ports this project currently holds is
read from `Publishers` on its own `ps` rows — the one question that field is the right source
for, and the opposite of `declaredPorts`: there the question is what the project publishes
whether or not anything is up, here it is what is bound right now and by whom. A crash-looping
container publishes nothing and simply does not appear, which is correct.

### A compose file that will not say what it publishes stops nothing

`null` from the resolved-config read — compose would not run, answered non-zero, or answered in
a shape this does not parse — leaves the preflight silent. Nothing is known about the ports
then, and `up` itself is where an unreadable compose file is reported.

## Consequences

- A port collision costs a sentence instead of a full bring-up, and the sentence says what to do.
- `verify` fails in seconds on a machine whose ports are busy, rather than after a build.
- Nothing is recorded against the build, and no attempt is spent, for a fault outside it.

## What was considered instead

**Parsing the bind error out of `docker compose up`'s own output.** It arrives after everything
has been spent, which is the whole defect, and it means reading an error message whose wording
belongs to Docker rather than to this pipeline.

**Choosing a free port automatically, the way `sdlc oracle` does.** An oracle's port is the
pipeline's to pick and is recorded in a local file. A sandbox's is not: `targets.<t>.base_url`
is what the acceptance suite drives and what the build was told to publish on, so moving it
silently would leave the suite driving one address and the application serving another.

**Probing the loopback interface only.** Publishing a host port binds every interface unless the
compose file says otherwise, and a port held on another interface refuses a bind that covers it,
so the narrower probe would miss exactly the collisions that stop `up`.

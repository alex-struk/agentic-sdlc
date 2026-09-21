# 0018 · A sandbox is ready when what it serves through answers

Status: accepted · 2026-09-20

## Context

`sdlc sandbox up` waits for the address in `targets.<t>.base_url`, then reads
`docker compose ps --all` three times, two seconds apart, and refuses the target if any container is
restarting, dead, exited non-zero, or running while its own healthcheck calls it unhealthy
(`docs/decisions/0017-a-sandbox-that-is-not-up.md`).

That classification is right and it does not fire on the shape it was written for. One run was
instrumented with a `ps` every three seconds:

| elapsed | identity provider | web tier |
|---|---|---|
| t+9s | `Up 3 seconds` | `Created` |
| t+12s | `Up 6 seconds` | `Up 1 second` |
| t+15s | `Up 9 seconds` | `Up 4 seconds` |
| t+18s | `Restarting (1)` | `Up 8 seconds` |

`up` exited 0 at about t+18s. The identity provider runs for nine to twelve seconds, fails its realm
import and dies. The watch is four to six seconds long and starts when the base-URL poll passes,
which the web tier satisfies at about t+12s, so every sample it took read `Up`. The container died
seconds after the window closed.

Three mechanisms miss it, each for a different reason:

- `docker compose --wait` does not gate on that service, because it declares no healthcheck.
- The watch closes before the crash.
- The acceptance suite cannot find it either: with no adapter for the target, the suite
  short-circuits before it touches the application.

**The watch is the wrong instrument for this, not a badly tuned one.** It asks whether the
containers are running. A Keycloak whose realm import failed has a container that is running, and a
realm that is not there — and even in the runs where it does die, it dies after a window that closed
because something else, on a different port, had started answering. Nothing in the sequence ever
asked the one question a sandbox with an identity provider turns on: whether a test can sign in.

## Decision

### `up` waits for the addresses the target says it cannot be used without

`targets.<t>.depends_on` is an optional map of a name to a URL:

```yaml
targets:
  new:
    base_url: http://localhost:8080
    identity: sandbox-idp
    depends_on:
      identity: http://localhost:8081/realms/sandbox
```

`up` waits for `base_url` as it always did, then for each declared address in the order the file
gives them, each polled every two seconds for up to two minutes until something answers with
anything short of a server error. A dependency that never answers is a refusal that names it: `the
sandbox is not up: its identity dependency did not answer at <url>`.

The name is the project's, not a fixed set. `identity` is the convention for the sandbox's own
provider and is the case this was written for, but a target that cannot be used without a search
index or a document store declares those the same way and gets the same sentence with its own word
in it.

**A target that declares nothing waits for exactly what it waited for before.** The key is optional
and empty by default, so every existing project behaves as it does today; only a project that says
what it depends on is held to it.

**Which address is declared decides whether this works at all.** A service usually answers on its
root before the thing a test needs is loaded, and goes on answering there if the load fails: a
Keycloak serves HTTP throughout an import that never completes. The address to declare is the one
that exists only once the service is genuinely usable — the realm's own endpoint rather than the
server root. This is the boundary this decision leaves open: the pipeline polls what it is given and
cannot tell a well-chosen address from a lazy one, so a project that declares a root URL buys itself
very little. The stage documentation says so where the key is described, and the build skill tells
the builder that every declared address has to answer once its service is usable.

### The services are watched throughout every wait, not only after it

Between poll attempts the project's containers are read, and a container that ran and is no longer
running ends the wait there. The refusal then names the service, what became of it and the end of
its own log, alongside the dependency whose wait it interrupted — because the answer to "why is
nothing answering at this address" is the container, and the container is knowable in seconds rather
than in two minutes.

This is what makes the measured run fail at the moment it goes wrong. The base URL answers at t+12s,
the wait for the identity provider's realm begins, nothing answers there, and at t+18s the sample
between two attempts reads `Restarting (1)`. The run stops with the provider named and its import
error quoted.

**Only a container that ran and stopped ends a wait — restarting, dead, exited non-zero.** The two
other states a failure can carry are ones a healthy project passes through on its way up: `created`
is a container compose has not started yet, and a service's own healthcheck reports `unhealthy` for
as long as it is inside its start period. Ending a wait on either would refuse sandboxes that were
about to be fine, which costs a run exactly as a missed crash loop does, and in the direction that
is harder to diagnose.

**A `ps` that cannot be read does not end a wait either.** While the project is coming up, this
sampling is an opportunity to find a failure early and never the thing that establishes there is
none. Refusing on an unreadable answer stays with the watch that runs after every wait has passed,
which reads every failure and is still the reading that decides.

### Nothing here rests on a timing constant

The poll interval and the two-minute ceiling are the ones the base-URL wait has always used, and
they bound the wait rather than define readiness: the wait ends when the address answers, or when a
container behind it has died. A service that takes twice as long as the one measured here is waited
for twice as long and then reported up. A service that takes a second is not waited for at all.

### The cause split is unchanged

An address that never answers is the application's, the same way `base_url` already is: the
addresses under `depends_on` are published by the same compose file the build writes, and a builder
can act on a service that will not serve. A container that ran and died during a wait is the
application's because it ran; one that was never created is the machine's. `verify` keeps returning
the build proposal for the first and halting the run for the second, with no change on its side.

## What was considered instead

**A longer settle window.** It is a number chosen against one service's startup time on one machine.
It slows every run, including the ones with nothing wrong, and the next service that takes longer
than the number defeats it again. It also would not have answered the case where the provider stays
up and serves an empty realm, which is the same failure without the crash.

**Gating on the target's identity service specifically.** `targets.<t>.identity` already names the
mechanism, and a target whose identity provider is not running is not a usable sandbox whatever the
web tier says. It would not have fired on the measured run either: the identity container read `Up`
for the whole of the window. It also adds nothing the watch does not already do, since the watch
reads every container of the project including that one. What was missing was never the container's
state; it was whether anything answered.

**Requiring a healthcheck on every service, so `--wait` is sufficient.** Rejected in 0017 and for
the same reason: it puts the pipeline in the business of dictating the contents of a compose file
the project owns, and a build that forgot one is reported healthy again.

**Polling the identity provider without a declared address, by finding its container's published
port.** It removes the configuration key and replaces it with a guess about which port on which
service is the one that matters, from a compose file the pipeline does not own. A service that
publishes two ports, or none, or that is reached through another, has no answer. The project already
declares where its application answers; declaring where its dependencies answer is the same kind of
statement in the same file.

**Racing the watch against the wait as two independent loops.** Interleaving the sample into the
poll gives the same result with one thread of control, and a race between two loops has an order
that is not reproducible in a test.

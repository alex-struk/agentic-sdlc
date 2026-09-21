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
sandbox is not up: its identity dependency did not answer at <url>`. A target declaring N addresses
can therefore wait (N+1) × two minutes in the worst case, where nothing answers anywhere.

The name is the project's, not a fixed set. `identity` is the convention for the sandbox's own
provider and is the case this was written for, but a target that cannot be used without a search
index or a document store declares those the same way and gets the same sentence with its own word
in it.

**A target that declares nothing waits for exactly what it waited for before.** The key is optional,
and a target with nothing to declare omits it rather than writing an empty map. Every existing
project behaves as it does today; only a project that says what it depends on is held to it.

**Which address is declared decides whether this works at all.** A service usually answers on its
root before the thing a test needs is loaded, and goes on answering there if the load fails: a
Keycloak serves HTTP throughout an import that never completes. The address to declare is the one
that exists only once the service is genuinely usable — the realm's own endpoint rather than the
server root. The pipeline polls what it is given and cannot tell a well-chosen address from a lazy
one, so this is a boundary the configuration has to hold up. The stage documentation says so where
the key is described, the stack profile names the endpoint its own scaffold stands up, and the build
prompt tells the builder to publish each address at the point its service becomes usable.

### The addresses reach the builder as values, not as a key to look up

The build workspace deliberately carries no `.sdlc/config.yaml` — it names the old application's
repository and commit, which a builder must not see. `targets.new.base_url` is already substituted
into the build prompt as a literal for that reason, and the declared addresses are substituted the
same way. An instruction naming a value the agent cannot reach is an instruction it has to guess at,
and the first build on this pipeline guessed a port the identity provider was already on: the health
check found something answering and called the sandbox up.

### The services are watched throughout every wait, not only after it

Between poll attempts the project's containers are read, and a container compose has finished with
ends the wait there. The refusal then names the service, what became of it and the end of its own
log, alongside the dependency whose wait it interrupted — because the answer to "why is nothing
answering at this address" is the container, and the container is knowable in seconds rather than in
two minutes.

**Only `dead` and `exited` non-zero end a wait.** Every other state a container can be in is one a
healthy project passes through on its way up. `created` is a container compose has not started yet,
and a healthcheck reports `unhealthy` for as long as a service is inside its start period.
`restarting` is the one that has to be read carefully, because it is both halves at once: a
container that exits retrying a database it depends on is restarted, crash-loops for about ten
seconds and then serves, and `docker compose --wait` returns while that is going on. Nothing in a
`ps` row tells that loop from one that will never end; only waiting does.

So a loop is left to the address. If the service recovers, its address answers and the wait ends. If
it never does, the wait ends at its ceiling, and the watch that runs after it reads `restarting` and
refuses with the container named and its log quoted. That is what happens to the measured run: the
base URL answers at t+12s, the wait for the realm's address begins and never completes, and the
refusal at the end of it names the identity provider and quotes the import error. The defect is
caught, the builder is told which service and why, and the price of drawing the line here is the
wait rather than a build proposal returned for a sandbox that was seconds from healthy.

**A `ps` that cannot be read does not end a wait either.** While the project is coming up, this
sampling is an opportunity to find a failure early and never the thing that establishes there is
none. Refusing on an unreadable answer stays with the watch that runs after every wait has passed,
which reads every failure and is still the reading that decides.

### Nothing here rests on a timing constant

The poll interval and the two-minute ceiling are the ones the base-URL wait has always used, and
they bound the wait rather than define readiness: the wait ends when the address answers, or when a
container behind it is one compose has finished with. A service that takes twice as long as the one
measured here is waited for twice as long and then reported up. A service that takes a second is not
waited for at all.

### An address this project never served is the configuration's, not the build's

`depends_on` is a string in `.sdlc/config.yaml`. No build writes that file or is shown it, so an
address that never answers because the string is wrong must not return the proposal to a builder:
that spends one of the slice's three attempts against somebody who can neither see the cause nor fix
it.

The two are told apart by the ports the project publishes, read from `docker compose config
--format json`. When the declared address asks on a port no service in that file publishes, the
address is one this project does not serve. That refusal carries the cause `environment`, names the
key, the port and the ports that are published, and records nothing against the build. When the port
is published and simply silent, the service behind it is one the build's compose file stands up, and
the cause is `application` as before.

**The ports come from the compose file and not from the running containers**, although `docker
compose ps --format json` carries a `Publishers` field that looks like the same answer. It is not:
`Publishers` is what a container has bound at this moment, and compose reports `"Publishers": []`
for a container while it is looping or stopped. That is precisely the state the identity provider in
the measurement is in, so reading the ports from there would report the case this decision exists
for as an operator's typo — no container named, no import error quoted, and a false assertion about
a configuration line that is correct. What a project publishes is a property of its compose file and
is true whether or not anything is running.

Three things fall outside this and are decided as the application's. **Only the port is compared**,
so a wrong host, or a wrong path, on a port the project does publish is not told apart from a
service failing to serve — and a wrong path is barely a case at all, since a path that is wrong on a
server that is up answers 404, which `up` accepts as an answer exactly as it does at the base URL.
**A compose file this could not resolve or could not read** settles nothing. **A compose file that
publishes no host port anywhere** settles nothing either, since there is then no set to test the
address against. All three are "nothing known", and the guess goes the way 0017 settles every other
guess here — except in this one direction, where concluding wrongly that the configuration is at
fault costs a re-run and concluding wrongly that the application is at fault costs an attempt, so an
unpublished port is called configuration on the first reading rather than the second.

The rest of the cause split is unchanged. A container that ran and died during a wait is the
application's because it ran; one that was never created is the machine's. `verify` keeps returning
the build proposal for an `application` cause and halting the run for an `environment` one, with no
change on its side.

### A key nothing writes is a key nobody fills

No template, profile or interview in this repository produced a `depends_on` before this, so the
defect would have stayed uncaught until somebody hand-edited a configuration. Three things close
that, and the first is the one that reaches projects that already exist:

- **`sdlc checks` warns** where a target's `identity` is `sandbox-idp` and it declares no
  `depends_on.identity`. The configuration already says that target signs in through a provider the
  project stands up itself, which is exactly the shape `up` cannot settle from the application's own
  address. It warns rather than fails: the key is optional, a project may have decided it has
  nothing to declare, and a check that failed would turn an addition into a requirement every
  existing project is in breach of.
- **The onboarding interview asks** for each target's addresses, so a project gets them at birth
  rather than after its first misdiagnosed run.
- **The stack profile names the endpoint** its own scaffold stands up, so the answer to the
  interview's question is written down rather than invented.

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

**Ending a wait on `restarting` seen twice in a row.** It would catch the measured provider seconds
after it started looping, and it decides a question two seconds cannot answer: a container in a
backoff reads `restarting` for most of every cycle, so two consecutive samples find a loop that is
about to recover as readily as one that will not. The interval is the poll's, which makes the rule a
two-second bet on a service's startup — the shape this decision exists to avoid.

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

**Failing `sdlc checks` on a `sandbox-idp` target with no declared identity address.** It would make
every project that has one declare it, and it would refuse configurations that were valid the day
before over a key that is optional by design. The warning puts the same sentence in front of the
same person without that.

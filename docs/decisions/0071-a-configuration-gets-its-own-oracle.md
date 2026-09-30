# 0071 · A configuration gets its own oracle

Status: accepted · 2026-09-29

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Some criteria are about a setting the application reads once at start-up: a switch that turns
every outgoing message off, a read-only mode, a feature that is off unless a variable says
otherwise. No test can reach such a setting by acting on a running service. The contract stage
writes each one into `spec/contract/observables.yaml` under `configurations:`, naming the
environment that starts the oracle in it (`select`, a variable the oracle's Compose override
interpolates, defaulting to the ordinary behaviour when unset) and a tag every test written for it
carries. The contract says those tests run only against an instance started that way, and that
the ordinary run leaves them out.

Calibration ran the whole suite against the default oracle. A test written for such a
configuration then failed there, correctly, because the default is not the configuration it is
about. The failure reached the product owner as a question with no true answer among
`defect-in-old`, `spec-wrong` and `test-wrong`, since the application, the criterion and the test
were all right, and the question was asked again after every calibration. Such a test can also
disturb the tests running beside it: one that clears the shared mail catcher before acting removes
messages other tests are waiting for.

## Decision

**The contract's `configurations:` block is read by the pipeline.** Each entry's `select` and `tag`
are the whole interface. `select` is `VARIABLE=value`, one or more, or a mapping. `tag` is a
Playwright tag. The other keys a contract writes there are for the test writer and the ruler. The
contract and test-writer skills say so, so the shape a contract writes is the shape the runner
reads.

**The ordinary run leaves every configuration's tests out; each configuration's tests run on their
own against a copy of the oracle started in it.** `calibrate` passes every tag to Playwright's
`--grep-invert` for the ordinary run. Then, for each configuration with a tagged test in the run's
scope, one at a time, it starts a copy with `sdlc oracle up --configuration <name>`, runs that tag
alone (`--grep`) against it with `sdlc oracle reseed --configuration <name>` as the reset, and
takes the copy down again whether the run succeeded or not. All the rows are one result: a spec
file some of whose tests carry a tag gets one row, worked out from every test any run reported.

**A copy, not a restart.** The configured copy is a compose project of its own, with its own
ports, database and mail catcher, started beside the default copies the way `oracle.instances`
starts several. The default copies are never stopped or reconfigured, so restoring the oracle after
a configuration's run means taking the copy down and nothing else. A run that stops part-way
leaves the default exactly as it was, and `sdlc oracle down` reaches the copy through the local
file. A copy costs a build (cached), a migration and a seed. A restart of the one default copy
would cost a restart twice and leave the default in the wrong configuration whenever a run died
between the two. The contract also asks for a separate instance.

**A configuration that cannot be routed stops the run before anything starts.** `calibrate`'s
`calibrate-configurations` pre-check refuses a configuration whose `select` names a variable the
override does not read, since the copy it starts would be the default oracle under another name.
It also refuses a tag that no test under `tests/acceptance/` carries, since that configuration's
tests are either missing or tagged differently, and a malformed entry. A variable mentioned only in
a comment of the override does not count. A run whose tag selected no test at all, though a file
carries it in its text, is refused after that run, because the tag is not on the test itself.
Against a target other than the oracle, any configuration is refused, since only the oracle is
started by this pipeline. Each of these would otherwise record the default instance's behaviour as
the configuration's, which is the failure this decision removes.

## Where this does not reach

**`verify`** runs a slice's claimed tests against the rebuilt application's sandbox, which is
started from the builder's own `app/compose/compose.yaml` (`src/sandbox/local.mjs`). The test
runner is shared, so leaving tagged tests out of that run would be one argument. But nothing
starts the sandbox in a configuration. `select` names a variable the oracle's override reads, and
the builder's compose file has no contract to read the same one. Routing verify needs that
contract first: the stack profile or the build skill telling the builder to read each
configuration's variable, and the sandbox starting a second project with it. Until then, verify leaves
those tests out of its run and reports their criteria as not tested in this environment, rather
than as failures of the build (`docs/decisions/0075-what-a-verify-charges-to-the-build.md`).

## Alternatives

**Restart the one default copy with the configuration's environment, then restart it back.**
Rejected for the reasons above: the default spends part of the run in the wrong configuration,
and a run that dies between the two restarts leaves it there.

**Let each test detect the configuration and skip itself.** Rejected: nothing a running service
shows says which configuration it was started in, and a test that skips itself records no result,
which the runner reports as a failure.

**Record such criteria as not-testable.** Rejected: they are testable, with the right instance.

## What would reverse it

A target that can change such a setting while running, through an administrative surface the
contract names, would make the separate copy unnecessary for that setting. That setting would be
an observable a test acts on, not a configuration. If configurations grow numerous enough that a
copy each makes calibration slow, several could share a copy when their `select`s do not conflict.

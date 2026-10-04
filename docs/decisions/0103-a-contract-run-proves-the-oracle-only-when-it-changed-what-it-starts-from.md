# 0103 · A contract run proves the oracle only when it changed what the oracle starts from

Status: accepted · 2026-10-04

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A contract run writes the Compose override the oracle starts with and the seed it loads, and nothing
the agent can read says whether the application will start from them, so the run brought the oracle
up to find out and took it down again before it finished (`docs/stages/contract.md`). It did so on
every run.

Most contract runs in the Build phase answer a missing test with a page, an action or a seeded
record, and change neither the override nor the seed. Such a run started an oracle from exactly
what it started from before and proved nothing new. Since the oracle stays up between steps
(`docs/decisions/0101`), taking it down also made the next step on the oracle's target build its
images, migrate its databases and load the seed into every copy again: on one project, about three
minutes after most contract runs.

## Decision

**The oracle is proved only when the run changed the override or the seed.** The agent then takes
any running copy down first, so the oracle starts from what it wrote, proves it as before, and
takes it down again when it is done, whatever the outcome.

**A run that changed neither leaves the oracle as it found it,** running or not, and says in its
journal that neither changed.

## Consequences

- An oracle running for the stages either side of a contract run stays running through it.
- A change to what the oracle starts from is still proved before its proposal is ruled, and the
  oracle the next step uses is started again from `main`.
- Whether a run changed the override or the seed is the agent's account; the proposal's diff shows
  it to the ruler.

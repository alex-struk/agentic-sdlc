# agentic-sdlc

A pipeline in which agents carry out software delivery stages while a small number of policy
gates hold human judgement, so that every piece of work traces back to a testable, permanent
criterion. It installs into a project repository by reference to this repository rather than by
being forked, so a team can adopt it, run it, and upgrade it on its own schedule. This repository
holds the pipeline itself — the `sdlc` CLI, the structural checks, the config schema, and the
project templates — and never a particular project's own code.

## Install

```
npm ci
```

Developed and tested on Node 24 (the version CI runs, and the one in `.nvmrc`); `engines`
allows 22 or later.

## Commands

- `sdlc new <dir> --from <config.yaml> | --interactive | --answers <brief.md>` — create a project
  repository from a saved configuration or an onboarding interview, then run `init`.
- `sdlc init [dir]` — pin the lockfile, install the configured skill packs, and generate the CI
  caller workflow for an existing project.
- `sdlc checks [dir] [--self] [--json]` — run the structural checks (config, layout, constitution,
  egress); `--self` checks this pipeline repository itself.
- `sdlc doctor [dir]` — check that required and optional tools, the agent deny list, the egress
  name list, and the project configuration are all in place.
- `sdlc propose <name> --gate G<n> --question "..." --recommendation "..." [--tier HIGH]` — open a
  decision as a `proposal/<name>` branch with a decision page. `--tier` records the proposal's risk
  tier on that page; `HIGH` and `CRITICAL` make the gate's persona agent escalate to a human
  instead of ruling.
- `sdlc rule <name> approve|return --by <role>` — record a verdict on an open proposal and merge it
  into `main` on approval.
- `sdlc rule <name> --by agent:<persona>` — let the gate's own persona agent rule instead of a
  human, with a recorded rationale and mandatory escalation on HIGH/CRITICAL tier or a brief that
  says to always escalate.
- `sdlc rule --pending` — rule every open proposal whose gate is held by a persona agent, oldest
  branch first.
- `sdlc run <stage> [--slice N] [--domain X] [--dry-run]` — run one pipeline stage as an isolated
  headless session: materialise its workspace, run pre-checks, let the agent work, run
  post-checks, and commit or open a proposal.
- `sdlc resume [--again]` — continue a run an interrupted process left mid-stage, re-judging
  whatever the agent session left behind against the stage's post-checks.
- `sdlc status [dir]` — regenerate the generated state site (`site/index.md`, `site/gates.md`,
  `site/runs.md`, `site/journal.md`, `site/proposals/*.md`).

Run `sdlc help` (or any unrecognised command) to print this list from the CLI itself.

## Tests

```
npm test          # runs the test suite (node --test)
npm run check     # runs the egress self-check over this repository
```

One test exercises the onboarding interview against a live `claude` session and is skipped by
default. Run it explicitly with:

```
SDLC_LIVE=1 npm test
```

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — the runner loop, the two repositories, and
  where state lives.
- [`docs/stages/`](docs/stages) — one contract per command: purpose, inputs, outputs, checks, exit
  criterion, re-run behaviour, and failure modes.
- [`docs/config.md`](docs/config.md) — the configuration reference.
- [`docs/dependencies.md`](docs/dependencies.md) — the dependency register.
- [`docs/decisions/`](docs/decisions) — architecture decision records.
- [`docs/specs/`](docs/specs) — the full design specification (the single document in that
  directory).
- [`docs/poster/`](docs/poster) — a visual walkthrough of the pipeline.

## Roadmap

The phases, their stages and their status: [docs/roadmap.md](docs/roadmap.md).

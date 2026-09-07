# Architecture

This document explains how the pieces in this repository fit together: the runner loop, the two
repositories a pipeline run involves, where state lives, and one deliberate quirk in the CLI's
module loading. The full design is the single document under
[`docs/specs/`](specs) (section 8 covers the runner in more depth); a visual walkthrough is
[`poster/walkthrough.md`](poster/walkthrough.md) alongside `poster/pipeline-poster.svg`.

## The runner loop

A stage's work has a fixed shape: materialise a workspace, run pre-checks, let an agent act inside
that workspace, run post-checks, open a proposal, and record what happened. The commands in this
repository are the primitives that shape composes into:

- **Materialise workspace** — `sdlc new` creates the project repository, copies `templates/project/`,
  and writes `.sdlc/config.yaml`; `sdlc init` (which `new` also calls) pins the lockfile, installs
  the configured skill packs, and generates the CI caller workflow. Together they produce the
  directory an agent will work in and the record of exactly what version of the pipeline and which
  skill pack commits it was built with.
- **Pre-checks and post-checks** — `sdlc checks` runs the same structural checks (config, layout,
  constitution and egress always; criteria and criteria-index once `spec/domains` exists) before
  and after a stage does its work, locally and in CI, because
  `runChecks(projectDir, opts) -> results[]` is a pure function of the directory: it takes no
  action, so calling it twice around a stage's work is exactly as sound as calling it once.
- **Agent** — `sdlc run <stage>` (`docs/stages/run.md`) is the dispatcher: it materialises the
  stage's workspace (`src/runner/workspace.mjs`), runs the stage's pre-checks, and calls
  `runAgent` (`src/runner/executor.mjs`), which spawns `claude -p` — or, in CI, whichever cloud
  executor the configuration names, and in tests a mock executor selected by
  `SDLC_EXECUTOR=mock` — confined to the workspace by three mechanisms: an isolated
  `CLAUDE_CONFIG_DIR` holding only a link to the operator's credentials
  (`docs/decisions/0004-isolated-stage-sessions.md`), `.claude/settings.json`'s deny list, which
  blocks destructive commands and reading secrets outright, and
  `templates/hooks/implement-guard.sh`, which reads `SDLC_STAGE` and blocks edits outside the paths
  that stage owns (see `docs/stages/init.md` for both tables). Phase 1a ships one implemented
  stage, `probe`, which proves this whole loop end to end; every real pipeline stage
  (`archaeology`, `design`, `build`, …) is a named stub that throws until its own task lands. The
  onboarding interview behind `sdlc new --interactive` and `sdlc new --answers` runs a separate,
  narrower agent turn constrained to the `Write` tool and one output file, outside this loop.
  `sdlc resume` (`docs/stages/resume.md`) continues a run a crashed process left mid-stage, reading
  `.sdlc/run-state.json` for which stage and context it was on and re-judging whatever the agent
  session left behind against the same post-checks.
- **Proposal** — `sdlc propose` opens a `proposal/<name>` branch with a decision page
  (`.sdlc/proposals/<name>.md`) naming the gate, the question, and the recommendation.
  `sdlc rule` records a verdict against the policy in `.sdlc/config.yaml`, checks that the caller
  actually holds (or is the escalation target for) that gate, and merges the branch into `main` on
  approval. A gate whose `holder` is `agent:<persona>` can also be ruled by that persona directly
  (`sdlc rule <name> --by agent:<persona>`, or in a batch with `sdlc rule --pending`): a short agent
  turn reads the persona's brief (`.sdlc/personas/<persona>.md`), the proposal, the diff and the
  checks, and answers with a verdict, a rationale and any conditions, escalating on its own when the
  tier is HIGH/CRITICAL or the brief says to always escalate on this gate.
- **Run record** — every command that changes state calls `appendRun`, which appends one line to
  `.sdlc/runs/<date>.md`. A stage's own agent turn also gets a journal entry
  (`.sdlc/journal/<NNN>-<stage>.md`, `src/runner/journal.mjs`) in the agent's own words, with the
  turn's cost, turn count and session id in its front matter. `sdlc status` folds every run-record
  file, the gate log, the journal and the criteria index into the generated state site, which is
  now a tracked artifact: `site/*.md` is committed alongside whatever else a run or a ruling
  changed, not left as a generated file nobody commits.

## The two repositories

| Repository | Holds | Edited by |
| --- | --- | --- |
| Pipeline repository (this one) | The `sdlc` CLI, checks, templates, the config schema, and this documentation | People, by hand |
| A project repository | A project's constitution, configuration, spec, contract, tests, application code, evidence, and generated state site | Only ever produced and changed by the pipeline |

**The project repository is only ever produced by the pipeline.** `sdlc new` is the only thing
that creates one, and it always finishes by calling `sdlc init`. Nothing in this repository is
copied into a project except templates the project is expected to fill in, and nothing in this
repository's schema, checks, skills or templates may name a specific product the pipeline is used
to build — the fixture project this pipeline tests itself against is a deliberately unrelated
application, and it is the guard against a pipeline that only works for one product.

## Where state lives

There is no database. All state is git plus files:

- **Git branches.** `main` holds the project's accepted state. One `proposal/<name>` branch exists
  per open decision, created by `sdlc propose` and merged into `main` by `sdlc rule approve`; a
  `return` verdict leaves its branch open for another round.
- **`.sdlc/gates/<name>.yaml`** — one file per ruled proposal: which gate, the verdict, who ruled,
  whether that ruling was agent-held or human, and when — plus, for an agent-held ruling, the
  persona's own rationale and any conditions it attached.
- **`.sdlc/journal/<NNN>-<stage>.md`** — one entry per stage agent turn, numbered in order, holding
  the agent's own account of what it did in its own words, with the turn's cost, turn count and
  session id recorded in front matter.
- **`.sdlc/runs/<date>.md`** — one append-only file per day, one line per command that changed
  state.
- **`.sdlc/run-state.json`** — project-local scratch, never committed, naming which stage a run is
  on and how far it got (`agent` or `post-checks`); `sdlc resume` reads it to continue a run an
  interrupted process left mid-stage, and it is cleared once that stage finishes.
- **`.sdlc/config.yaml`** — the only hand-authored (or interview-produced) state file; everything
  else under `.sdlc/` is generated from it.
- **`.sdlc/lock.json`** — the pinned pipeline commit and the resolved skill pack commits, written by
  `sdlc init`.
- **`.sdlc/packs/<name>`** and **`.claude/skills/<skill>`** — cloned skill pack repositories and the
  skill directories copied out of them.
- **`.sdlc/personas/<name>.md`** — one brief per persona (`ux-reviewer`, `tech-lead`,
  `product-owner`, `architect`, `reviewer`), installed by `sdlc init` and read by `sdlc rule` when a
  gate's holder is that persona.
- **`site/`** — generated, and now a tracked artifact rather than hand-edited or ignored: a run or
  a ruling folds the freshly regenerated `site/*.md` into the same commit it makes. `sdlc status`
  regenerates `index.md` (a criteria coverage table and cost/ruling totals), `gates.md` (the gate
  log), `runs.md` (the run log), `journal.md` (the stage journal) and `proposals/<name>.md` (one
  page per proposal, ruled or open) from everything above.

## The circular-import loader in `src/cli.mjs`

`src/cli.mjs` exports a shared `COMMANDS` registry object, and each command module
(`src/commands/new.mjs`, `init.mjs`, and so on) imports that object back and assigns its own entry
onto it — a genuine import cycle. `cli.mjs` loads those modules dynamically, inside a
`loadCommands()` function called from `main()`, rather than through static imports at the top of
the file.

This is deliberate, not an oversight. A static `import "./commands/new.mjs"` at the top of
`cli.mjs` would be evaluated before `cli.mjs`'s own `export const COMMANDS = {}` line runs, because
ES modules always finish evaluating a module's imports before running that module's own body,
regardless of where the import statement appears in the file. `new.mjs` would then try to assign
onto a `COMMANDS` that does not exist yet, throwing "Cannot access 'COMMANDS' before
initialization" — and this bites specifically when `cli.mjs` is the entry point, which it is every
time `bin/sdlc.mjs` runs. Loading the command modules with a dynamic `import()` call inside a
function defers their evaluation until after `cli.mjs` has finished running its own top level, by
which point `COMMANDS` is already the real object the command modules expect to find.

# Architecture

This document explains how the pieces in this repository fit together: the runner loop, the path
from a ratified spec to a measured result, the acceptance harness a project owns, the two
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
  constitution and egress always; criteria and criteria-index once `spec/domains` exists; separation
  and generated once `tests/` exists, and tests once there is a criteria index for them to be tied
  to) before
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
  that stage owns (see `docs/stages/init.md` for both tables). `probe` proves this whole loop end to
  end without being one of the pipeline's own stages; `intent`, `archaeology`, `ratify`, `contract`,
  `derive-tests`, `bind-adapter` and `calibrate` are implemented, and every stage after them
  (`design`, `build`, …) is a named stub that throws until its own task lands. A stage may also
  declare an MCP server (`bind-adapter`'s browser), an explicit tool allow-list, extra environment
  variables and a `prepare` hook that writes into the workspace before the session starts. The
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

## From a ratified spec to a measured result

Once a domain's criteria carry permanent ids, the pipeline turns them into an acceptance suite and
runs that suite against the old application. Four groups of modules do it, and they are kept apart
on purpose: what a test may *say*, what a test may *not* say, what the suite runs *against*, and
what the results *mean*.

- **The contract, and the types generated from it** — `src/spec/surface.mjs`. `loadContract(dir)`
  reads `spec/contract/surface.yaml` (pages, each with actions and observations),
  `personas.yaml`, `observables.yaml` and the seed manifest `tests/seed/manifest.yaml`, reporting a
  malformed one as an error rather than reading it back as empty. `generateTypes(contract)` turns
  that into three TypeScript files under `tests/generated/` — a `Surface` interface with one method
  per action and observation, the persona table, and the seed handles — and `writeGenerated(dir)`
  writes them. The output is byte-stable for the same input, which is what lets `checkGenerated`
  treat any difference as drift. This is the vocabulary a test is allowed to use: a test names a
  page action and a seed handle, and cannot name a locator or a URL because the generated types
  offer none.
- **The blindness checks** — `src/checks/separation.mjs`, `src/checks/tests.mjs`,
  `src/checks/generated.mjs`. `runChecks` adds separation and generated once the project has a
  `tests/` directory, and tests once it also has `spec/criteria-index.json` — a project with tests
  but no ratified index has nothing to tie a provenance header to.
  `checkSeparation` reads the test and adapter sources and refuses the mixtures the design forbids:
  an `expect` or a `test(` inside an adapter, a locator, a route literal, a `page.` call or an
  import of `app/` or an adapter inside a test. `checkTests` reads every spec file's two-line
  provenance header, ties it to an accepted criterion at a version, reports a criterion whose
  version has moved on as `stale` and a version ahead of the index as a failure, and decides from
  the file's own last commit subject whether its provenance is `blind` or `unverified` — an
  unverified file needs a named attestation at LOW or STANDARD tier and fails outright at HIGH or
  CRITICAL. It also exports `coverage(projectDir, domain)`, which `derive-tests` uses as a
  post-check and `status` renders on the coverage board. `checkGenerated` re-runs the generator and
  compares, so a hand-edited `tests/generated/` file is a finding rather than a silent divergence
  between what a test thinks the surface is and what the contract says.
- **The oracle** — `src/commands/oracle.mjs` with `src/oracle/`. `ports.mjs` finds free ports and
  reads and writes `.sdlc/oracle-<target>.local.yaml`, the untracked record of what this machine
  actually bound. `compose.mjs` is the single place `docker compose` is called from — it also holds
  the health waits and the seed loader, and it is where `SDLC_ORACLE=mock` short-circuits, so the
  whole lifecycle is testable without Docker. `paths.mjs` resolves the compose override the
  `contract` stage writes. `sdlc oracle up` brings the supporting services up, applies migrations,
  loads `tests/seed/*.sql` in name order, starts the application and waits for it to answer;
  `down` tears it down and removes the local file; `status` prints both.
- **Running the suite, and reading the results** — `src/testrun/playwright.mjs` and
  `src/stages/calibrate.mjs`. `runSuite` installs the harness's dependencies if it must, runs
  Playwright with the target's URL and mail API in the environment, and maps the JSON report onto
  one row per criterion: `pass`, `fail`, `unbound` (the adapter reported a member it could not
  bind), `stale` or `not-testable`. `SDLC_TEST_RUNNER=mock` reads a canned row set instead.
  `calibrate` is the stage around it: it applies any calibration ruling not yet applied, runs the
  suite, writes `tests/results/<target>/<date>.json` and `latest.json`, and opens a G1 proposal
  listing every failure that has no ruling yet. `src/spec/redo.mjs` is the small file that carries
  a `test-wrong` ruling forward — `tests/acceptance/redo.yaml`, written by `calibrate` and cleared
  by the `derive-tests` run that answers it.

`src/stages/shared.mjs` holds what more than one of these stages needs — the skill-path helper, the
follow-up-proposal bookkeeping (`followUpState`, shared by `ratify`'s and `calibrate`'s follow-up
loops) and the `--target` validation `bind-adapter` and `calibrate` both do — so a stage never has
to import a sibling stage to reach a helper.

## The acceptance harness the project owns

`tests/` in a project repository is split between files the pipeline owns and files the project
owns, and the split is what makes a blind derivation possible.

The pipeline owns the harness: `tests/package.json`, `tsconfig.json`, `playwright.config.ts`,
`README.md` and `tests/fixtures/` are installed by `sdlc init` and refreshed by it, and
`tests/generated/` is written by the generator. `workspace.mjs` exports that list as `HARNESS` and
carries it into the workspaces that need it, which is how a `derive-tests` session gets a compiling
`import { test, expect, persona, seed }` without ever seeing an adapter or the application.

The project owns everything else: `tests/acceptance/<domain>/<ID>.spec.ts` (one file per criterion,
written by `derive-tests`), `tests/acceptance/not-testable.yaml` and `attestations.yaml`,
`tests/adapters/<target>/` (written by `bind-adapter`), `tests/seed/` (written by `contract`), and
`tests/results/<target>/` (written by `calibrate`). `init` installs the two YAML files and the seed
manifest only when they are absent, because once written they are project content rather than a
template.

The two halves never meet in one workspace. `spec-only` — `derive-tests`'s workspace — carries the
whole of `spec/`, the seed, the harness and `tests/acceptance`, and no adapter; `blind-adapter` —
`bind-adapter`'s — carries `spec/contract` only, the seed, the harness and `tests/adapters`, and no
`tests/acceptance`, no `app/` and no `sources/`. Neither session can read the other's work, so a
test cannot be written to the adapter's shape and an adapter cannot be bound to make a particular
test pass.

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
- **`tests/`** — the acceptance suite: a harness `sdlc init` installs and refreshes, one spec file
  per criterion, one adapter directory per target, the synthetic seed and its manifest, and one
  results file per calibration run under `tests/results/<target>/` with `latest.json` beside the
  dated ones. `tests/node_modules/`, `tests/test-results/` and `tests/playwright-report/` are
  ignored — the suite's own scratch, regenerated by every run.
- **`.sdlc/oracle-<target>.local.yaml`** — untracked, written by `sdlc oracle up`: the ports it
  chose on this machine, the base URL and mail API those ports resolve to, and the compose project
  name it started them under. `bind-adapter` and `calibrate` read it to find the running oracle.
  Nothing machine-local is committed, which is why this is a local file rather than a config key.
- **`.sdlc/oracle/compose.yml`** — tracked, written by the `contract` stage and ruled at G1: the
  override that publishes the old application's ports as `${SDLC_APP_PORT}`, `${SDLC_DB_PORT}` and
  `${SDLC_MAIL_API_PORT}` and adds the mail catcher (`docs/decisions/0006-contract-stage-and-oracle.md`).
- **`site/`** — generated, and now a tracked artifact rather than hand-edited or ignored: a run or
  a ruling folds the freshly regenerated `site/*.md` into the same commit it makes. `sdlc status`
  regenerates `index.md` (a criteria coverage table, now with a tests column and a column of
  calibration results per domain, and cost/ruling totals), `gates.md` (the gate log), `runs.md` (the
  run log), `results.md` (one entry per calibration run, with its counts and the open calibrate
  proposal if there is one), `journal.md` (the stage journal), `criteria/<domain>.md` (one page per
  domain, each criterion with its test and its result against the oracle) and `proposals/<name>.md`
  (one page per proposal, ruled or open) from everything above.

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

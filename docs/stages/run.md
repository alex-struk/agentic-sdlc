# Stage: `run`

## Purpose

Run one pipeline stage end to end: materialise the workspace the stage is allowed to see, run its
pre-checks, let an isolated agent session do the stage's work, run its post-checks, and record what
happened — a journal entry, a run-record line, the regenerated state site, and either a direct
commit or an opened proposal, depending on whether the stage holds a gate.

## Inputs

`sdlc run <stage> [--slice N] [--domain X] [--dry-run] [--again]`, run from inside the project's
working tree. `<stage>` must be a name in the stage registry (`src/stages/registry.mjs`); phase 1a
ships one implemented stage, `probe`, which proves the runner itself, plus every real pipeline
stage (`archaeology`, `design`, `build`, …) as a named stub that throws `stage <name> is not
implemented yet` before touching the working tree. `--slice` and `--domain` are threaded into the
stage's context (`ctx.slice`, `ctx.domain`) for a stage's own `prompt(ctx)` to use; `probe` ignores
both. `--dry-run` prints the stage's prompt and the path of the scratch file holding its skill
text, then exits without writing anything. `--again` is accepted for symmetry with `sdlc resume
--again` and does nothing here — `resume` is the only place a re-run decision is made.

## Outputs

- `.sdlc/run-state.json`, written with `phase: "agent"` right before the agent session starts (not
  on a dry run) and cleared once the stage finishes successfully. See `sdlc resume` below for what
  reads it.
- One journal entry, `.sdlc/journal/<NNN>-<stage>.md` (`sdlc resume`'s contract below shows the
  shape).
- An appended `.sdlc/runs/<date>.md` line: `run <stage>: ok, cost <usd>, turns <n>` on success, or
  `run <stage>: pre-checks failed`, `run <stage>: agent turn failed`, or a post-check failure
  recorded by the stage's own failure commit (see "Failure modes").
- The regenerated state site (`site/index.md`, `site/gates.md`, `site/runs.md`, and now
  `site/journal.md` and `site/proposals/*.md`), rebuilt by `buildSite` on every successful run so
  it is never more than one run stale.
- If the stage has no gate (`probe` today): everything the agent changed, plus the journal, run
  record and site, staged by name and committed on `main` as `stage(<stage>): <title>`.
- If the stage holds a gate: the same files, handed to `sdlc propose` as the paths a proposal is
  allowed to find already dirty, so they land in the proposal's own commit on a new
  `proposal/<name>` branch instead of on `main` directly (see `docs/stages/propose.md`). No shipped
  stage does this yet; the mechanism is exercised by `finishStage`'s tests.

## Workspace the agent sees

`src/runner/workspace.mjs` materialises one of three modes, named by the stage:

- **`project`** — the agent runs directly in the project's own working tree (`ws.dir ===
  projectDir`); nothing is copied and nothing is collected back. This is what `probe` uses.
- **`spec-only`** — a fresh temporary directory populated by `git archive HEAD` over `spec/`,
  `tests/seed/`, `constitution.md` and `.sdlc/config.yaml` (only the paths that exist), plus an
  empty `tests/acceptance/` directory. The archive reads committed content only, so an uncommitted
  edit in the project neither leaks into the workspace nor is visible there.
- **`blind-adapter`** — the same archive mechanism over `spec/contract`, `tests/adapters`,
  `tests/seed` and `constitution.md`. Materialising either non-`project` mode throws
  `blindness violated: app/ present in <mode> workspace` if `app/` somehow ended up in the
  workspace — the check that a blind stage never sees the application it is meant to be blind to.

For a non-`project` workspace, whatever the stage's `collect` list names is copied back into the
project directory after the agent session ends, and the temporary directory is removed either way
(`ws.cleanup()`, in a `finally`, whether the stage succeeded or threw).

Inside the workspace, the agent session itself is isolated from the operator's own Claude Code
configuration — see `docs/decisions/0004-isolated-stage-sessions.md` for what that means and why.
The project's own `.claude/settings.json` deny list and the `implement-guard` `PreToolUse` hook
(`docs/stages/init.md`) still apply, scoped by the `SDLC_STAGE` environment variable the executor
sets.

## Checks that block

- The working tree must be clean before anything else happens (`assertCleanTree`): `run` is going
  to commit on the caller's behalf, so it refuses to start over uncommitted work already there.
- `<stage>` must be a name in the registry, and `stage.implemented` must be `true`.
- The project's `.sdlc/config.yaml` must load and validate.
- The stage's own `preChecks(projectDir, ctx)` must all pass. `probe` declares none; a stage that
  does declare pre-checks fails before a workspace is ever materialised.
- The stage's own `postChecks(projectDir, ctx)`, run after the agent session, must all pass —
  `probe`'s post-check requires `app/PROBE.md` to exist and contain the sentence "the runner
  works".

## Exit criterion

Exits 0 and prints `run <stage>: ok`, with `(opened <branch>)` appended when the stage opened a
proposal. A dry run exits 0 having printed the prompt and skill path only. Pre-check or post-check
failure exits 1 and prints `run <stage>: failed` followed by the check messages.

## Re-run behaviour

Re-running the same stage against a project that already carries a passing run is not a no-op: it
produces a new, separately numbered journal entry (`002-<stage>.md`, and so on) and a new run-record
line every time, because a stage's work is judged fresh by its post-checks on each run rather than
compared against what a previous run already committed. When a stage's own output happens to come
out byte-identical to what is already on `main` (the mock-executor tests exercise this for `probe`),
only the new journal entry, run record and site regeneration end up dirty and committed — the
identical file is simply not part of what changed. A failing pre-check is safe to hit repeatedly:
its own failure is committed to the run record before `run` returns, so the working tree is clean
again for the next attempt.

## Failure modes

- The working tree is dirty at the start: throws before any check or workspace runs, listing the
  dirty paths.
- Unknown stage name: throws `unknown stage: <stage>`.
- Stage not yet implemented: throws `stage <stage> is not implemented yet`.
- Invalid `.sdlc/config.yaml`: throws listing every schema error.
- A pre-check fails: `run` commits `run(<stage>): pre-checks failed` to the run record (so a later
  `run` is not blocked by this run's own leftover state) and returns `{ ok: false, messages }`
  without materialising a workspace or starting an agent session.
- The agent session itself fails to run at all (the `claude` binary is missing, authentication is
  not in place, or its process exits with no JSON on stdout): `runAgent` throws
  `claude failed: <stderr>` or `claude returned non-JSON output: <excerpt>`, and `run` propagates
  that error — nothing is committed, and `.sdlc/run-state.json` is left at `phase: "agent"` for
  `sdlc resume` to find.
- The agent session runs but reports failure (an error result, the `--max-turns` ceiling reached):
  post-checks are not run at all, since a turn that already said why it failed should not have
  that account replaced by a check message about a file it never got to write. `run` writes a
  journal entry titled `<stage>: agent turn failed` holding the turn's own text and its cost,
  turn count and session id, appends `run <stage>: agent turn failed` to the run record, commits
  `stage(<stage>): agent turn failed` with only those two staged, and returns `{ ok: false,
  journal, messages: [<the agent's text>] }`. Anything the session did leave in the working tree
  stays there, untracked and visible.
- A post-check fails: `finishStage` writes a journal entry recording the agent's own text plus the
  check messages, commits `stage(<stage>): post-checks failed` with only the journal and run record
  staged (everything the agent actually produced is left untracked in the working tree, visible in
  `git status`, for a person to inspect), and returns `{ ok: false, journal, messages }`.
- A non-`project` workspace ends up containing `app/`: throws `blindness violated: app/ present in
  <mode> workspace` before any agent session starts.

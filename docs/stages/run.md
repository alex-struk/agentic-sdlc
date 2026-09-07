# Stage: `run`

## Purpose

Run one pipeline stage end to end: materialise the workspace that stage is allowed to see, run its
pre-checks, let an isolated agent session do the work, run its post-checks, and record what
happened — a journal entry, a run-record line, and either a direct commit on `main` or an opened
proposal, depending on whether the stage holds a gate.

## Inputs

`sdlc run <stage> [--slice N] [--domain X] [--target old|new] [--stale] [--dry-run] [--again]`, run
from inside the project's working tree, on `main`.

`<stage>` must be a name in the stage registry (`src/stages/registry.mjs`). Implemented today:
`probe` (which proves the runner itself and is not one of the pipeline's own stages), `intent`,
`archaeology`, `ratify`, `contract`, `derive-tests`, `bind-adapter` and `calibrate`. Every other
pipeline stage (`design`, `build`, …) is a named stub that throws `stage <name> is not implemented
yet` before touching the working tree.

`--slice`, `--domain`, `--target` and `--stale` are threaded into the stage's context as
`ctx.slice`, `ctx.domain`, `ctx.target` and `ctx.stale`. `archaeology`, `ratify` and `derive-tests`
all require `--domain <d>`, and `<d>` must be one of `config.project.domains`; `probe` and `intent`
ignore all four. `--target` names the running application a stage acts against and reaches
`ctx.target` as that string, or `undefined` when omitted: `bind-adapter` requires it, and
`calibrate` defaults it to `config.oracle.target` when it is left out. `--stale` is a boolean flag
and reaches `ctx.stale` as `true`, defaulting to `false`; `derive-tests` reads it as "write only the
tests whose criteria have moved on since".

`--dry-run` writes nothing at all. For an agent stage it prints the prompt the stage would send,
the path of the scratch file holding its skill text, the resolved workspace mode, `prepare:
skipped on dry run` when the stage has a `prepare` hook, `mcp: <server names>` when the stage's
`mcp` returns servers, and `env: <variable names>` when its `env` returns any — names only, never
values, since a dry run's output is meant to be shared freely and `env` exists precisely to carry
things like API keys into the session. For a stage with no agent turn it prints one line saying
so. `--again` is accepted for symmetry with `sdlc resume --again` and does nothing here — `resume`
is the only place a re-run decision is made.

## Outputs

- `.sdlc/run-state.json`, written with `phase: "agent"` immediately before the agent session
  starts, rewritten to `phase: "post-checks"` when the agent returns, and cleared once the stage
  finishes successfully. Never written on a dry run, and never written by a stage with no agent
  turn — there is no mid-turn crash for `sdlc resume` (`docs/stages/resume.md`) to pick up.
- One journal entry, `.sdlc/journal/<NNN>-<stage>.md`, carrying the agent's own text and the
  turn's cost, turn count and session id.
- An appended `.sdlc/runs/<date>.md` line: `run <stage>: ok, cost <usd>, turns <n>` on success, or
  one of the failure lines under "Failure modes".
- **If the stage has no gate** (`probe`, `ratify`, `calibrate`): everything the agent (or, for a
  stage with no agent turn, `execute`) changed, plus the journal, the run record and the regenerated state site
  (`docs/stages/status.md`), staged by name and committed on `main` as `stage(<stage>): <title>`.
- **If the stage holds a gate** (`intent` at G0, `archaeology` at G1): the same files minus the
  site, handed to `sdlc propose` as the paths a proposal is allowed to find already dirty, so they
  land in the proposal's own commit on a new `proposal/<name>` branch instead of on `main`
  (`docs/stages/propose.md`). The run leaves the working tree checked out on that branch.

  **A gated stage builds no state site.** Every page of the site is regenerated whole from the
  whole project, so a copy carried on a proposal branch would differ from every other open
  proposal's on every page and the second merge would conflict on all of them, for content neither
  proposal is about. Regenerating it is the ruling's job, on `main` (`docs/stages/rule.md`).

## Workspace the agent sees

A stage names its workspace mode as `stage.workspace`, either a plain string or a function of
`config`, `(config) => mode`. `runStage` resolves it exactly once, right after `config` loads and
before `materialise` is called, so a function is never evaluated twice and never leaks into
`materialise` itself (which only knows the four mode strings below). Every later use of the mode —
the run-state a crashed session leaves for `sdlc resume` to read, the dry run's `workspace: <mode>`
line — reads this same resolved value. `resume` resolves it the same way, against the config it
loads itself, so a resumed run and a fresh one always agree on which mode a stage used.

`src/runner/workspace.mjs` materialises one of four modes, named by the stage:

- **`project`** — the agent runs directly in the project's own working tree (`ws.dir ===
  projectDir`); nothing is copied and nothing is collected back. `probe`, `intent`, `contract`,
  `ratify` and `calibrate` use this.
- **`with-sources`** — the project's own working tree again, with one addition made before the
  session starts: the old application is checked out read-only at `sources/old` (`ensureSources`,
  `src/runner/sources.mjs`) from the `sources.old` repo and commit in `.sdlc/config.yaml`. This is
  what `archaeology` uses, and it is why `sources.old` is one of its pre-checks.
- **`spec-only`** — a fresh temporary directory populated by `git archive HEAD` over `spec/`,
  `tests/seed/`, `constitution.md` and `.sdlc/config.yaml` (only the paths that exist), plus an
  empty `tests/acceptance/` directory. The archive reads committed content only, so an uncommitted
  edit in the project neither leaks into the workspace nor is visible there.
- **`blind-adapter`** — the same archive mechanism over `spec/contract`, `tests/adapters`,
  `tests/seed` and `constitution.md`.

Materialising either temporary mode throws `blindness violated: app/ present in <mode> workspace`
if `app/` somehow ended up in the workspace — the check that a blind stage never sees the
application it is meant to be blind to. For those two modes, whatever the stage's `collect` list
names is copied back into the project directory after the session ends, and the temporary
directory is removed either way (`ws.cleanup()`, in a `finally`, whether the stage succeeded or
threw). No implemented stage uses them yet.

Inside the workspace, the agent session is isolated from the operator's own Claude Code
configuration — see `docs/decisions/0004-isolated-stage-sessions.md` for what that means and why.
The project's own `.claude/settings.json` deny list and the `implement-guard` `PreToolUse` hook
(`docs/stages/init.md`) still apply, scoped by the `SDLC_STAGE` environment variable the executor
sets.

## The `prepare` hook

A stage may declare `stage.prepare(wsDir, ctx, config)`, run after `materialise` and before the
agent turn, in the workspace directory (`wsDir` — the project directory itself for `project` and
`with-sources` modes, a temporary directory for `spec-only` and `blind-adapter`). It exists for a
stage that needs something generated and already sitting in the workspace before the agent can
start — `derive-tests` and `bind-adapter` both do. Whatever it writes is collected back into the
project exactly the way the agent's own output is: through the stage's `collect` list, for the two
temporary modes, or because it is already in the project directory, for `project`/`with-sources`.

`prepare` never runs on a dry run — a dry run writes nothing at all — and the dry run's only
account of it is the line `prepare: skipped on dry run`, printed after the prompt, for a stage
that has one.

If `prepare` throws, the run fails immediately, the same way a failing pre-check does: a run-record
line (`run <stage>: prepare failed`) and a commit (`run(<stage>): prepare failed`) with just that
line staged, and `{ ok: false, messages: [<the error's message>] }` returned. There is no agent
turn to have run and so no journal entry — a journal entry is the account of a turn, and none
happened.

## MCP servers, tools and environment

A stage may declare `stage.mcp(ctx, config)`, returning an object of MCP servers (the value that
would sit under an `mcpServers` key) or `null`. When it returns non-null, `runStage` writes `{
"mcpServers": <that object> }` to `mcp.json` in the same scratch directory the run's skill file
lives in (removed afterward in the existing `finally`, along with the skill file itself), and the
agent turn runs with `--mcp-config <that path>` — placed right after `--strict-mcp-config`, which
is always passed, so this file is the only source of MCP servers the session can reach. A stage
that declares no `mcp` passes no `--mcp-config` at all. `bind-adapter`, which drives a browser
against the running application, is the first stage to use this. The mock executor
(`SDLC_EXECUTOR=mock`) ignores `mcp` entirely — it never spawns a real session to pass it to.

A stage may also declare `stage.allowedTools` (an array) and `stage.env(ctx, config)` (an object of
environment variables), both passed straight through to the agent turn. `allowedTools` narrows
`--allowedTools` the same way any caller of `runAgent` can; `env` is merged into the child
process's environment alongside `CLAUDE_CONFIG_DIR` and `SDLC_STAGE`. Neither is printed by a dry
run except by name — `env`'s keys, via the `env: <names>` line described above, and never a value.

## Stages with no agent turn

A stage may declare `agent: false`, which `ratify` and `calibrate` do. There is no workspace and no
session: `stage.execute(projectDir, ctx)` runs in process, in the project's own working tree, and
its return (`{ text, changed }`) stands in for an agent result, with `cost: 0`, `turns: 0` and
`sessionId: "deterministic"` synthesised around it. Nothing is spawned, so `.sdlc/run-state.json`
is never written on this path. The call is awaited, so `execute` may be asynchronous — `calibrate`'s
is, since it has to start the oracle and run a suite before it has anything to report.

`execute` reporting `changed: []` means it found its own work already done. That is not an error
and not a journal entry — a journal entry is the account of a turn, and no turn happened — so the
run finishes through a path that still runs the post-checks and still commits whatever the stage
regenerated on its way past, as `stage(<stage>): <title> (regenerated)`, with a run-record line
and no journal entry. When regenerating changed nothing either, nothing is committed at all.

A stage may also declare a `followUp`, run after its commit has landed on `main` and only on
success. `ratify`'s opens the G1 proposal that closes out criteria it could not mint
(`docs/stages/ratify.md`, "The closing loop"); `calibrate`'s opens the G1 proposal that asks what
each failing criterion's failure means (`docs/stages/calibrate.md`, "The ruling loop"). A run that
opens one returns it as `proposal` and leaves the checkout on that branch, exactly as a gated stage
does.

## Checks that block

In the order they are reached:

1. **The working tree must be clean** (`assertCleanTree`): `run` is going to commit on the
   caller's behalf, so it refuses to start over uncommitted work already there, listing the dirty
   paths.
2. **The checkout must be on `main`** (`assertOnMain`), or the run throws `run must start on main;
   you are on <branch>`. Everything downstream assumes it: `propose` branches off `main`, the
   ruling persona's diff is `main...proposal/<name>`, and the open-proposal check reads `git
   branch --merged main`. A run started on a leftover proposal branch — which is the state a gated
   run itself leaves the tree in — would branch off that branch and carry the previous proposal's
   changes as if they were its own.
3. **`<stage>` must be in the registry, and `stage.implemented` must be `true`.**
4. **`.sdlc/config.yaml` must load and validate.**
5. **The stage's own `preChecks(projectDir, ctx)` must all pass**, before a workspace is
   materialised or a session started. `probe` declares none; `intent` requires `intent/brief.md`;
   `archaeology` requires `--domain` and `sources.old`; `ratify` requires `--domain`, an approved
   and merged `archaeology-<d>` ruling, and a `spec/domains/<d>.md` that exists and parses;
   `derive-tests` requires a domain with accepted criteria; `bind-adapter` requires a target that is
   configured and answering; `calibrate` requires a target that is either the configured oracle or a
   `config.targets` entry with a `base_url`.
6. **For a gated stage, the proposal this run would open must not already be open.**
   `checkProposalNotOpen` (`src/runner/finish-stage.mjs`) calls `stage.proposal({ ...ctx,
   projectDir, agentText: "" })` to learn the name a real run would use. If a `proposal/<name>`
   branch exists with no `.sdlc/gates/<name>.yaml` on it, the run is refused. If the branch exists
   *and* has been ruled, its spent branch is deleted with the safe `git branch -d` so a fresh
   `propose` can recreate the name — and when `-d` refuses, because the branch holds a ruling
   commit `main` does not (a `return` or an `escalate`), the proposal is reported as open instead,
   for a person to deal with rather than being force-deleted.

   `intent`'s proposal name is normally only knowable once the agent has written
   `intent/<slug>.md`; before that, `proposal(ctx)` derives the same slug from `intent/brief.md`'s
   own `# ` heading — the rule the skill gives the agent for naming its own file — using the
   `projectDir` this check adds to `ctx` for exactly that. Only when the brief has no heading at
   all does `proposal(ctx)` return `null` and this check get skipped.
7. **The stage's own `postChecks(projectDir, ctx)` must all pass**, run after the session ends.
8. **The open-proposal check runs a second time**, now against the stage's real (not derived)
   proposal name — a safety net for a name the check above had nothing to test yet, because it
   depended on a file the agent had not written. A collision found here is reported the same way
   any other post-check failure is, since by this point the agent has run and left files worth
   preserving.

## Exit criterion

Exits 0 and prints `run <stage>: ok`, with `(opened <branch>)` appended when a proposal was
opened, and `execute`'s own text printed above it for a stage with no agent turn. A dry run exits
0 having printed the prompt and skill path (or the one-line `agent: false` note) only. Any check
failure exits 1 and prints `run <stage>: failed` followed by the check messages.

## Re-run behaviour

**A gate-less agent stage** re-run against a project that already carries a passing run is not a
no-op: it produces a new, separately numbered journal entry (`002-<stage>.md`, and so on) and a new
run-record line every time, because a stage's work is judged fresh by its post-checks on each run
rather than compared against what a previous run already committed. When the output happens to come
out byte-identical to what is already on `main`, only the new journal entry, run record and site
regeneration end up dirty and committed.

**`ratify`** is the exception, because it has a cheap and exact way to tell whether anything
changed — see "Stages with no agent turn" above and `docs/stages/ratify.md`. **`calibrate`** is
deterministic too but never a no-op: every run writes a fresh result set, because that file is
evidence of what the target did on the day it ran rather than a derived artifact that should be
stable (`docs/stages/calibrate.md`).

**A failing pre-check** is safe to hit repeatedly: its own failure is committed to the run record
before `run` returns, so the working tree is clean again for the next attempt.

**A gated stage** can only be re-run once its previous proposal has been ruled. A successful gated
run leaves the tree checked out on the proposal branch, so the next run starts by checking `main`
out — and is then refused by the open-proposal check above, before a workspace is materialised or
a session started, rather than failing partway through `propose`. Once the proposal is approved and
merged, running the stage again under the same name is safe: the same check deletes the spent
branch so `propose` can recreate it. A returned or escalated proposal's branch is left in place and
keeps blocking the stage until a person deletes it.

`intent` gets this same protection, not a weaker one: its proposal name is derived from
`intent/brief.md`'s own heading before the agent runs, so re-running `intent` against the same,
unrevised brief while its proposal is open is refused up front. The one gap that check cannot close
is an agent that titles its document differently than the brief's heading suggests, which is what
the second, post-run check exists to catch.

## Failure modes

- **The working tree is dirty**: throws before any check or workspace runs, listing the dirty
  paths.
- **The checkout is not on `main`**: throws `run must start on main; you are on <branch>`, having
  changed nothing.
- **Unknown stage name**: throws `unknown stage: <stage>`.
- **Stage not yet implemented**: throws `stage <stage> is not implemented yet`.
- **Invalid `.sdlc/config.yaml`**: throws listing every schema error.
- **A pre-check fails**: `run` commits `run(<stage>): pre-checks failed` to the run record (so a
  later `run` is not blocked by this run's own leftover state) and returns `{ ok: false, messages
  }` without materialising a workspace or starting a session.
- **A gated stage's proposal from a previous run is still open**: `run` commits `run(<stage>):
  proposal still open` to the run record and returns `{ ok: false, messages: ["proposal <name> is
  still open; rule it (or delete the branch) before running <stage> again"] }`, without
  materialising a workspace or starting a session.
- **A stage's `prepare` hook throws**: the workspace has already been materialised, but no agent
  turn has run. `run` commits `run(<stage>): prepare failed` to the run record with just that line
  staged and returns `{ ok: false, messages: [<the error's message>] }` — the same shape a failing
  pre-check returns, and for the same reason: there is nothing agent-shaped to journal.
- **The same collision, discoverable only after the agent has run** — the pre-flight had only
  `intent`'s brief-derived guess, and the agent titled its document differently: `finishStage`
  commits `stage(<stage>): post-checks failed` with a journal entry (the agent's own text plus the
  same `proposal <name> is still open…` message) and the run record staged. Everything else the
  agent left in the working tree stays untracked, visible in `git status`.
- **The session fails to run at all** (the `claude` binary is missing, authentication is not in
  place, or the process exits with no JSON on stdout): `runAgent` throws `claude failed: <stderr>`
  or `claude returned non-JSON output: <excerpt>`, and `run` propagates it — nothing is committed,
  and `.sdlc/run-state.json` is left at `phase: "agent"` for `sdlc resume` to find.
- **The session runs but reports failure** (an error result, the `--max-turns` ceiling reached):
  post-checks are not run at all, since a turn that already said why it failed should not have that
  account replaced by a check message about a file it never got to write. `run` writes a journal
  entry titled `<stage>: agent turn failed` holding the turn's own text and its cost, turn count
  and session id, appends `run <stage>: agent turn failed` to the run record, commits
  `stage(<stage>): agent turn failed` with only those two staged, and returns `{ ok: false,
  journal, messages }`. A turn that fails with no text at all is journalled with the CLI's own
  account of how the session ended instead — "hit the turn cap", read from the result's `subtype`
  rather than inferred by comparing the turn count against the ceiling, which is wrong in both
  directions.
- **A post-check fails**: `finishStage` writes a journal entry recording the agent's own text, how
  the session ended if the CLI said anything about it, and the check messages; commits
  `stage(<stage>): post-checks failed` with only the journal and run record staged (everything the
  agent produced is left untracked in the working tree for a person to inspect); and returns `{ ok:
  false, journal, messages }`. The entry carries the same cost, turn count and session id a
  successful run's does — a failed run costs what a successful one costs.
- **A temporary workspace ends up containing `app/`**: throws `blindness violated: app/ present in
  <mode> workspace` before any session starts.

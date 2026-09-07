# Stage: `resume`

## Purpose

Continue a `sdlc run` that a process death (a crash, a closed terminal, a killed job) interrupted
mid-stage, by re-reading whatever the interrupted agent session left on disk and running the same
post-checks, journal, commit-or-proposal and run-record path a normal run would have reached on its
own.

## Inputs

`sdlc resume [--again]`, run from inside the project's working tree. Takes no stage name: it reads
`.sdlc/run-state.json` to find out which stage and which context (`slice`, `domain`) the
interrupted run was on.

## Outputs

Identical in shape to a normal `sdlc run <stage>`'s outputs, produced by the same `finishStage`
function `run` calls after its own agent session: a journal entry, an appended run-record line, the
regenerated state site, and either a direct commit (no gate) or an opened proposal (gate), followed
by `.sdlc/run-state.json` being cleared on success.

The journal entry's body is not the interrupted session's own words — there are none to recover —
but the fixed string `(resumed; agent output unavailable)`, and its `cost`, `turns` and `session`
front-matter fields are all zero or empty. Whatever files the interrupted agent managed to write
before dying are on disk already (this command does not delete or repair them) and are judged by
the stage's post-checks exactly as they would judge a fresh agent turn's output.

## Workspace the agent sees

No agent session runs here at all. `resume` reads `.sdlc/run-state.json` and the project's
`.sdlc/config.yaml`, then calls `finishStage` directly against the project directory — the same
`cwd` every other command operates on.

**That only makes sense for a stage whose agent worked in the project directory**, which is what
two of the four workspace modes do: `project` and `with-sources`. `materialise` returns
`projectDir` itself for both — `with-sources` differs only in that it also materialises the old
application's read-only checkout at `sources/old` first, which nothing here removes — so whatever
the interrupted agent wrote is still on disk and is exactly what post-checks should judge.

A `spec-only` or `blind-adapter` stage is different: it does its work in a temporary directory
that the interrupted run's own `finally` (`ws.cleanup()`) has already removed, and whatever its
agent produced went with it. There is nothing left on disk for post-checks to judge, and judging
the project directory instead would pass or fail on files that stage never touched. So `resume`
looks the recorded stage up in the registry, loads and validates `.sdlc/config.yaml` — needed
before the mode is even known, since `stage.workspace` may be a function of `config` rather than a
plain string — and resolves `stage.workspace` against it the same way `runStage` does. Only once
that resolves to `spec-only` or `blind-adapter` does `resume` refuse, with `resume cannot continue
a <mode> stage; run it again`, exiting 1 without running a post-check or touching the working
tree. `.sdlc/run-state.json` is left where it is; running the stage again overwrites it.

## Checks that block

- `.sdlc/run-state.json` must exist. If it does not, `resume` prints `nothing to resume` and exits
  0 — there is nothing to continue, and that is a normal outcome, not a failure.
- The project's `.sdlc/config.yaml` must load and validate — needed immediately after, to resolve
  `stage.workspace`.
- The stage named in `.sdlc/run-state.json` must have `workspace: "project"` or
  `workspace: "with-sources"` (see above), resolving a function against the config just loaded.
  Checked before the interrupted-phase check below, so a temporary-workspace stage is never told
  to pass `--again` for something `--again` cannot fix.
- If the recorded `phase` is `"agent"` (the agent session itself was still running, or had not yet
  produced anything to judge, when the process died) and `--again` was not passed, `resume` refuses
  to guess: it prints `run <stage>: the agent step was interrupted before finishing; pass --again to
  continue with post-checks anyway` and exits 1 without touching the working tree.
- For a gated stage, the proposal it would open must not already be open and unruled — the same
  `checkProposalNotOpen` pre-flight `sdlc run` performs before its own agent turn
  (`docs/stages/run.md`), run here before `finishStage` is called at all. `resume` has no agent turn
  of its own, so there is nothing to lose by checking this first: a blocked run costs nothing beyond
  the run record it commits, rather than spending a post-checks judgment on files that would only be
  thrown away by a blocked proposal a moment later.
- The stage's own `postChecks(projectDir, ctx)` must pass, exactly as in `sdlc run`.

## Exit criterion

Exits 0 when `finishStage` reports `{ ok: true }` (including the "nothing to resume" case above),
1 when it reports `{ ok: false }`, when the recorded stage's workspace was a temporary directory
(`spec-only`, `blind-adapter`), when an interrupted agent step is refused for lack of `--again`,
or when the recorded stage's own proposal is still open.

## Re-run behaviour

`resume` clears `.sdlc/run-state.json` on a successful finish, so running it again afterward finds
nothing to resume and exits 0 having done nothing. Running it again after a *failed* finish (a
post-check that still does not pass) finds the same run-state file `finishStage` rewrote to
`phase: "post-checks"` and simply re-judges the same files against the same post-checks — safe to
repeat as many times as it takes for the interrupted stage's leftover output to pass, or for a
person to fix it by hand and let `resume` pick the result up.

## Failure modes

- No run-state file: not a failure — prints `nothing to resume` and exits 0.
- The recorded stage's workspace is `spec-only` or `blind-adapter`: prints `resume cannot continue
  a <mode> stage; run it again` and exits 1, having changed nothing.
- Run-state is at `phase: "agent"` and `--again` was not given: prints the guidance above and exits
  1, leaving `.sdlc/run-state.json` untouched.
- Invalid `.sdlc/config.yaml`: throws listing every schema error.
- The stage named in the run-state file is not in the registry: throws `unknown stage: <stage>` —
  this only happens if `.sdlc/run-state.json` was hand-edited or corrupted, since `run` only ever
  writes a stage name it already validated.
- The recorded stage's own proposal is still open (opened, but not yet ruled): `resume` commits
  `run(<stage>): proposal still open` to the run record and prints `run <stage>: failed` followed by
  `proposal <name> is still open; rule it (or delete the branch) before running <stage> again`,
  exiting 1 without ever calling `finishStage` or judging the stage's post-checks.
  `.sdlc/run-state.json` is left exactly as it was, at whatever `phase` it was already recorded at.
- A post-check still fails: the same failure path as `sdlc run` — a journal entry records the
  stand-in agent text plus the check messages, `stage(<stage>): post-checks failed` is committed
  with only the journal and run record staged, and `resume` returns exit 1. `.sdlc/run-state.json`
  is left in place (at `phase: "post-checks"`) so a later `resume` can try again.

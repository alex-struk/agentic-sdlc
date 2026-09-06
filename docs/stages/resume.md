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

**That only makes sense for a stage whose workspace is `project`**, which is the mode every
implemented stage uses today. A `spec-only` or `blind-adapter` stage does its work in a temporary
directory that the interrupted run's own `finally` (`ws.cleanup()`) has already removed, and
whatever its agent produced went with it: there is nothing left on disk for post-checks to judge,
and judging the project directory instead would pass or fail on files that stage never touched.
So `resume` looks the recorded stage up in the registry and, when its `workspace` is anything but
`project`, refuses with `resume cannot continue a <mode> stage; run it again` and exits 1 without
reading the config, running a check, or touching the working tree. `.sdlc/run-state.json` is left
where it is; running the stage again overwrites it.

## Checks that block

- The stage named in `.sdlc/run-state.json` must have `workspace: "project"` (see above). Checked
  first, before the interrupted-phase check below, so a temporary-workspace stage is never told to
  pass `--again` for something `--again` cannot fix.
- `.sdlc/run-state.json` must exist. If it does not, `resume` prints `nothing to resume` and exits
  0 — there is nothing to continue, and that is a normal outcome, not a failure.
- If the recorded `phase` is `"agent"` (the agent session itself was still running, or had not yet
  produced anything to judge, when the process died) and `--again` was not passed, `resume` refuses
  to guess: it prints `run <stage>: the agent step was interrupted before finishing; pass --again to
  continue with post-checks anyway` and exits 1 without touching the working tree.
- The project's `.sdlc/config.yaml` must load and validate.
- The stage's own `postChecks(projectDir, ctx)` must pass, exactly as in `sdlc run`.

## Exit criterion

Exits 0 when `finishStage` reports `{ ok: true }` (including the "nothing to resume" case above),
1 when it reports `{ ok: false }`, when the recorded stage's workspace was a temporary directory,
or when an interrupted agent step is refused for lack of `--again`.

## Re-run behaviour

`resume` clears `.sdlc/run-state.json` on a successful finish, so running it again afterward finds
nothing to resume and exits 0 having done nothing. Running it again after a *failed* finish (a
post-check that still does not pass) finds the same run-state file `finishStage` rewrote to
`phase: "post-checks"` and simply re-judges the same files against the same post-checks — safe to
repeat as many times as it takes for the interrupted stage's leftover output to pass, or for a
person to fix it by hand and let `resume` pick the result up.

## Failure modes

- No run-state file: not a failure — prints `nothing to resume` and exits 0.
- The recorded stage's workspace is not `project`: prints `resume cannot continue a <mode> stage;
  run it again` and exits 1, having changed nothing.
- Run-state is at `phase: "agent"` and `--again` was not given: prints the guidance above and exits
  1, leaving `.sdlc/run-state.json` untouched.
- Invalid `.sdlc/config.yaml`: throws listing every schema error.
- The stage named in the run-state file is not in the registry: throws `unknown stage: <stage>` —
  this only happens if `.sdlc/run-state.json` was hand-edited or corrupted, since `run` only ever
  writes a stage name it already validated.
- A post-check still fails: the same failure path as `sdlc run` — a journal entry records the
  stand-in agent text plus the check messages, `stage(<stage>): post-checks failed` is committed
  with only the journal and run record staged, and `resume` returns exit 1. `.sdlc/run-state.json`
  is left in place (at `phase: "post-checks"`) so a later `resume` can try again.

# Stage: `drive`

## Purpose

Run what `sdlc next` names, one step after another, until the record says a person has to act,
a step fails with no known recovery, or the loop has stopped getting anywhere. It is level 2 of
"what runs next" (`docs/operating-model.md` §8): the operator no longer types each command, and
every place the loop stops is on the run record with its reason.

`next` decides every step. `drive` never chooses between ready work, never runs anything `next`
did not name, and never records a verdict for a seat a person holds
(`docs/decisions/0074-a-loop-that-stops-at-a-person.md`).

## Inputs

`sdlc drive [dir] [--max-steps N] [--dry-run]`, where `dir` defaults to the current directory
and `--max-steps` to 50. `sdlc drive [dir] --status` prints the heartbeat (below) and does
nothing else.

Each turn of the loop reads `next` in-process (`whatNext`, `src/runner/next.mjs`) from `main`, as
`sdlc next` does, and acts on the command it names:

| `next` names | `drive` |
|---|---|
| `sdlc run <stage> …` | runs it through `runStage`, the function `sdlc run` calls, with the same flags |
| `sdlc rule <name> --by agent:<persona>` | runs the persona's ruling through `ruleByAgent`, the function `sdlc rule` calls |
| `sdlc rule <name> --by <role>` (no `agent:`) | stops: a person's ruling is never run |
| nothing, waiting on a person (`next` exit 3) | stops, and prints what waits on whom and the command each person types |
| nothing left (`next` exit 4) | stops |

A step runs exactly what `next` named, so it is never a deviation and needs no `--reason`. A
step's environment is the operator's own, passed through unchanged: `SDLC_SANDBOX_PASSWORD`,
`SDLC_AGENT_BACKEND` and anything else a stage reads from the environment reach it the way they
reach a typed `sdlc run`, and `drive` writes none of them anywhere.

## What it decides

**When to stop.** After each step it reads `next` again. It stops when:

| Stop | Exit | Recorded as |
|---|---|---|
| nothing is left to run | 0 | `drive: stopped after <n> steps — nothing left to run` |
| a step failed and no recovery applies, or the recovery did not work | 1 | `… — step <n> (`<command>`) failed`, with the tail of the step's output printed |
| `next` could not be read | 1 | `… — next could not be read: <reason>` |
| a step left uncommitted changes or a branch other than `main` checked out | 1 | `… — step <n> (…) left the project unfit for the next step: …` |
| refused to start: uncommitted changes, not on `main`, or another drive running | 2 | `… — refused to start: …` (another drive running is printed only) |
| nothing can run until a person acts, or `next` names a person's ruling | 3 | `… — waiting on a person: <role>: <proposal>; …` |
| the agent CLI's sign-in has expired or was refused | 5 | `… — the agent CLI's sign-in has expired or was refused during step <n> …` |
| no progress | 6 | `… — no progress: next names `<command>` again and nothing it could change has changed since it last ran` |
| the step limit | 7 | `… — step limit of <N> reached; next names `<command>`` |

**Sign-in.** A step failed on sign-in when its output carries the executor's own account of it:
the sign-in check's refusal (`the stage was not started: a one-turn check could not
authenticate…`) or a failed turn's text with the backend's sign-in advice appended
(`authFailureReported`, `src/runner/executor.mjs`). It is never retried: every later step would
fail the same way, and a person has to sign in.

**Progress.** Before each step `drive` takes a mark of what the record holds that a step could
change, and keeps it by command. When `next` names a command that has run before, the mark is
taken again and compared with the one taken before that command last ran. Equal marks stop the
loop. The mark is:

- `main`'s tree, and every `proposal/*` and `returned/*` branch as the files it changed since the
  commit it shares with `main`, so a step that merges `main` into a branch does not count what
  `main` already showed (`docs/decisions/0085`); each without the account every run writes about
  itself: `.sdlc/runs/`, `.sdlc/journal/`, `site/` and
  `tests/results/`;
- each target's latest calibration as counts of result and ruling (`fail ruled test-wrong: 2`),
  read from `tests/results/<t>/latest.json` on `main`, which is rewritten with a new run id on
  every run and so is compared by what it says rather than byte for byte;
- the `why` `next` gives for the command.

So a step that only appended its own run-record line, wrote a journal entry, regenerated the site
or measured the same calibration outcome again has made no progress, and the next time the same
command is named the loop stops rather than run it again. Other steps in between that moved the
record count: the comparison is with the last run of the same command, and anything that changed
since, by whichever step, makes the mark differ.

**Recovery.** Two kinds, the oracle and the new target's sandbox, attempted at most once per step,
each action on the run record before it is taken:

- **The oracle is not up.** A step that says so (`run sdlc oracle up first`, `oracle up failed`) is
  answered by `sdlc oracle up`, then the step is run once more.
- **`oracle up` fails or hangs.** Each compose call that builds, migrates or starts the oracle
  stops at `oracle.up_minutes` (30 by default, `docs/stages/oracle.md`), so a hung `oracle up`
  fails like any other. The oracle is then taken down (`sdlc oracle down`) and brought up once
  more. If that fails too, the loop stops with 1 and the tail of the second attempt's output.
- **The oracle is up and unusable.** A calibration that halted on an environment fault (`the target
  could not be reset or reached`) is answered by taking the oracle down and bringing it up, since
  `oracle up` alone finds the containers running and changes nothing, then the step is run once
  more.

- **The new target's sandbox is not up.** A binding that says so names the build proposal to start
  it from (`the new target's sandbox is not up — …; run sdlc sandbox up --target new --from
  proposal/build-slice-<n>[-k] first`, `docs/stages/bind-adapter.md`), or, where a verify returned
  that slice's newest build, the returned build's own branch, `proposal/build-slice-<n>[-k]` or
  `returned/build-slice-<n>[-k]`. The branch is passed to `sandbox up` and `sandbox down` as the
  step named it
  (`docs/decisions/0080-a-returned-adapter-is-revised-before-it-is-measured-with.md`). Then
  `sdlc sandbox up --target new --from <branch>`, the step once more, and
  `sdlc sandbox down --target new --from <branch>` whatever became of the start or the step. The
  oracle stays up beside the sandbox; a start refused a host port while the oracle is up is
  answered by `sdlc oracle down` and one more start
  (`docs/decisions/0101-the-oracle-stays-up-beside-the-new-sandbox.md`). A sandbox that does not
  start stops the loop with 1 and the tail of its output, and is still taken down. A sandbox that cannot be taken down stops the loop with 1 and the command to
  take it down by hand. A refusal that names no branch — no build proposal of the slice, or more
  than one slice's — is a stop (`docs/decisions/0078-drive-starts-the-new-sandbox-for-a-rebind.md`).
- **A sandbox could not start on a port the oracle holds.** A step whose sandbox was refused a
  host port this machine already holds (`the sandbox was not started: … publishes a host port this
  machine is already using`), while the oracle is up, is answered by `sdlc oracle down` and run
  once more. With the oracle not up, a held port is something else's and a stop.

`SDLC_SANDBOX_PASSWORD` reaches `sandbox up` and the step from the loop's own environment. It is
passed in no argument and written into no record line.

A step that fails again after its recovery stops the loop with 1. A step that recorded an outcome
that did not pass — a verify that returned a build — is not a failure: the record moved, and the
loop reads `next` again.

## Outputs

**The run record.** A line per step, per recovery action and per stop, in `.sdlc/runs/<day>.md`,
through the run record's redaction like every other line:

```
- 10:02:11 drive: step 3: `sdlc run bind-adapter --target <t>` — phase 2 Tests is not complete (…), and bind-adapter for target <t> is next in it
- 10:02:12 drive: step 3 recovery: the oracle was not up; bringing it up (sdlc oracle up), then running the step once more
- 11:14:03 drive: step 9 recovery: the new target's sandbox was not up; starting it from proposal/build-slice-2 (sdlc sandbox up --target new --from proposal/build-slice-2), running the step once more, and taking it down after (sdlc sandbox down --target new --from proposal/build-slice-2)
- 10:31:40 drive: stopped after 7 steps — waiting on a person: <role>: <proposal>
```

A step's line and a recovery's line wait in the ignored pending record (`.sdlc/runs.local.txt`)
and are written by the next pipeline commit — the step's own, or `oracle up`'s — ahead of that
commit's own line, the way a command a stage runs is recorded. A stop is committed on its own on
`main` as `run(drive): stopped after <n> steps`. When the tree is not clean or `main` is not
checked out, the stop line waits in the pending record instead, so the loop never commits work
that is not its own and never leaves the tree dirty.

**The heartbeat.** `.sdlc/drive.local.yaml`, rewritten as each step starts and when the loop
stops: the process, when the loop started, the step number and command, when that step started,
when it was last written, and on a stop the reason. `sdlc drive --status` reads it:

```
drive: running since <time> (process <pid>); step 4: `sdlc run derive-tests --domain <d>`, started <time>; last heard <time>
drive: stopped at <time> after 7 steps — waiting on a person: <role>: <proposal>
drive: not running — process <pid> is gone; it was on step 4: `…` (last heard <time>)
```

It is a local file, matched by the `.sdlc/*.local.yaml` line every project ignores, not a record
file: it is a timestamp that changes on every step, which the record and the state site (a pure
function of the record, `docs/stages/status.md`) must never hold, and writing it never makes the
tree dirty under the loop that wrote it. A drive started while another's heartbeat says it is
running, from a process that is still alive, is refused.

**The terminal.** Each step's command and why, the step's own output as `sdlc run` or `sdlc rule`
prints it, and on a stop the reason with what waits on whom or the tail of the failed step's
output.

`--dry-run` reads `next` once and prints what the loop would do first — `would run: <command>`
with its `why` and `rule`, or `would stop` with the reason — and writes nothing: no record line,
no heartbeat, no commit.

## Workspace the agent sees

None of its own. Each step's stage or ruling sees the workspace it always sees.

## Checks that block

- A clean working tree on `main`, before the first step and after every step.
- No other drive running in the project.

## Exit criterion

| Exit | Meaning |
|---|---|
| 0 | nothing is left that this pipeline runs; with `--dry-run`, also when it would run a step |
| 1 | a step failed with no recovery, its recovery failed, a step left the project unfit, or `next` could not be read |

A ruling that returns a proposal leaves `proposal/<name>` checked out on purpose (`docs/decisions/0025`), for a person to read what came back. When a step ends on a clean tree with a `proposal/` branch checked out, the loop checks out `main` again, says so on the terminal, and carries on; any other branch, or a dirty tree, is a project left unfit and stops it with 1.
| 2 | refused to start: uncommitted changes, not on `main`, another drive running, or a bad `--max-steps` |
| 3 | waiting on a person, or `next` names a person's ruling |
| 5 | the agent CLI's sign-in has expired or was refused |
| 6 | no progress |
| 7 | the step limit was reached |

## Re-run behaviour

Starting it again continues from whatever the record says now. The progress marks and the step
count belong to one run of the loop; a new run starts with neither. After a stop with 1, 5 or 6 a
person looks first: running it again unchanged reaches the same stop.

## Failure modes

- A stage that fails for a reason that is really the oracle's but says so in words the recovery
  does not recognise is stopped on as a failure, and a person runs `sdlc oracle up` and starts the
  loop again.
- A new target's sandbox already running from a different build proposal answers the binding's
  probe, and the binding runs against it. The loop starts a sandbox only on a binding's refusal.
- Output a child process writes straight to the terminal — a compose build — is shown but is not
  part of the tail printed on a stop; the stage's own account of its failure is.
- A process killed without warning leaves a heartbeat that says `running`; `--status` reads the
  process as gone and says so, and a new drive is not refused by it.

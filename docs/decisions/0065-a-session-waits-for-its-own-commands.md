# 0065 · A session waits for its own commands

Status: accepted · 2026-09-27

## Context

An agent session runs headless: `claude -p` or `codex exec`, one prompt in and one result out.
The session ends the moment the agent stops replying. A command the agent started in the
background goes on running, but nothing wakes the session when it finishes and nobody reads
what it prints, so its result is lost and the stage's final message describes work in progress
as if someone were still watching it.

Claude Code's Bash tool stops a command at two minutes unless the call names a longer limit,
and never allows more than ten. Some of a stage's own work takes longer than that: `contract`
proves its compose override with `sdlc oracle up`, which pulls images, installs dependencies and
runs a migration, and takes five to fifteen minutes. An agent facing a command that the tool
will kill before it finishes has one way to keep it alive, which is to background it — and in
a headless session that is the same as abandoning it. A contract run that did exactly this
ended after three turns with "it will report once `oracle up` exits" as its recommendation, and
the proposal it opened carried nothing G1 could approve.

Claude Code reads its command time limits from two environment variables,
`BASH_DEFAULT_TIMEOUT_MS` (the limit when a call names none; 120,000 by default) and
`BASH_MAX_TIMEOUT_MS` (the most a call may name; 600,000 by default, and never below the
default limit). Both are read from the session's environment when a command is run.

## Decision

**A session's commands may run as long as the stage's own work takes.** `policy.command_minutes`
names a limit per stage, 30 minutes where nothing names one; a ruling and the sign-in check get
the default. The runner gives a Claude session both variables at that value, so a command started
without a limit gets all of it. They are set after the operator's environment and the stage's
own, as `CLAUDE_CONFIG_DIR` and `SDLC_STAGE` are: the limit is the pipeline's, not whatever the
machine happened to have set. A session in a container is given the same two, by value on the
`docker run` line — they are the runner's setting, never a secret, and a session is given the
same limits wherever it runs.

The default and the maximum are the same value on purpose. An agent that does not think to name
a long limit is the case this exists for; a hung command still ends at the limit rather than
holding the session for the rest of its turns.

**Every stage is told the session ends when it stops replying.** The preamble every stage reads
ahead of its skill (`src/stages/skills/_preamble.md`), on its first turn and on every repair turn
and on either backend, says that a command whose result the agent needs runs in the foreground,
and never in the background with a promise to report later.

**Codex has no command limit the pipeline can set, so its ceiling allows for one.** A Codex
session's model names a time limit per command, and a long command keeps running while the model
polls it; there is no configuration key that sets a default for the session. What bounds a long
command there is the runner's own wall-clock ceiling, thirty seconds per turn. A session that may
run commands at all — no tool allowlist, or one that grants a shell — has one command limit added
to that ceiling, so a single long command it waits on cannot use up the time its turns were given.

## Alternatives

**Turn background tasks off in the session** (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`). It would
make the rule impossible to break on Claude, but it also takes away a background process a stage
starts and uses within the same session, such as a server it then sends requests to, which is
legitimate. The instruction covers the failure without removing that, and it reaches Codex too.

**Tell the agent to name a long limit on each call.** It depends on the agent remembering, and
the limit it can name is still capped at ten minutes unless the maximum is raised.

**Tie the limit to the stage's turn ceiling.** Turns and minutes measure different things; a
stage with few turns can still have one long command to wait for.

## What would reverse it

A session that can be resumed when a background command finishes — the runner waking it with the
command's output — would make backgrounding safe, and the instruction could then say when to use
it instead of forbidding it.

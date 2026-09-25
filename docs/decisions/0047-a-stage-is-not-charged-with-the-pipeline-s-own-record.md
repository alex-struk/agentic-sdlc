# 0047 · A stage is not charged with the pipeline's own record

Status: accepted · 2026-09-25

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A stage is judged on what it changed: several post-checks read `git status --porcelain` and
refuse any path outside the stage's territory. Some stages run pipeline commands while they work.
`contract`'s session brings the oracle up and down to prove its override (`0006`), and
`calibrate` starts the oracle in-process before it runs the suite.

`sdlc oracle up` and `down` append a run-record line. Run by a person on a clean tree, they commit
it; on a dirty tree, they leave it uncommitted. Inside a stage that gives two wrong outcomes. On a
clean tree, a commit lands on `main` in the middle of the stage, carrying none of the stage's work
and made whatever the stage then does. On a dirty one, the line is a change in the working tree,
and the stage's scope check counts it as the agent's: a stage that did what its prompt said fails
on the pipeline's own bookkeeping, and a repair turn cannot fix what the agent did not write.

The journal never has this problem. The runner holds the agent's account in memory and writes the
journal entry after the post-checks, in the same commit as the stage's outcome.

## Decision

**A run-record line recorded during a stage waits for the stage's own.** A pipeline command that
knows it is part of a stage writes its line to `.sdlc/runs.local.txt`, which the required
`.sdlc/*.local.txt` ignore line keeps out of the working tree's changes. The next `appendRun`
writes the waiting lines, oldest first, ahead of its own, and clears the file. During a stage that
call is the stage's outcome line — `ok`, `post-checks failed`, `agent turn failed` — so the lines
reach `main` in the stage's own commit or proposal, and the post-checks never see them.

**Nothing is committed on `main` while a stage runs.** A command inside a stage neither writes the
record nor commits. Commits during a stage are the runner's.

**A command knows it is inside a stage from the stage, not from the tree.** The executor sets
`SDLC_STAGE` on every session it spawns, so a command the agent runs carries it and one a person
runs does not. `oracleUp`, the in-process form, is only ever called by a stage and records as one.
`.sdlc/run-state.json` is not the signal: it outlives a crashed run, and a person's command after
a crash is a person's.

**A waiting line keeps its time.** It is written with the time it was recorded, and with its day
too when it lands in a later day's file. A line whose stage never records an outcome is written
by whatever the pipeline records next, so it is late rather than lost.

## Consequences

A stage's post-check failure commits the run record with the journal, so a stage whose post-checks
failed only on the pipeline's own record passes them when `sdlc resume` re-judges the same files,
with no agent turn.

`sdlc sandbox` records no run-record line, so `build` and `verify` bringing a sandbox up or down
are unaffected. A new pipeline command a stage may run records through `deferRun` when it is part
of a stage; otherwise a stage that runs it is charged with the line.

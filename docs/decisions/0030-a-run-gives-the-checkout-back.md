# 0030 · A run gives the checkout back

Status: accepted · 2026-09-21

## Context

`propose` cuts `proposal/<name>` from `main`, commits the stage's work onto it, and returns.
The checkout stays where the commit landed. Every gated stage ends there, so every gated run
ends standing on a branch its caller never asked to be on.

The next command refuses. `assertOnMain` is the second pre-check every run makes, and it is
right to: `propose` branches off `main`, a persona's diff is `main...proposal/<name>`, and the
open-proposal check reads `git branch --merged main`. A run started on a leftover proposal
branch branches off that branch and carries the previous proposal's changes as if they were
its own.

**The two halves of one documented sequence disagree about who owns the checkout.**
`build --revise` opens a proposal and stops; `verify --slice N` is the next line of the
sequence and refuses with `run must start on main`. The operator reads a message about `main`
in the middle of a revision that never mentioned a branch, and the fix — `git checkout main` —
is something the pipeline knows and did not do. `0025` settled the same question for a ruling,
which borrows a branch and hands it back on every path it takes; `sandbox --from` and `verify`
each do the same. Opening a proposal was the one place that borrowed and kept.

The cost of leaving it is not only the refusal. A run that ends on the branch makes the working
tree the place a stage's output is read from, which is true for exactly as long as nothing has
moved — and `rule`, `resume` and the next run all move it. Anything that read the output that
way was reading a coincidence.

## Decision

### The checkout goes back to `main` when the proposal's commit lands

In `propose`, after the commit and before it returns, for every caller: a stage finishing at a
gate, a `followUp` opening a question of its own, and a person typing `sdlc propose`. The commit
is the whole of what the command had to keep, the tree is clean by the time it is made, and
there is nothing left to carry across.

`propose` is where it belongs rather than `finishStage`, because `finishStage` is not the only
caller: `ratify`'s and `calibrate`'s follow-ups reach `propose` directly, and a rule enforced in
one caller is a rule the others walk around.

### What a stage produced is read off its branch

This is the half that costs something. `main` does not carry a gated stage's work until a ruling
merges it, so `.sdlc/proposals/<name>.md`, the journal entry, the domain file, the adapter, the
generated types and the bookkeeping ledgers are all read with `git show <branch>:<path>`, or with
that branch checked out where a reader takes a directory rather than a path. Twenty-five tests
asserted on those files through the working tree and now name the branch; each asserts the same
thing about the same bytes.

Three assertions changed rather than moved, and each was the defect stated as a fact:
`propose` leaves HEAD on the branch, a gated run leaves HEAD on the branch, and a ruling refused
after `openGate` leaves HEAD on the proposal. The third is `leaveRuling` putting HEAD back where
the caller was standing, which is what it always did; what changed is where the caller was
standing.

### The site is generated from the tree it is built in

An open proposal's page reaches `site/proposals/<name>.md` only where the tree carries the page,
which for an unruled proposal is its own branch. That was already true — a gated stage builds no
site, and a ruling regenerates it on `main` — and was only ever obscured by the checkout happening
to be on the branch when something built one.

## Consequences

- `build --revise` is followed by `verify` without a checkout in between, and so is every other
  pair of steps in a gated sequence.
- A run refused for an open proposal is refused by the open-proposal check, which names the
  proposal, rather than by `assertOnMain`, which names a branch the operator did not choose.
- A caller that wants the proposal checked out asks for it. `sdlc propose` prints the branch it
  opened, and a stage's result carries `proposal.branch`.

## What was considered instead

**Checking `main` out in `runStage` after `finishStage` returns.** It leaves `propose` itself
still holding the checkout, so the two follow-up callers and the hand-typed command keep the old
behaviour, and the rule then has to be remembered once per caller.

**Leaving the checkout and relaxing `assertOnMain` to accept a proposal branch.** It removes the
message and keeps the fault: a run that branches off a proposal branch produces a proposal
carrying another one's changes, which is the thing that check exists to stop.

**Having `verify` check `main` out for itself.** It makes one pair of steps work and leaves the
next pair to discover the same thing, and a command that silently moves the checkout out from
under its caller is a worse contract than one that refuses.

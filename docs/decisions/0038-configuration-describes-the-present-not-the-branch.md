# 0038 · Configuration describes the present, not the branch

Status: accepted · 2026-09-21

## Context

`.sdlc/config.yaml` is versioned with the repository, so a proposal branch carries it as it
stood the day the branch was opened. A ruling has that branch checked out. Two rulings in
succession on one proposal read the target's address out of the branch's copy, stated it as
fact in their rationale, and reasoned to a conclusion that was wrong for the environment the
project actually runs in. One of them prescribed an action that would have failed for exactly
the reason the configuration change had been made to avoid.

Neither ruler was careless. Both quoted the file in front of them, and the file in front of
them was the only copy the prompt gave them any reason to look at — the configuration was not
in the prompt at all, so a ruler that wanted a configured value went and read one, and got the
branch's.

The same argument has already been settled once. `0013` reads a persona brief from `main`
because the brief describes the *ruler* rather than the change, and a correction to it has to
reach the proposals that were open when it was made. Configuration that describes where a
target answers, what services it depends on and which toolchain the project is on describes
the *host and the environment*, and belongs to the present for the same reason: an address the
project has moved from is not the address the acceptance suite drives, whatever a branch says.

The same record drew the other half of the line, and it still holds: "the config's gate block
in particular is the policy the proposal was made under, and stays with it." A proposal is
ruled under the policy it was opened under, and the runner has already acted on the branch's
copy of `policy` by the time a prompt is built — it is what chose the seat.

What `0013` did not have to answer is the case that makes a blanket "read it from `main`"
wrong: a proposal whose *subject* is the configuration. Ruling one against `main`'s copy shows
the ruler the absence of the change it was asked about.

## Decision

### 1 — A ruling prompt quotes the configuration, resolved block by block

The prompt gains a section that quotes `.sdlc/config.yaml` as the ruling reasons from it, and
says in its first line to rule from that rather than from the copy on the branch. Each
top-level block is resolved by one of three rules:

- **`main` governs.** It is what is true now, and it is what an address, a service or a
  toolchain has to be true of.
- **`policy` is read from the branch.** It is the terms the proposal was made under (`0013`),
  and it is the copy the pipeline acted on when it chose the seat ruling this gate. A prompt
  quoting `main`'s policy would be telling the ruler a different rule from the one it is being
  ruled under.
- **A block the proposal itself changes is read from the branch**, whichever kind of block it
  is, with `main`'s current value quoted beside it. That change is part of what is being ruled
  on.

Whether the proposal changes a block is a fact and not an inference: the block is compared
between the branch and the merge base, which is the same comparison the diff the ruler is
shown is taken over. Nothing is read out of the proposal's prose — the technique this
repository rejected for persona briefs (`0013`) and rejected again for routed conditions
(`0036`).

Everything else in the ruling path that reads a configured value reads it from the same
resolved document, so the stack profile a ruling treats as machine-generated is the one the
project is on now rather than the one the branch remembers.

### 2 — A disagreement is quoted, never silently resolved

Where the branch and `main` disagree on a block the proposal does not change, both values are
quoted and the disagreement is named. Which one governs is stated; the other is shown beside
it and labelled stale.

This is the part that answers the defect rather than merely moving it. A ruler shown only
`main`'s copy of a block whose branch value it might otherwise have quoted is right by luck:
it cannot tell the two rulings apart, and neither can anybody reading the rationale
afterwards. A difference the ruler cannot see is how this defect worked, and a difference the
ruler can see is one it can weigh — including by returning the proposal because the branch is
behind on something the work depends on.

The same holds in the other direction for `policy`: the branch's copy governs, and where
`main` has moved on, `main`'s is quoted too as what a proposal opened today would be ruled
under.

### 3 — Instructions owed are read from the ledger that holds them

`.sdlc/conditions.yaml` is written on `main`, because a return's conditions belong to no
branch. A prompt reading the checkout therefore showed the ruler the instructions that had
been filed the day the branch was opened, while the guard that refuses a ruling for closing a
reference nothing has open reads `main`'s copy — the ruler was shown one list and judged
against another. The accounting note now quotes `main`'s list itself, with each reference and
what it asked for, rather than pointing at a checks section that reads the branch.

## The sweep, and what is correctly branch-scoped

Everything else the ruling path reads, and why it reads it where it does:

- **The persona brief** — already `main` (`0013`). Its `escalates` front matter, which is the
  personas' escalation policy, comes with it, so a persona corrected today rules every
  proposal still open.
- **`.gitignore`** — already `main`, unioned with the branch's, so a directory the project
  learned to ignore does not surface as dirt on an old branch.
- **The stack profile itself** (`stacks/<stack>/SKILL.md`) — read from the installed pipeline,
  never from the project, so it was always the present one. Only the `stack:` key naming which
  profile applies came from the branch, and that is now resolved with the rest of the config.
- **The target definitions** (`targets`, `oracle`) — the defect itself; now `main`.
- **`sandbox --from <branch>` and `verify`** — both load the configuration while still on
  `main` and only then borrow the branch, so both were already reading the present
  environment. Nothing to change, and worth writing down so it is not re-derived.
- **The checks** — correctly branch-scoped. A check is a finding about the tree being ruled
  on: a proposal that breaks its own layout, its own criteria or its own configuration has to
  fail, and running the checks against `main` would report on a tree nobody is ruling. The one
  input that does not belong to the branch is the condition ledger, which §3 takes out of the
  prompt's hands rather than out of the check's.
- **The verify result, the typecheck, the diff, the criteria** — all evidence about the
  branch, which is what a ruling is for. The criteria resolver already reads the branch first
  and falls back to `main`, and says so where it does.
- **The standing escalation** — on the branch by design: an escalated ruling is recorded there
  and nowhere else.

## Consequences

- A ruler is shown the configuration instead of being left to find it, and what it is shown
  is the project as it stands. A rationale that quotes an address quotes the one in use.
- A configuration proposal is ruled on what it proposes, and the ruler can see what the change
  is a change *from*.
- A stale branch no longer hides anything: the difference is in the prompt, named, with both
  values.
- A person in the seat reads the same three rules out of the stage doc, and rules the same
  ruling: the section is written to be read aloud rather than to be parsed.

## What was considered instead

**Reading the whole configuration from `main`, with no exception.** Simple, and it makes a
policy proposal unrulable: the ruler would be shown the policy the project already has and
asked to rule on a change it cannot see. The exception has to exist, and the only safe form of
it is a comparison against the merge base.

**A fixed list of "environment" keys read from `main`, everything else from the branch.**
Rejected because the list is the thing that goes stale. A key added to the schema later gets
whichever default the list's author happened to write, and the failure is silent in exactly
the direction this record exists to prevent. `main` governs by default, with `policy` named as
the one exception and the reason written beside it, is the arrangement where a new key is
right without anybody remembering it.

**Resolving the disagreement silently, `main` always winning, with nothing said.** This is the
defect with a different value in it. The ruling would be correct more often and no more
legible, and a ruler that needed to return the proposal *because* the branch was behind would
have no way to know.

**Making the branch's configuration unreadable to the ruling turn** — dropping the file from
the checkout, or refusing the ruling while the two disagree. The first breaks the read-only
contract the ruling path is built on and leaves the tree dirty; the second refuses rulings
over a difference that is usually irrelevant, and a refusal costs a turn (`0036`).

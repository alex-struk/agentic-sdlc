# 0032 · An instruction nobody had to account for

Status: accepted · 2026-09-21

## Context

A G3 ruling returned a build proposal with a condition asking that a criterion be moved from
one slice to another in the plan. The condition was recorded on the gate file. The move never
happened: the stage that could have made it was never asked, and a later ruling on the same
line of work did not raise it again.

**The gate file now asserts something the project's plan contradicts, and the record reads as
complete.** That is worse than the mistake it records. `0012`, `0017`, `0019` and `0027` are
each a run that reported something other than what happened; this is a *decision* that was
ruled, written down, and never executed, with nothing anywhere to notice the gap.

A ruling's conditions are instructions, and the three kinds were followed to three different
depths:

- **`addressed-to <stage>: <why>`** becomes a revision request on
  `.sdlc/revision-requests.yaml`, and is followed from filing to consumption: the entry gains
  `taken` when a `--revise` run picks it up and is never removed (`0024`).
- **`test-overreaches <ID>: <why>`** becomes a redo entry, and `derive-tests --stale` removes
  it when the test is written again (`0021`).
- **A plain condition on a return** has nothing. The stage revises, the revision is ruled on
  its own merits, and whether the condition was met is a question nobody is asked. If the
  stage revises without satisfying it, or the condition was never actionable by that stage at
  all, the line simply stops being mentioned.

The first two are followed because each is a cross-stage ask, and a cross-stage ask has an
obvious place to go missing. The third is the commonest form a return takes, and it was the
one nothing watched.

**Reconstructing this project's own history makes the size of it plain.** Reading every ruling
already recorded, 40 returns carry free-text conditions; 134 of those conditions belong to a
line of work that has since had a proposal approved, and not one of them has any record saying
whether it was carried out. Most were probably met — the revision that followed is usually the
answer. The point is that "probably" is the whole of what the record supports.

## Decision

### A plain condition on a return is recorded as owed

`.sdlc/conditions.yaml`, appended by `sdlc rule` after the ruling commit, on `main`, in a
commit of its own — the same place and for the same reason as the two request ledgers. Each
entry carries the condition's own text, the proposal, gate and seat it was ruled by, the stage
it was asked of, the line of work it belongs to, and the time.

This is `src/spec/revisions.mjs`'s shape on purpose: an append-only ledger a ruling writes to,
marked rather than emptied when it is answered, keeping what was asked beside what was
answered. It is a second file rather than a second kind of row in that one because the two are
read by different things — a `--revise` run reads revision requests as work to start from, and
must never be handed one of these, which is not work at all but a question about work already
asked for.

Filing is decided by what a condition **is**, not by who wrote it. `addressed-to` and
`test-overreaches` lines are left out: each already has a ledger following it, and a second row
would be a second thing to close for one instruction. An approval's conditions are left out:
no `--revise` run reads them, so nothing is owed. A ruling in a closed grammar is left out: its
conditions are applied by a stage through a fixed vocabulary and are followed by that stage's
own records.

### Two verbs close one, and only a ruler writes them

```
condition-met <ref>: <what was done, and where it can be seen>
condition-withdrawn <ref>: <why it is no longer asked for>
```

Two rather than one, because the claims differ and the ledger exists to keep them apart:
the first says the work was done, the second says it should not be. Collapsing them into a
single "resolved" loses exactly the distinction anybody reading the ledger afterwards came for.

Both are accepted on **any** verdict, unlike the other two verbs. The revision that satisfies a
condition is ordinarily approved, and that approval is exactly where a ruler should be able to
say so; a rule that only a return could account for earlier work would make the commonest case
the one the ledger cannot record.

The target is a reference, `<proposal>#<n>`, rather than the condition's own text: a condition
is a sentence, and asking a turn to quote a sentence back byte for byte is asking it to fail.
`sdlc checks` prints the reference beside every open condition, so the line that closes one is
there to be copied.

Both seats write the identical line. The guards run in the shared path before anything is
written, so a person typing `--by <role>` and a persona holding the gate are refused the same
ruling in the same words: a reference nothing has open is refused with the open list in the
message, and a line with no reason is refused because the reason is the whole of what the entry
gains. On the agent seat each of those is a fixable line, so each gets the same one re-prompt
`0028` established for the rest of them.

### Nothing judges whether a condition was met

That is a ruling, not a computation, and no part of this makes it. What is computed is whether
anybody has made it.

### An open instruction is visible on every run, and fails once it has been overtaken

`sdlc checks` gains a `conditions` check, and `sdlc doctor` a line built from the same
function. An instruction that is merely still owed is a **warning**: that is the ordinary state
between a return and the revision that answers it, and failing on it would refuse every project
for as long as any revision is in flight.

It **fails** where the same line of work has since had a proposal approved and no ruling ever
said whether the instruction was carried out. At that point the gate files assert two things
that cannot both be true, and the fix is one line from a ruler either way. That is not a guess
about the work — it is the fact that nobody ruled on it.

**The line of work, not the stage.** A stage revises several artifacts over a project's life —
one domain's tests, then another's — and reading the stage would report an instruction about
one as answered by the first approval of the other. `proposalFamily` draws the line, off the
registry's own naming: a stage's proposals are `<prefix><subject>` and then
`<prefix><subject>-<n>`, and the trailing number comes off the part after the prefix, and only
where that part still holds a separator — because the subject is itself a number for a stage
that builds one slice at a time. `build-slice-1` and `build-slice-2` are two lines of work;
`build-slice-1` and `build-slice-1-2` are two attempts at one.

Because the ruling prompt already runs the checks and quotes them, an open instruction reaches
whoever rules next through the channel that was already there. The prompt adds only the two
lines that close one, and the fact that writing neither leaves it open — which is the right
answer where the proposal in front of the ruler does not settle it.

### An untaken revision request is read back too, and only warns

The same question of the other ledger, which had a consumption path and no reading of the gap:
a request filed and never taken sits on the list indefinitely. It warns, including where an
approval has gone past it, because the only way to clear a revision request is to take it up —
there is no ruling that withdraws one. A failure nobody can answer except by running a stage is
a failure that gets worked around. Giving requests a withdrawal of their own is a separate
change.

## Consequences

- A return's instruction is accountable: satisfied, withdrawn, or visibly still owed. There is
  no fourth state in which it quietly stops existing.
- A project that has been running before this has an empty ledger and a silent check. Only
  rulings made from here are followed, which is the honest starting point: the ledger records
  what a ruler said, and nobody said anything about the earlier ones.
- A ruling costs one more line where it settles something an earlier ruling asked for, and
  nothing at all where it does not.

## What was considered instead

**Judging satisfaction automatically — reading the diff for the change the condition named.**
It is the thing the defect most tempts you into and it is a ruling wearing a computation's
clothes. A condition is prose; what counts as meeting it is a judgement; and a mechanism that
guessed would close instructions nobody answered, which is the defect with an extra step.

**Re-raising the condition on the next proposal's prompt and leaving it at that.** It puts the
instruction in front of the next ruler, which is half of it, and records nothing: the ruler may
act on it or not, and the next run is back where it started. Visibility without a close is how
a list gets long enough to stop being read.

**Failing `checks` on any open condition.** Every project would fail for as long as any
revision was in flight, which is most of the time, and a check that is red in the ordinary case
is a check people learn to pass over.

**A row in `revision-requests.yaml` with a `kind` field.** One ledger answers "what did rulings
ask for that is still open?" in one place, which is genuinely better to read. It also puts
these rows where `openRevisionRequestsFor` looks, and a `--revise` run handed one would take a
question about finished work as work to start. Keeping the two files apart keeps that
impossible rather than filtered.

**Closing a condition through a command of its own.** It is a smaller change and it puts the
close somewhere no gate file records. A ruling's instruction is closed by a ruling, in the same
place every other ruling decision is written down, and on both seats by the same line.

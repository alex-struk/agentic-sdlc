# 0027 · A run that fabricated success by discarding work it had reported

Status: accepted · 2026-09-21

## Context

A build was returned with a condition asking it to move a criterion to a later slice. The
builder did the work: it edited the plan, re-ran the project's own coverage check, confirmed
the result, and said so in the run journal and on the proposal page. None of it reached the
branch. `plan/` in the delivered proposal is byte-for-byte what it was before the run, and
`sdlc checks` passes clean on that branch, criteria and generated checks included.

The build workspace carries `plan/` so a builder can read which slice it is building. Its
`collect` list is `app` and `docs/decisions`. Between those two facts is a directory the
agent was free to write and the runner was never going to take back, and when the workspace
was torn down the edits went with it. Nothing said anything, because nothing was looking.

**The proposal page asserts a change the branch does not carry.** That is what makes this
worse than the family it looks like. Decisions 0012, 0017 and 0019 are each a run that did
not do its job and reported something other than failure; the work was missing and the report
was optimistic about it. Here the work was done, correctly, and reported honestly by the
agent that did it — and the pipeline threw it away behind the agent's back and called the run
a success. A reviewer ruling on that proposal approves an edit that does not exist, and
everything downstream treats the criterion as moved. **A run that fabricates success is a run
whose records have to be disbelieved**, which is a different and more expensive problem than
a run that failed loudly.

The prompt invited it. The build prompt listed the criteria the slice was answerable for and,
lower down, carried the condition asking for one of them to be moved off the slice. Those two
sections disagreed, and the builder resolved the disagreement in the only way it could see.

**Every stage with a temporary workspace had the same shape.** `build` carried `plan`, `spec`,
`design`, `tests/seed`, `constitution.md` and `.claude/skills` as writable and uncollected;
`bind-adapter` carried nine such paths, `derive-tests` eight, `design` three and `plan` four.
They were harmless only because nothing had yet asked one of those agents to write there.

**And `plan` had the inverse shape.** It collected `plan` and `docs/decisions` out of a
workspace that never held either, so a planner wrote both from nothing and the writeback
copied its files over the project's — leaving behind whatever the run had not happened to
rewrite. A revise run reached them by a different route (`revisionOverlayPaths`), so the
planner saw the plan it was revising on one path through the code and not on the other.

## Decision

### A workspace mode is read-only context, and `collect` is the output

The two declarations now mean different things and a path is named in one of them or the
other, never both. The mode is the committed material the agent reads. `stage.collect` is
what it produces: archived in alongside the context, so a stage always starts from whatever
the project holds where it is about to write, and the only part of the workspace copied back.

This is what makes the defect inexpressible rather than something to police. There is no
longer a way to say "the agent may write here" and separately "this is what comes back" and
have the two disagree, because there is only one list and it says both. A collect path may
sit inside a context path — a stage that reads a whole tree and writes one file in it, which
is what `design` does to `spec/contract/surface.yaml`. The reverse is refused: a context path
inside a collected tree is copied back wholesale and is therefore not context.

`plan` and `docs/decisions` are now in the plan workspace, by the ordinary route, because
they are what the stage delivers. A stage that writes over a directory it never read leaves
behind whatever it did not happen to rewrite, and that was true here on every full run.

### What is not collected is sealed, and a change to it ends the run

Read-only mounting is not available, so the second half of the invariant is enforced by
reading. Everything the workspace carries that this run will not collect is digested as the
session first sees it and read again after the turn. Any path that was written, deleted or
created there ends the run: a journal entry holding the agent's own text and the paths, a
run record, a commit, and `{ ok: false }` out to the caller. No proposal is opened.

The seal is taken after `prepare`, because `prepare` is the pipeline generating what the
agent is about to read and that is not a change the agent made. The collect is done before
the read, so whatever the stage COULD deliver is already in the working tree for a person to
look at — the same place a post-check failure leaves it. There is no fix turn: the work is in
a workspace about to be removed, and there is nothing in the project to repair.

The seal covers declared paths. A scratch file an agent drops somewhere the workspace never
declared is discarded as it always was, and that is the right boundary — nothing was promised
about a path nothing named.

`stage.context(ctx)` adds read-only context for one run. It is what lets a run narrow what it
delivers and still read the rest: `derive-tests --revise` reads a whole acceptance suite and
delivers one domain out of it, and the siblings and the shared bookkeeping files are now
sealed there rather than merely un-copied.

### The declaration is checked on every run, not only in the suite

A test over the registry catches the stages that exist today. The stage that gets this wrong
is the one somebody adds later, and that person may not run the suite — so `runStage` reads
the same check before anything is spent and refuses a declaration it cannot honour: a path
claimed as both context and output, a context path inside a collected tree, a collect list on
a stage that works in the project directory, an unknown mode, a collect path that could reach
outside the workspace. It reads two lists and touches nothing, so a run about to spend four
hundred turns pays nothing for it.

### A condition may not ask a stage for a path it cannot deliver

`splitConditionsByAddressee` routed by verb prefix: `addressed-to` and `test-overreaches`
went elsewhere and everything else was the returned stage's. Its own comment already admitted
what that leaves — a plain condition naming a file outside the stage's workspace, which the
stage "either fails or finds a way" at. This run is what finding a way looks like.

A return carrying such a condition is now refused when the verdict is recorded, naming the
path, what the stage being returned delivers, and the `addressed-to` line to write instead.

**Refusing at ruling time was chosen over routing it or handing it over with a disclaimer,
because the ruler is the only party who can put it right.** A ruling is a judgement about
what has to change; deciding which stage that is belongs to whoever made it. By the time a
`--revise` run reads the condition the ruler is gone, the stage reading it has no standing to
re-address someone else's ruling, and a note saying "this was asked of you and you cannot do
it" leaves the work unassigned while reading like an excuse. At the ruling it is one line,
and the pipeline already has the form for it.

Both seats reach the same ruling, as they must. A person typing `--by <role>` is shown the
refusal with the line to paste. A persona is told, in its prompt and before it rules, which
paths the stage this proposal goes back to can change and what to write when the work belongs
elsewhere — because a refusal after the ruling turn has been paid for is a worse way to learn
it than a sentence before.

A token in a condition is read as a path when it looks like one — it carries a separator or
an extension — and only when this pipeline has some say over it. "Rework the plan so the
second slice stands alone" names no file and is not refused; `plan/tasks.md` is. A path no
stage delivers is refused too, and says so rather than naming a stage.

### The prompt is generated from the same declarations the runner enforces

Every ephemeral workspace's prompt now ends with a note built from that stage's context and
collect lists: what travels back, what is there to be read, and that a change to the rest ends
the run. A stage's prompt and what the runner enforces cannot come apart, because they are the
same two lists.

The build prompt names `plan/tasks.md` as the source of the criteria a slice is answerable
for, and says the file is not the build's to change. The two sections that disagreed now say
where the disagreement would have to be settled, and it is not here.

## Consequences

An agent that writes where its stage cannot deliver costs a run instead of producing a false
record. That is the intended trade: the turn is spent either way, and the difference is
whether anyone finds out.

A ruler is refused a condition they could previously write, and is handed the line that works.
Rulings that named a path the receiving stage does deliver are unaffected, which is nearly all
of them.

`derive-tests --revise` now fails a run whose turn edited a sibling domain's tests, where
before the edit was silently not copied back. The post-check that judged the project tree saw
nothing to judge, so this is the first place that turn is reported at all.

The planner reads the plan and the decision records it is about to rewrite, on every run
rather than only on a revision. A stage that delivers a directory now always sees it first.

## What was considered instead

**Adding `plan` to build's collect list.** It closes this instance and opens a worse one: a
build could then rewrite the plan it is being judged against, and the gate that ruled the plan
would have nothing to say about it. What a slice claims is settled at the plan's own gate
(0024).

**Policing the workspace at runtime and nothing else.** The drift read is necessary — a
declaration cannot stop a process from writing to a directory — but on its own it makes the
mismatch a thing you discover by paying for a turn. Splitting the declaration is what makes
the mismatch impossible to write down in the first place, and the drift read is then the
backstop for the case the declaration cannot cover: an agent writing where it was told not to.

**Failing before the collect, so the project is untouched.** It reads as the safer half-step
and it throws away the part of the turn that was fine. A build's application work is the
expensive part, it is exactly what the stage does deliver, and leaving it in the working tree
for a person to look at is what every other failure in this runner does.

**Making the drift check a post-check the stage declares.** Post-checks are about the artifact
and they earn a fix turn. This is about the workspace, no stage should be able to opt out of
it, and a fix turn would ask the agent to undo work it was right to think it had been asked
for. It belongs to the runner.

**Routing an undeliverable condition to the stage that can deliver it, at read time.** It
would work for rulings already on disk, and it files work against a stage in the ruler's name
without the ruler having said so. A request filed that way carries no evidence the addressed
stage can act on, because the evidence belonged to a ruling about something else. Where the
refusal cannot reach — a gate file written by hand, outside `sdlc rule` — the seal catches it
on the next run and names the paths, which is the honest answer rather than a guess at intent.

# 0034 · A queue read as though it held one thing

Status: accepted · 2026-09-21

## Context

A ruling returned a proposal with two conditions addressed to the same stage. Both were filed
on `.sdlc/revision-requests.yaml`, exactly as `0024` says. That stage's `--revise` run then
read the head of the list and was handed one of them.

What follows from that is not a smaller version of the revision. The run answers one ask,
marks that one `taken`, and opens a proposal at the addressed stage's own gate — and that
gate is being asked whether the artifact is right now, with no way to tell that half of what
was asked of it never reached the run. The second request stays on the ledger, open, against
an artifact its own gate has just approved again.

**The two asks were entangled, and that is the ordinary case rather than the unlucky one.**
Both concerned the same kind of change, so an artifact that answers one of them on its own is
consistent with neither: the first ask's correction is made in a shape the second ask would
have changed. A ruler who routes two conditions to one stage means them together — they are
halves of one observation about one artifact, made while looking at the same evidence.

**The note that exists to stop this could not fire.** A revise prompt says how many conditions
on the ruling went elsewhere, to which stage and in whose words, precisely so a writer can
never be handed a shorter list than the ruling with nothing to explain the gap (`0024` §3). A
reopening reports nothing addressed elsewhere, because on that path nothing is: the gap is not
between the ruling and the list, it is between the list and the queue. The guard was reading
the wrong thing.

**The family is a queue read as though it held one thing.** The shape is a list whose first
entry is destructured out and treated as the whole of it, and the cost of it is never a
crash — it is an answer that is correct about what it covers and silent about the rest. The
same shape appears wherever the pipeline reads a ledger, and it is worth separating from the
cases that look like it: a guard that refuses a whole ruling while naming the first defect it
found writes nothing and loses nothing, because the ruler is still there and the next attempt
sees the next defect. A queue that is *consumed* one entry at a time has no such second pass.

## Decision

### 1 — A revision run is handed every open request addressed to its stage

The round is all of them, not the head. Each is numbered, quoted verbatim, and carries the
proposal, gate and seat it came from, since none of that is anywhere the stage can see. The
prompt says they are one round and asks for a result consistent with all of them at once,
which is the instruction the entanglement above calls for: answering them in sequence, as
separate jobs, is what produces an artifact half-consistent with each.

Numbering is not decoration. It is the reference a run uses to say something back about one of
them (§3), and a reference has to be something a turn can reproduce exactly — which a
sentence of the ruler's prose is not.

### 2 — The round is spent where the run delivers, and it moves whole

A request is spent by work, and until a proposal is opened there is no work. So the ledger is
marked in `finishStage`, after the proposal's commit lands and the checkout is back on `main`,
in a commit of its own that touches the ledger and nothing else — the same shape the filing
commit has, and for the same reason.

That is also what makes the failure paths honest. A run refused by a later pre-check, one
whose post-checks failed, one whose session was lost mid-turn: each of them ends with every
request still open, for the corrected re-run to find. An ask marked answered is an ask nothing
raises again, and the run that marked it never did the work.

**All of it moves or none of it does.** The ledger is read, every entry of the round matched
against it, and only then written — once. A round marked one entry at a time can be
interrupted half way and leave a file saying one ask was answered while its other half was
never asked, which is the defect above written down rather than merely performed. Where any
entry of the round no longer matches an open row — a round settled twice, a file edited
underneath — nothing at all is written.

### 3 — A run that cannot answer all of them says which, and those stay open

In its journal entry, on a line of its own, with the number the prompt gave it:

```
deferred-request <n>: <why it cannot be answered here>
```

A deferred request keeps its place on the list with no `taken`, so it is still open, it is
still read as part of the round the next time the stage is asked, and `sdlc checks` goes on
reporting it — now with the account of why the run that had it could not answer it. Every
request the run does not defer is recorded as taken up by that run, whether or not the gate
accepts what was done with it.

**Why not refuse the run instead.** A refusal is the safe answer to a round the stage cannot
answer whole, and it is also the answer that leaves the operator with nothing to do: the only
way to clear a revision request is to take it up, so a run that refuses over one impossible
ask makes the other asks unanswerable too. Deferring costs a line and leaves the ledger
saying exactly what happened.

**Why nothing judges whether an ask was answered.** That is a ruling, and `0032` settled that
it is not a computation: what counts as meeting an instruction is a judgement, and a mechanism
that guessed would close asks nobody answered. What is computed here is only whether anybody
claimed to have answered it. The claim errs in the safe direction — a run says what it could
*not* do, and the cost of a false one is an ask asked twice, while the cost of the silence
this replaces is an ask answered never.

**A number the prompt never issued defers nothing.** The run named something the round does
not hold, and guessing which request it meant is how a request nobody answered gets marked.
It is reported in the settling commit instead.

### 4 — A writer is never handed less than what is asked of its stage without being told

The accounting note has two halves, and each fires on its own. The first is the conditions on
the ruling being revised from that went to another stage, unchanged. The second is the
requests addressed to **this** stage that this run is not answering — which is what a
revision driven by a returned ruling is in the middle of, since an ask filed against the same
stage from somewhere else is open the whole time and is no part of that ruling.

They are named, with the proposal, gate and seat each came from, and they are **not** taken
up: nothing can tell an ask that the return already covers from one about something else
entirely, and taking one on that guess is the silent mark this record exists to remove. So
the request stays open, the writer knows it exists, and the run that answers it is the run
that was given it.

### 5 — Order is filing order, with one ruling's own requests kept together

Between rulings, oldest first: a request older than another was raised against an artifact
that has since been approved again, and reading it first is what puts the two in the sequence
they happened in. Within a ruling, together and in the order written, because that is the
unit a ruler composed — two conditions from one ruling are one observation and belong
side by side on the page the stage reads.

The order is presentation only, now that the whole round reaches the run. It matters for how
the asks read, not for which of them gets answered.

## Consequences

- A ledger row gains `deferred` beside `taken`: the account of a run that was given the ask
  and could not answer it. `sdlc checks` reads it back on the line that already reported the
  request as untaken, which until now said only that nobody had taken it up — the same thing
  it said before any run tried.
- A second `--revise` run started before the first delivers is handed the same round, where
  before the first run spent it on sight. What refuses that second run is the open-proposal
  check, which names the proposal standing open rather than a ledger row, and a run that was
  never going to deliver anything is no longer able to spend an ask by starting.
- A `plan --revise` that replays a return already recorded on `main` now splits that ruling's
  conditions the way every other read of a ruling does, so a condition addressed elsewhere
  does not reach the planner as its own work.
- The persona briefs say that two conditions addressed to one stage arrive together, on both
  the agent and the human path, because it changes what a ruler writes: there is no reason to
  choose between two true observations, or to fold them into one sentence.
- `0024`'s expectation that a request addressed to the stage whose proposal is being returned
  is taken up by that same revision is not what happens. It is named to the writer and stays
  open, for the reason in §4.

## What was considered instead

**Taking the whole round at the read, and releasing what the run did not answer.** It keeps
the spend where it is today and makes a release the exceptional path — which means the
ordinary crash, the lost session and the refused post-check all leave the round marked
answered, since none of them reaches the code that would release it. The failure modes are
exactly the ones that most need the ask to survive.

**Refusing to start a stage with more than one open request.** It is a guard that names the
problem and hands back no way through it: the requests can only be cleared by a run, and this
refuses the run.

**Reading the diff for the change each condition named.** The temptation every accountability
mechanism offers, and a ruling wearing a computation's clothes. A condition is prose; whether
it was met is a judgement; and a mechanism that guessed would mark asks nobody answered,
which is this defect with an extra step.

**One request per run, answered in sequence.** It is what the head-of-queue read looks like
when it is called a decision, and it is wrong for the case that produced this: two asks about
one artifact, answered by two proposals, each ruled without the other's change in front of it.

**A verb that withdraws a request.** It would let a ruler close an ask that should no longer
be asked, which is a real gap — a deferred request can only ever be answered, never dropped.
It is a change to the ruling grammar rather than to how a queue is read, and it is its own.

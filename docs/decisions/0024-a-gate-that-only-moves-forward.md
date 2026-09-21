# 0024 · A gate that only moves forward

Status: accepted · 2026-09-20

## Context

A reviewer returned a build proposal at G3 with five conditions. They belonged to three
different stages.

Two were `test-overreaches` lines, and those went where they were meant to: `0021` made the
ruling verb whose work `derive-tests` does, and the request reached the stage that could act
on it with the ruler's reason on it. Two were the builder's own, and a `build --revise` is
exactly what answers those. The fifth said a slice claims a criterion nothing it builds can
demonstrate, which is a statement about the plan.

Two defects follow, and they are the same defect from either end.

**A revise prompt carried conditions the stage could not act on.** `build --revise` maps the
whole `conditions` list out of the gate file into the prompt, so the builder was instructed
to carry out two requests already filed with another stage and one edit to a file its
workspace does not hold — `revisionOverlayPaths` for a build is `app` and `docs/decisions`,
and the plan is in neither. An agent told to do something it cannot do either fails at it or
finds a way, and the second is worse: the way it finds is a change nobody asked for, in a
proposal answerable for something else.

**The condition about the plan had no route at all.** `plan --revise` requires a returned
plan proposal, and the plan proposal was approved. There was nothing to reopen it with. The
remediation `verify` prints for an `unbound` slice offered exactly this exit — "change what
the slice claims in `plan/tasks.md`" — and the only way to take it was for a person to
hand-edit an artifact G2 had already ruled, with no proposal, no ruling and no record of why
it changed.

**The family is a pipeline whose gates only move forward.** Downstream work revealing an
upstream mistake is not an exotic case; it is the ordinary shape of discovery. The build is
what proves the plan wrong, and nothing about it was knowable when the plan was ruled. A
pipeline that can only carry a judgement to the stage after the one that made it cannot
express its own most common finding, and what it does instead is push the judgement into the
nearest stage that will take it — which is how a correct observation about the plan became an
instruction to a builder.

## Decision

### 1 — `addressed-to <stage>` is a condition that names where its work belongs

The condition form is

```
addressed-to <stage>: <what that stage has to change, and what showed it>
```

A verb, a target and a mandatory reason, the three parts `test-overreaches` has, read out of
a ruling's conditions at whatever gate the ruling was made. The target is a stage name rather
than a criterion id because what it asks for is a stage's whole output, and the reason is
required for the reason `0021` gives: the stage it reaches sees none of the evidence the
ruling was made on — not the proposal, not the diff, not the verify result — so a request
that says only "change this" arrives as the fact that somebody was unhappy.

This is the second instance of the mechanism `0021` proved, not a parallel one. The request
is filed on `main`, in a commit of its own, because the ruling belongs to the proposal branch
and the request does not, and a copy on a branch nobody merges is never read by the stage it
is addressed to. The reason travels verbatim into that stage's prompt, because a stage handed
the instruction to do its work again, with no account of what was wrong, does the same work
again.

**Why `test-overreaches` is not folded into it.** They differ in what the receiving stage is
told, and that difference is the whole value of the entry. `test-overreaches` names a
criterion, records the version it stands at, and asks for one test: the writer is told what
its replacement must not do. `addressed-to derive-tests` would name the stage and leave the
criterion, the version and the instruction to be reconstructed from prose. The specific form
carries more, so it stays; the general form is what exists for everything the specific forms
do not cover.

### 2 — The stages a condition may be addressed to are the ones that can be asked again

A stage is addressable when it has a revision mode, which it declares by having somewhere for
a revision to start from (`revisionOverlayPaths`). The set is read off the registry rather
than listed anywhere, so a stage that gains `--revise` becomes addressable with it and one
that has none can never be asked for work it has no way to do.

**Why not an enumeration.** A list of stage names in the condition reader is a second place
to keep in step with the stages themselves, and it goes stale in the direction that is hardest
to notice: a stage gains a revision mode, nothing addresses it, and the gap looks exactly like
a decision somebody made. **Why not a registration hook either.** There is nothing for a stage
to register: the property that makes it addressable is the property that makes it revisable,
and it already declares that. A name that is not a revisable stage files nothing and is
reported back to the ruler, the way `0021` reports a criterion the contract does not hold.

### 3 — A revise prompt carries its stage's own conditions, and accounts for the rest

A returned ruling is split where it is read, in `returnedRulingOn`, so every `--revise` stage
gets the same treatment without knowing about it: `conditions` are the lines the stage is to
act on, and every line addressed to another stage — `addressed-to` and `test-overreaches`
both — is taken out.

They are not taken out silently. The prompt says how many conditions were addressed elsewhere,
which stage each went to and what it said, and that the stage is to leave them alone. A stage
shown a shorter list with nothing to explain it cannot tell a ruling that asked less of it
from a ruling it was not fully given, and the ruling is on the branch it is working from, so
the discrepancy is visible to it either way. What it cannot do is reason about a gap nobody
named.

Inside a closed grammar nothing is taken out, for the reason `0021` gives: those lines belong
to the stage that owns the grammar, which may yet declare them unreadable.

### 4 — The reopening is ruled by the addressed stage's own gate

A request makes a stage revisable. It does not change the artifact, and it does not approve
anything. `<stage> --revise` with no returned ruling of its own takes the oldest open request
addressed to it, works from the artifact as it stands on `main`, and opens a fresh proposal
at the gate that stage holds — which rules it on its own question, exactly as it ruled the
artifact the first time.

**This is the part that decides whether the form is a hole.** An upstream artifact changed on
the say-so of a downstream reviewer, without its own gate seeing the change, would make every
gate as strong as the weakest seat that can name it in a condition: a G3 reviewer would, in
effect, be ruling G2. What the reviewer is trusted with is the observation — the build proved
the slice cannot demonstrate what it claims — and what the architect is trusted with is
whether the cut that follows from it is the right one. Splitting it that way is also what
keeps the two seats interchangeable with people: a person at G3 can raise exactly what the
persona raises, and neither can accept it.

The record of why survives. An entry is marked `taken` rather than removed, so what was asked
for, by whom, from which proposal and at which gate stays readable on
`.sdlc/revision-requests.yaml` long after the revision is merged — and the same text is in
the revision's own prompt, journal and proposal page.

### 5 — It cannot become a way around a gate

The verdict requests a revision and asserts nothing else. The filing commit writes
`.sdlc/revision-requests.yaml` and nothing else: no gate file, no artifact, no merge. Taking
a request up writes the same file and nothing else. The artifact changes only when a stage
runs, and is accepted only when that stage's gate rules.

**An approval may not carry the form, and is refused outright.** This is the guard that
matters, and it is refused on the human path and the agent path in the same place in the
sequence, before anything is written. An approval carrying it would put two claims on the
record at once — this work is accepted, and the thing it was built against has to change —
and merge the work on the strength of the first. A form with no reason is refused in the same
place and for the reason in §1.

### 6 — The briefs say so, and reach the projects that already exist

The form is documented in the briefs of every persona that holds a gate whose conditions are
free text, on both sides: what to write when the work belongs elsewhere, and what arrives when
a ruling elsewhere names your gate. `0023`'s reconciliation is what delivers it — a project
scaffolded before this gets the block on its next `init`, and one that wrote its own
instructions into a brief keeps them and is told what it is missing.

## Consequences

- `verify`'s `unbound` remediation offers a second exit that is a command rather than an
  instruction to go and edit an approved file by hand. All three of its exits are now rulings.
- A stage's revise prompt is shorter by exactly the conditions that were never its work, and
  says so. A ruler attaching a condition to the wrong stage finds out from the stage's journal
  rather than from the diff.
- `.sdlc/revision-requests.yaml` grows by one line per cross-stage ask and is never pruned. It
  is the only record of why an approved artifact was opened again, and one that is deleted
  when it is acted on cannot answer that afterwards.
- A request names a stage and not a scope. Where the stage is run per domain or per target,
  the run that takes it up is whichever one an operator starts, and the reason text is what
  says where the change belongs — so a scoped stage's request is worth reading before the run
  is started, not after.
- A condition addressing the stage that produced the proposal being returned files a request
  for work the return already asks for. It is not refused: the return is the stronger
  instruction and answers it, and the request is taken up by the same revision.

## What was considered instead

**Letting the ruling edit the upstream artifact directly.** It is the shortest path and it
removes the gate. The whole of the artifact's value is that a named seat ruled it against a
stated question, and an edit arriving from another gate has neither.

**Reopening by returning the original proposal again.** An approved proposal has been merged
and its branch is spent; there is nothing to return. Manufacturing a return for it would put a
verdict on the record that nobody reached, at a gate that was not asked.

**A single generic verb replacing `test-overreaches`.** It reads well and loses the version
the criterion stood at, the id, and the instruction about what the replacement must not do —
all of which `derive-tests` is given today and none of which survives being turned into a
sentence about a stage.

**Filing the request with the proposal rather than on `main`.** The same reasoning as `0021`:
the stage it is addressed to reads `main`, and a request on a branch nobody merges is a
request nobody reads.

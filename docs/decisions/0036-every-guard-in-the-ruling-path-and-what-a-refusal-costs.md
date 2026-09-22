# 0036 · Every guard in the ruling path, and what a refusal costs

Status: accepted · 2026-09-21

## Context

A ruling is one paid agent turn. It reads a proposal, a diff, the checks and — for a build
— the verify result, and answers with a verdict, a rationale and a list of conditions. Every
refusal in the ruling path fires *after* that turn, because the verdict is the thing being
refused, and each one therefore has the same power: it can throw a whole ruling away.

`0028` looked at that family and fixed part of it. Three line-shaped defects — a condition
verb used without its reason, a plain condition naming a path the returned-to stage cannot
deliver, an accounting line referring to nothing open — now get one re-prompt before the
refusal, because they are formatting slips rather than disagreements and a rewrite answers
them. Three other guards it examined and left throwing, each with a reason: an approval
carrying a return-only condition form, an approval with no passing verify result, and a
reply the verdict protocol could not be read out of. The first two shared one reason — there
is no line to rewrite, only a verdict to reconsider, and re-prompting for a verdict is
re-running the ruling under another name.

That reason was wrong about what a re-prompt is, and a run proved it. A ruling approved a
proposal and attached three routed requests (`addressed-to <stage>:`, `0024`). The guard
refused it, and the verdict, the rationale and all three requests went with it. The position
behind the ruling was coherent — the artifact in front of the ruler was right and other
artifacts needed changing — and only one of the three requests would have forced the ruled
artifact to change at all. Asking a ruler which of two claims it means is not asking it to
rule again: both ways out were already its own to take, and the pipeline picks neither. That
is what the re-prompt does, and it is what the guard should have done.

So the question is not which guards `0028` missed. It is whether every guard in the path can
account for itself, and the default that follows from the run above: **a guard that destroys
a ruling the persona already produced asks for it again, and not doing so needs a positive
reason.**

Two further silences turned up in the same sweep, and they are the reason this record covers
three things rather than one.

**A refused ruling was recorded nowhere.** No gate file is the point of a refusal. Writing
nothing else was not: a ruling that spent a turn, or two where a re-prompt was tried, left
the project indistinguishable from a proposal nobody had looked at, and the reasoning the
turn reached was gone with the session it was reached in. The refusal message said it once,
on a terminal, to whoever happened to be watching.

**A ruling had no sign-in pre-flight.** `preflightAuth` guarded the stages and not the
seats, so a stale credential was discovered inside the ruling turn — and twice, since a
failed ruling turn is retried once before anything says why.

## Decision

### 1 — Every guard that can discard a produced ruling, and what each now does

The re-prompt is one turn per ruling, not one per guard: all the defects a second turn can
answer are read together, in the order the refusals apply them, and the first is what the
re-prompt names. That is the ceiling the unparsed-conditions path set, for the reason it set
it — a reply that gets it wrong twice is no longer making a slip, and a batch running
unattended must not turn one stuck proposal into an unbounded retry.

**Re-prompts once, then refuses in the words it always used:**

- `assertOverreachRulable`, both branches: a `test-overreaches` line carrying no reason, and
  an approval carrying the form at all.
- `assertAddressedRulable`, both branches: an `addressed-to` line carrying no reason, and an
  approval carrying the form at all.
- `assertDeliverableRulable`: a return whose plain condition names a path the stage it goes
  back to cannot deliver.
- `assertAccountedRulable`, both branches: an accounting line carrying no reason, and one
  naming a condition nothing has open.
- `assertApprovalEvidence`: an approval on a build proposal the branch holds no current
  passing verify result for. The evidence is quoted back and the two verdicts that remain
  are named; both were already open to the ruler whatever the evidence said (`0022`).

**Does not re-prompt, and why not:**

- **The reply's own clean-tree check** (`rule: the ruling agent modified the working tree`).
  No ruling has been produced when it fires: it runs before the reply is parsed, so there is
  no verdict, no rationale and no condition list in hand. What it caught is a turn that broke
  the read-only contract the ruling path is built on, and a second turn would be asked to
  rule from a workspace the first one altered. The edit is deliberately left in place rather
  than reset, because the tampering has to stay visible where it was made.
- **`parseVerdict`** — no fenced block, unreadable JSON, an unrecognised verdict, a verdict
  with no rationale. Nothing parsed, so again there is no ruling to preserve: the protocol
  was not followed, which is a different failure from one line inside a followed protocol
  being wrong. A re-prompt for a malformed reply is a reasonable repair and is recommended
  below, but it restates the protocol rather than quoting a defect back, so it is a different
  piece of work.
- **The turn that failed after its retry.** There is no ruling and no reply; the one
  automatic retry is already the second chance, and a third would be a loop.

**Cannot discard a ruling, and is listed so nobody has to re-derive it:** every refusal
before the turn (a seat that does not hold the gate, an agent-held gate with nowhere to
escalate, a proposal with no gate line, an invalid config, the typecheck's own clean-tree
check, and the sign-in check added in §3) has nothing to destroy. Every failure after the
ruling commit (`mergeApproved`, the request ledgers, the condition ledger, the site rebuild)
leaves the ruling recorded on its branch, which is what those call orders exist for.

**The human seat runs the same five guards in the same order**, before anything is written.
It gets no re-prompt because there is no turn to redo: a person's conditions are theirs, the
refusal hands the whole ruling back, and the line that was fine can simply be given again
beside the one that was rewritten.

### 2 — A refusal that cost a turn says what it cost and what was refused

`recordRefusal` writes two entries on `main`, in a commit of its own.

The run record gains one line — the proposal, the gate, the seat, and the guard's own
sentence — which is what a person scanning what happened to this proposal reads. The journal
entry beside it holds the verdict, the rationale and every condition the ruling produced,
along with the turns and the cost, so an operator can act on the rest of a ruling by hand
instead of paying for the turn again to find out what it said. The cost lands in the state
site's total, where a turn spent on a refusal is counted rather than missing.

On `main` for the reason `0024` gives about routed requests: a refused ruling belongs to no
branch. The proposal is still open and may be ruled again or abandoned, and a record on a
branch nobody merges is a record nobody reads.

**Recorded from either seat, and for a turn nothing was read out of.** A turn that failed,
that wrote to the tree, or that came back in a shape the protocol could not read spent
exactly what a turn that answered spent, so it is recorded too, with the reply's failure in
place of a verdict because there is no verdict to keep. The human seat spends no turn and is
recorded at zero rather than left out: what happened to the proposal is the same fact from
either seat, and a record that carries it from one and not the other is a record of which
seat ruled rather than of what was ruled.

**Two refusals record nothing, each for its own reason.** A tampered working tree records
nothing at all, because `git checkout main` carries uncommitted changes across wherever the
file is identical on both branches, and switching branches to write the record would put
whatever the turn wrote onto `main` under a commit about a refused ruling. And a refusal
before the first turn records nothing, because there is no cost to account for and no ruling
to preserve.

Recording is best-effort and silent about its own failures. The refusal is what the caller is
owed and reaches them whatever happens here.

### 3 — A ruling checks that this machine can sign in before it spends its turn

`preflightAuth` runs on the ruling path, before the acceptance typecheck and the ruling turn,
exactly as `run` runs it before it starts a stage. It is a one-turn session against the same
config home, the same binary and the same flags the ruling turn will use, so it exercises the
credential the ruling will actually authenticate with rather than a proxy for it, and it
costs a fraction of a cent against a ruling turn that is paid for twice when it fails.

Under the mock executor it is skipped, which `preflightAuth` decides for itself, so neither
caller has to know and neither can forget.

A failure here records nothing, unlike the refusals in §2: no turn was spent and no ruling
was produced, and the proposal is left exactly as open as it was for the same ruling to be
made once the sign-in is good again. This is where the ruling path parts company with `run`,
which commits a run-record line for the same failure. A stage's record is the only account
that the stage was attempted at all, and `run` has created a branch and a workspace by the
time it asks; a ruling that never starts has changed nothing, and the operator is holding the
message.

## Whether the refusal of a routed condition on an approval should be narrowed

The guard refuses **any** approval carrying an `addressed-to <stage>:` condition. `0024`'s
reason is that such an approval puts two claims on the record at once — this work is
accepted, and the thing it was built against has to change — and merges the work on the
strength of the first.

The run behind this record is the case against a blanket rule. Three routed requests rode on
one approval. One of them bore on the artifact being ruled: it said the plan the work was cut
from claimed something the work could not demonstrate, and acting on it would have changed
what the ruled artifact was answerable for. The other two asked different artifacts to be
corrected and left the ruled one untouched — the kind of finding a reviewer makes in passing,
about a neighbouring artifact, that has nothing to do with whether the work in front of it is
right. For those two, `0024`'s second claim is simply not present, and refusing the approval
costs a revision cycle on work that was correct, or costs the observation, which the routed
condition exists to carry and which has no other channel.

**The distinction is real. It also cannot be drawn mechanically, and every proxy fails in the
dangerous direction.** Whether a routed request invalidates the ruled artifact lives in the
prose of the reason, which is free text written for a human at the other end. Three proxies
suggest themselves and none survives:

- **Pipeline order** — refuse where the addressed stage is upstream of the one being ruled.
  Wrong both ways: an upstream stage is routinely asked for a change that bears on nothing
  (a wording correction in an artifact the work never read), and a downstream stage can be
  asked for one that does.
- **The addressed stage's identity** — a fixed set of stages whose output a proposal is
  always built against. The same stage can be sent a request that invalidates and one that
  does not, in the same ruling, so the set answers a question nobody asked.
- **Reading the reason** — a phrase search over the reason text for a mention of the ruled
  artifact. This repository has already rejected that technique where it had less at stake:
  a persona brief is not searched for phrases, because a sentence scoped to one kind of item
  is indistinguishable from a rule covering everything. A proxy that is wrong here merges
  work built on something that has to change, which is the one outcome `0024` was written to
  prevent.

**My view.** Do not narrow the rule by inferring the distinction — there is no safe inference
available, and a blanket rule that is sometimes too strict is a better failure than a
narrowed one that is occasionally too permissive about a merge. But the right narrowing is
not an inference at all: the only reader who can draw this distinction is the ruler, so the
way to narrow it is to make the ruler **declare** it — a routed condition marked, in its own
form, as not bearing on the proposal being ruled. That puts both claims and the ruler's own
statement that they do not conflict on the record, where a later reader auditing a bad merge
can see who asserted it and on what; it keeps the pipeline out of a judgement it cannot make;
and a person in the seat can write it exactly as a persona can, which is the test any gate
mechanism has to pass. The residual risk — a ruler who declares wrongly — is the same risk
every gate seat already carries, and `0003` is where the pipeline accepted it.

**Recommendation: keep the blanket rule as it stands, and design the declared form as its own
piece of work.** The re-prompt has already removed the cost that made this urgent. A ruling
in this position now costs one extra turn and a choice the ruler was always entitled to make,
rather than the whole ruling, so the remaining cost of the blanket rule is bounded, visible in
the record, and no longer the thing that loses work.

## Consequences

- No guard in the ruling path can discard a ruling a persona produced without first asking
  for it again. The three that still refuse outright each destroy nothing that was produced,
  and the reason is written down beside each of them rather than inferred from their silence.
- A ruling costs at most two turns before it is either recorded or refused, whichever guard
  is involved. The ceiling did not move when the fifth guard joined the re-prompt, because
  the defects are read together rather than one guard at a time.
- Every refusal that cost a turn is answerable for it afterwards: the run record says it
  happened and the journal entry says what was produced, what was refused, and what the turns
  cost. A project's total cost now includes the rulings that were refused.
- A ruling that cannot sign in stops for a fraction of a cent instead of a ruling turn and its
  retry, and says which credential it reads and where from.
- Recommended next, and deliberately not done here: one re-prompt for a reply the verdict
  protocol could not be read out of, restating the protocol. It is the last place in the path
  where a turn's reasoning is thrown away, and it is now the only one.

## What was considered instead

**Leaving `assertApprovalEvidence` throwing, as `0028` did.** Its reason was that a missing
result is a fact about the branch with no line to quote back. That is true and it is not the
point: what is quoted back is the evidence, and what is asked for is a verdict the evidence
supports — both of which were already the ruler's to give. The same reasoning had already
been overturned for the condition-form guard, and inheriting it here would have been
inheriting a judgement rather than making one.

**A re-prompt per guard.** It reads as more generous and is a loop with extra steps: five
guards at one turn each is five turns for a reply that never converges, and a batch has no
one watching it.

**Recording a refusal on the proposal's own branch.** It is where a successful ruling's
records go, and it is wrong for a refusal: the branch may be abandoned, and the point of the
record is that somebody reading the project afterwards can tell a refused ruling from a
proposal nobody looked at.

**Recording the refused ruling as a gate file or a proposal section, flagged unusable.**
Rejected for the reason `0028` rejected it: a record shaped like a ruling that must never be
acted on is a trap for whatever reads gate files next. The journal entry is prose about a
refusal, which nothing executes.

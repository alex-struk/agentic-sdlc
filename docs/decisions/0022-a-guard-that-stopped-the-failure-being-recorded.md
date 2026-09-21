# 0022 · A guard against a false pass that also stopped the failure being recorded

Status: accepted · 2026-09-20

## Context

A build proposal is ruled at G3 on evidence the acceptance suite has already produced
(`0011`): the result file on its branch says the application as it stands passed the
criteria the slice claims. `buildVerified` is what holds a ruling to that — the proposal
names a slice, the result must be for this proposal and for this tree, and its verdict must
be `pass`.

It ran first. Before the persona brief was read, before the prompt was built, before there
was a verdict of any kind, the agent path asked whether the build had passed and refused the
call outright when it had not. What that refuses is not an approval; it is the ruling. A
slice whose verify run reported `unbound` — the adapter could not reach the criteria the
slice claims, so nothing about the application was tested — could not be ruled by the agent
holding its gate in any direction at all. Return, which is the correct ruling for it and
which asserts nothing about the application, was refused for want of evidence that a return
does not need.

The proposal was then stuck. Verify writes no gate file for an `unbound` run, because
nothing was tested and there is no verdict on the application to record, so `build --revise`
is refused for want of a returned ruling and a fresh `build` is refused because the first
proposal is still open. The two exits left were a person typing `--by`, where the guard was
not enforced at all and so anything was permitted, and three verify returns, which is a
ceiling that exists to catch repeated failure rather than a route out of the first one.

The reasoning that dissolves it was already in the file, one case narrower. The exemption
for an escalation says an escalation is ruled *precisely because* the result is not a pass,
and must not be refused for it. That is true of a return for exactly the same reason, and
it is true of the return whether or not anyone escalated first.

**The family is a guard that prevents a false pass and, in doing so, prevents the true
failure from being recorded.** A check written as "this must be true before we go on" reads
as a safety property and behaves as a lock: the state it refuses to leave is the state
somebody has to get out of. The corrective is always the same shape — bind the check to the
outcome it is actually about, not to the act of reaching for it.

## Decision

### 1 — The guard binds the verdict, not the call

A build proposal is approved only where a current verify result says the application on its
branch passed. A return or an escalation is held to nothing: neither asserts anything about
the application, so neither has anything to be evidenced by, and both are exactly what a
slice the suite could not exercise needs.

It remains impossible to approve a build proposal without a current passing result. That is
the whole of what the check was ever for, and it is unchanged: a result missing, for another
proposal, for an earlier tree, or carrying any verdict other than `pass` refuses the
approval in the same words it always did.

### 2 — It moves to where the verdict is

The check now runs once the ruling turn has answered and the `escalate` verdict has taken
its own exit, alongside the other refusals a ruling is subject to.

That point is safe because nothing about the ruling has been written by it. The typecheck
has run and the working tree was asserted clean afterwards; the ruling turn is read-only,
holds no write tool, and the tree is asserted clean again when it returns. No gate file, no
`## Ruling` section on the proposal page, no commit, no merge. A refusal here leaves the
proposal exactly as open as it was, for a ruling that can be made again — the same property
the conditions checks beside it are placed there to have.

The cost is a ruling turn spent on a proposal that is then refused its approval. It is worth
paying: the alternative is the check running while the answer to its own question is still
unknown, which is what produced a proposal with no exit.

### 3 — A person in the seat is held to the same rule

The human path enforced nothing. That is the same defect on the other seat, not a licence: a
build approved without a passing result is a slice merged onto the trunk with the state site
reporting it accepted and no run behind it, and who typed the approval does not change what
was recorded. Phase 0 authenticates neither seat (`0003`), so the seat is not a trust
boundary and cannot carry a permission the other one lacks.

It is also what the substitution promise means. A person sits in any gate seat in place of
an agent and rules identically; a guard enforced on one path and not the other makes the
seat, rather than the evidence, decide what may be signed off.

### 4 — The escalation is the override, and it is already a record

One approval goes through without a passing result: the ruling made by the target of a
standing escalation, on either seat, on an escalation somebody else raised.

This is not an exception carved out for convenience. It is the only way a slice that has
exhausted the verify retry ceiling can ever be finished — a fourth build is exactly what the
ceiling exists to stop — and it is the one place in the pipeline where approving without
evidence is a judgement somebody made rather than a check that was skipped. The branch
carries both halves of it. The escalation names who raised it and why; the ruling commit on
top names who overrode it and why; both merge with the approval. An override nobody can
read afterwards is indistinguishable from the defect, and this one cannot be made without
writing two records first.

Nobody rules their own escalation. Raising one and then answering it is a single actor
producing both halves of the record, which is no record at all.

### 5 — The batch leaves such a build alone, and now says so

`rule --pending` asks a different question of the same result and keeps a different answer.
A batch rules on the merits, and the merits of a build are what the suite found; before
there is a result for this tree there is nothing to rule, and the proposal is passed over in
silence, with no failure line and no run record, because there is nothing wrong with it to
report.

Where the suite did run and did not pass, the skip is said out loud, naming the reason and
the call that reaches the ruling. A proposal that never appears in a batch it is eligible
for reads as one nothing is waiting on, and this one is waiting.

What the batch must not do is rule it by itself. The ruling that fits a slice the adapter
could not reach is a return or an escalation, and an automatic return sends the builder to
rebuild an application that may be perfectly sound while spending one of the three attempts
the ceiling counts. Naming it and stopping puts the judgement where it belongs without
hiding the proposal.

## Consequences

- A slice the suite could not exercise is ruled by whoever holds its gate, in the direction
  that is true, and the ruling lands on the branch the same way every other ruling does.
- Approving a build costs the same evidence it always did, from whichever seat, and now
  costs a ruling turn first when the evidence is absent.
- The approval that overrides the evidence exists only on top of an escalation, and reading
  the branch shows who raised it, who overrode it, and both reasons.
- `rule --pending` prints one line for a build it is leaving open. A batch that used to be
  silent about such a proposal now accounts for it.

## What was considered instead

**A flag on the human seat that permits the approval.** It records that somebody overrode
the guard and nothing about why, on a seat that has no turn and no rationale to attach one
to; and it gives a person a power the persona in the same seat does not have, which is the
substitution promise broken to patch a hole the escalation route already closes properly.

**Keeping the check first and exempting the rulings that do not need it.** Nothing at that
point knows which ruling is coming. A ruler's stated intention before its turn is not a
verdict, and a check that acts on one would be trusting the answer to the question it was
put there to ask.

**Letting the batch rule an unpassed build.** It closes the same hole and opens a worse one:
a slice returned automatically for evidence that was never about the application, a builder
sent to rebuild working code, and an attempt spent off the retry ceiling each time the batch
runs.

# 0039 · An escalation that reaches nobody

Status: accepted · 2026-09-21

## Context

An escalation is a hand-off. The seat holding the gate will not rule, so the question goes to
the role the policy names in `escalate_to`, and the proposal waits for that seat.

A gate escalated to a role; an agent holding that role ruled the escalation and escalated
again, to the same role. The gate file was written without objection: `by: agent:<role>`,
`escalate_to: <role>`, and a rationale. Every line of it reads like a hand-off, and nobody had
been handed anything — the same agent is named as the one who could not rule and as the one
who will.

The gate whose holder *is* its own escalation target reaches the same place in one step and
can be asked again indefinitely, a turn at a time, with each ruling producing another gate
file that looks like progress.

What made this hard to see is that the pipeline's account of it was correct on every line it
wrote. `escalate_to` really is what the policy says; the rationale really is the ruler's. The
missing fact was the one nothing recorded: that the two names are the same, and the proposal
has not moved.

## Decision

### An escalation naming the role that raised it is recorded, and marked stalled

Both escalation paths — the persona's own `escalate` verdict and the mandatory escalation that
never asks the persona anything — compare the escalating seat against the target. Where
`by` is `agent:<role>` and `escalate_to` is that same role, the ruling is written whole and
carries one more line:

```yaml
stalled: "agent:<role> escalated to <role>, the role it holds itself, so no seat this pipeline
  can fill is waiting on it: a person has to rule it, or the proposal has to be withdrawn."
```

The verdict, the rationale, the metrics and the `escalate_to` the verdict named are all
written exactly as they would have been. `escalate_to` is kept because it is what was ruled,
and removing it would make the record less true rather than less misleading; the `stalled`
line is what stops the pair reading as a hand-off.

### Recorded rather than refused

The alternative was to refuse the verdict and re-prompt, which several guards in this path now
do (`0036`). Three reasons against it here.

A refusal would destroy a ruling the persona produced, and that is the trade `0028` and `0036`
both came down against. The rationale on a stalled escalation is often the most valuable thing
in the whole exchange: it is the terminal ruler saying what the pipeline cannot do, which is
the one account of why a person is needed.

A re-prompt asks for something the ruler cannot honestly give. The other two verdicts are
approve and return, and a ruler that has just said the decision is above the pipeline is being
asked to rule the thing it said it could not. That is the distinction `0036` drew: a re-prompt
is legitimate where both ways out were already the ruler's own to take, and here they are not.

And a refusal leaves nothing behind on the proposal. The point of this change is that a
proposal going nowhere should be *visible*, and a refused ruling reads as a proposal nobody
has looked at — the silence `0036` §2 was written to end.

### Said where an operator meets it

A line in a gate file on an unmerged branch is not visibility. The stall is reported in five
more places, each one somewhere a person is already looking:

- on the terminal, in the turn it happened, beside the verdict;
- in the run record line and the ruling's commit message;
- on the gate log and the proposal page of the state site, with the ruler's reasoning kept;
- in the site's counts, apart from open escalations — because an open escalation means
  somebody is expected to rule it, which is the opposite of what this means;
- in the refusal a stage gets when it next tries to run behind the still-open proposal. That
  refusal used to say "rule it (or delete the branch)", and "rule it" is the instruction that
  produced the loop.

### What keeps working

The test is a comparison of two names and nothing else, so both legitimate cases are
untouched:

- **A role escalating to a different role.** `by` and `escalate_to` differ, and the escalation
  is an ordinary hand-off.
- **A person in the seat ruling an escalation an agent of the same role raised.** A human
  `--by <role>` never carries the `agent:` prefix, so a person is never the author of a stall
  — which is right, since a person in the seat is the way *out* of one. The human path cannot
  escalate at all.

## Consequences

- A proposal that is going nowhere says so, on its own gate file and on every surface that
  reports the project's state, in the turn it happens.
- No ruling is thrown away to achieve it. The reasoning that reached the stall is the reasoning
  a person needs in order to settle it.
- The batch already declined to rule an escalation raised by an agent of the target role, so a
  stall never costs a second turn in an unattended run. What was missing was any record that
  the batch was stepping over something, and the stall is now that record.
- A gate configured with the same role as holder and escalation target is not forbidden — it
  is a reasonable way to say "the terminal ruler holds this gate" — but its escalations are
  now marked for what they are on the first one, rather than on the second time somebody
  notices the cost.

## What was considered instead

**Refusing the configuration** — rejecting a policy whose `holder` and `escalate_to` name the
same role. It forbids a shape that is legitimately used to say a gate has no higher seat, and
it does nothing about the case that produced the defect, where the two gates' roles are
different and only the ruling seat coincides.

**Routing the second escalation somewhere else** — a chain of escalation targets, or a fallback
role. That is the pipeline picking a ruler, which is the one thing a gate mechanism must not
do, and there is no seat above the terminal one to pick.

**Marking the proposal closed or withdrawn.** A stall is not an outcome. The proposal is still
open and still rulable — by a person, which is precisely what the stall says — and recording it
as finished would assert a decision nobody made.

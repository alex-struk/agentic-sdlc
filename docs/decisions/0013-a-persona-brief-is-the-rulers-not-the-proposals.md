# 0013 · A persona brief belongs to the ruler, not to the proposal

Status: accepted · 2026-09-20

## Context

`sdlc rule` can escalate before the persona is asked anything, so that a gate a persona holds
but will not rule alone never costs a turn. The trigger was a phrase search: if the brief
contained "always escalate", in any capitalisation, every proposal at that gate escalated.

A brief is prose written for the agent that reads it, and prose says *when*. The installed
tech-lead brief said "Always escalate a platform-article change" — a rule about one kind of
item, changes to a platform article. The search cannot see that scope. It read the sentence as
a rule covering every gate, and the tech lead escalated everything it was ever handed, at zero
turns, giving as its reason that its own brief said to.

That mattered more than a phrasing bug, because the tech lead is the terminal ruler of a
simulated run: every other persona's escalation is routed to it. With the tech lead unable to
rule, nothing escalated could ever be settled inside the pipeline.

The brief was reworded to remove the phrase. That fixed `main` and not the run, because a
ruling reads the brief off the proposal's own branch — which a ruling has checked out — and a
branch opened weeks earlier carries that day's briefs. Proposals still open when a persona is
corrected keep being ruled by the instructions the correction removed, and nothing says so.

## Decision

**A gate a persona will not rule alone is declared, in a YAML front-matter block at the top of
its brief.**

```markdown
---
escalates: [G-POL]
---
# Persona: tech-lead
```

The prose still says why, for the agent. The list is what the runner acts on, and the front
matter is stripped before the brief reaches the prompt, so the agent is not asked to reason
about a field it cannot act on. Nothing is inferred from the prose.

**The brief is read from `main`, not from the working tree.** The brief is the ruler's
instruction sheet; it is not part of the proposal being ruled, and it does not belong to the
proposal's branch. A project whose `main` carries no brief for a persona falls back to the
working tree, which is how a brief written and not yet committed still works.

## Consequences

Turning a persona off is now something a person does on purpose, in a field, and can see by
reading four lines at the top of a file. It cannot happen as a side effect of how a sentence
was worded.

Correcting a persona takes effect immediately, including on proposals opened before the
correction. The alternative — each proposal ruled by the briefs of the day it was opened —
reads like reproducibility but is not: nothing records which brief was used, so a ruling that
looks wrong cannot be traced to the instructions that produced it.

Everything else a ruling reads still comes from the branch. The config's gate block in
particular is the policy the proposal was made under, and stays with it.

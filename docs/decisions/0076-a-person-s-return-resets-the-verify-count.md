# 0076 · A person's return resets the verify count

Status: accepted · 2026-09-30

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

`verify` escalates a slice to G3's `escalate_to` on the return that reaches
`policy.loops.verify_returns`, counting every `runner:verify` return across the slice's build
proposals (`docs/decisions/0011-build-verify-review.md`). The limit exists to put a person in front
of a slice the build-and-verify loop is not closing.

Once the person has read the escalation and returned the slice with a condition, the count still
included every return before that ruling. The build the person asked for then escalated on its
first failure, however small, and the person was asked the same question again before the builder
had had a round on the condition they set.

## Decision

A return at G3 written by a person, meaning `by` names a role rather than an `agent:` seat or the
runner, resets the count. Only `runner:verify` returns on proposals numbered after that ruling count
toward the limit. The order is the family's proposal numbers, which only grow.

A return by an agent seat does not reset it. An agent answering its own escalation could otherwise
keep the loop going without a person ever seeing it.

## Consequences

- A person who returns an escalated slice buys the builder a full set of rounds on the condition,
  as many as the policy allows any build.
- The escalation still reaches the person again if those rounds do not close the slice.
- A human replacing the agent at G3 changes nothing here: the rule is about who ruled, not which
  seat holds the gate.

# 0010 — In a simulated run, an escalation is ruled by the simulated tech lead

**Status:** accepted · 2026-09-18

Every agent-held gate names an `escalate_to`, and until now only a person could rule an
escalation: the code refused an agent acting as its target. A first run is simulated end to end,
so each escalation stopped that run for a person who had not been asked to take part in it, and the
ruling ended up written by whoever was operating the pipeline, under the tech lead's role.

## Decision

An escalation is ruled by the agent playing its target when the project simulates that role. A
role is simulated when the policy has an agent holding a gate as it — `G-POL: { holder:
"agent:tech-lead" }` says the tech lead is simulated, and no separate setting says it again. The
target is shown the escalating persona's own account and rules the proposal as a holder would.
`sdlc rule --pending` hands open escalations to it in the same batch as every other ruling.

A persona never rules its own escalation. When the simulated tech lead escalates, the run stops
for a person, and the tech-lead brief says when to do that: when the reason is the pipeline itself
— a stage that cannot produce what its gate asks for, a return that does not reach the fault, a
missing tool — rather than a question about the project.

A project whose tech lead is a person names the role bare in its policy, and its escalations go
to that person exactly as before.

## Why

The four escalations of the first run divide cleanly. Where the question was about the project —
which components a design may build itself — an agent can rule it the way the holder would have,
given the account of why the holder would not. Where the question was the pipeline — a return that
never reached the faulty requirement, a derivation overwriting a shared file, a design with no tool
to check it — no ruling fixes it; the pipeline's owner does, and the run should stop and say so.

## What would reverse it

The simulated tech lead approving what a person would have refused, visible because every such
ruling carries `by: agent:tech-lead` and the escalation it answered.

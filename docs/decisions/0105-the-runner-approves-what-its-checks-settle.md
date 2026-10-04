# 0105 · The runner approves what its checks settle

Status: accepted · 2026-10-04

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Every proposal at an agent-held gate is ruled by a persona turn, which takes about a minute. A
slice of the Build phase opens eight or so of them, and for three stages the persona's approval
mostly restates checks the runner has already made. A derivation's tests compile, nothing was
deleted, and every changed test asserts at least what it did. A contract only adds to itself. A
binding changes the adapter and nothing else. Where those hold and nothing is owed, the approval
says what the checks said, a minute later.

What a persona does that no check does is judge: whether a revision answered what its return asked,
whether a test asserts the criterion and nothing about how the system is built, what an escalation
should come to. None of that is restated by a check, and none of it can be skipped.

## Decision

**A gate may let the runner approve proposals from some stages itself.**
`policy.gates.<gate>.auto_approve` names them, from `bind-adapter`, `derive-tests` and `contract`;
none by default. The runner approves one only where every check holds: the stage is listed; the
ruling is the holder's own, with no escalation standing and none being ruled; the acceptance
typecheck passed (a contract has none to pass); no ruler has asked anything of it that only a ruler
can say was done (an open condition or revision request, read from the ledgers the persona's prompt
is shown), and it is not a revision of a returned proposal; and, measured from where its branch was
cut, a derivation deleted no acceptance file, has no changed test calling `expect(` fewer times and
no added test calling it not at all, a contract deleted no line, and a binding changed nothing
outside what its stage delivers. The work a stage is routinely sent (an unbound row to bind, a test
to derive again, a missing test) is not something a ruler asked: whether it was done is what the
next verify measures. Every guard an approval from the seat passes must pass it
too.

**It is recorded as the persona's approval would be,** with `by: runner:checks`, a cost of
nothing, and a rationale naming the policy and each check that held. It is given in the persona's
seat, so it is sampled for a person to read back as the persona's approval is.

**Where any check fails, the persona is asked exactly as before.** Its prompt says nothing new,
and nothing is recorded about the check that failed.

## Consequences

- A proposal that only restates the checks is approved without a turn; one that answers a
  condition, a request or a return, or one any escalation touches, is ruled by the persona, always.
- A binding sent for unbound rows and a derivation sent for tests to derive again or missing tests
  are approved on the checks. A binding that reads the page wrongly, or a test that asserts the
  wrong thing while asserting as much as before, is no longer read by a persona before it merges:
  the first is found by the next verify, and the second only by the persona's sampled read-back
  or a later ruling.
- It does not return or escalate anything, and it adds nothing to the persona's prompt.
- It does not apply to a gate a person holds, which the person rules as before; `sdlc checks`
  refuses a list there, and one naming a stage whose proposals are ruled at another gate.
- It does not reach a policy change, which is ruled only at G-POL, or a build, a design or a plan.

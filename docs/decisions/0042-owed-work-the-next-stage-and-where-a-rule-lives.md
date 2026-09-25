# 0042 · Owed work, the next stage, and where a rule lives

Status: accepted · 2026-09-24

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Three gaps share one cause: something the pipeline needs to know, it leaves to whoever happens
to be at the keyboard.

**An untestable criterion is approved and then nothing asks for its test again.** The test
writer records a criterion as untestable with a reason and what would unblock it, and a gate
rules on that record. The ruler is asked whether the claim is true, and a true claim is
approved. Nothing is asked afterwards to supply what was missing. A criterion protecting against
executed markup was recorded this way and approved on a sound argument that never weighed what
the criterion protects, and its test was then owed by nobody. The route that sends a
calibration failure back to the contract (`0007`) does not reach these records, because an
untestable criterion is never run, so it never fails.

**Nobody decides what runs next.** The design fixes phases, stage order and exit criteria, and
the engine runs one stage when told. Which stage to run, including going back to an earlier one
because a later one found it lacking, is chosen by the operator. That is a decision the recorded
state could settle, taken where it is not recorded.

**Rules have drifted into the engine.** The design keeps retry bounds and routing in config
(`docs/specs/` §5) and judgement in skills and briefs. An audit against that split found about
thirty engine rules correctly placed and sixteen items out of place: limits written as
constants, loops the design bounds and the engine does not, policy keys the schema accepts and
nothing reads, judgement written into prompt strings a project cannot override, and a policy
change that is ruled neither at G-POL nor under the policy it is changing.

## Decision

**A missing test is owed, not approved.** A criterion recorded as untestable becomes an open
item naming what is missing and the stage that owns supplying it. It stays open until a test
that runs exists. Proof by other means counts only as a named test the application carries and
verify executes. An item nobody can close is withdrawn by a ruler with the reason written down.
Whether an open item blocks a slice's approval is policy.

**The pipeline keeps no list of reasons.** The record names an owner, and anything that can be
missing is owned by some stage. A new kind of blocker needs no new rule.

**Owed work is one mechanism.** Conditions, cross-stage requests, re-derivations, rebinds,
recoveries and missing tests are kept as one list with one entry shape and a kind, read from
`main` by the stage that owes an entry and by the ruler of what it produces.

**The next stage is read from the record.** `sdlc next` names the next stage and why, from phase
exit criteria, owed items, stale tests, open proposals and slice order. It only reads. An
operator may run something else, and the run records what `next` named and the reason given.
A change to a record file outside a pipeline commit is flagged, warning or failing by policy.
It is triggered by a stage finishing or a ruling being recorded. Printing it comes first; a
loop that runs it and stops at a person, a failure or a dead end comes after it has run cleanly;
restarting that loop from a person's ruling comes when people hold seats.

**Rules move to their layer.** The items the audit found move to config with today's values as
defaults, or to skills and briefs, as listed in `docs/operating-model.md` §5. Two change
behaviour: ratify escalates a requirement it cannot confirm within its follow-up limit instead of
marking it obsolete, and verify refuses to run when G3 names no escalation target instead of
assuming one. `policy.budgets` counts turns and is named for it.

**Risk tiers stay dormant.** They are documented as inactive and removed if they remain unused.

## Alternatives

**Escalate an untestable record by the criterion's risk tier.** It needs something to assign a
tier to every criterion, and it answers only for criteria above the threshold. Everything below
it is still approved on the claim alone and still owed by nobody.

**Escalate every untestable record.** Most are not yet testable for mechanical reasons, such as
missing seed data or a thin observation, and belong with the stage that can supply the missing
thing, not with the tech lead.

**Classify each record by reason and route by class.** The classes available the day this was
decided were already incomplete: some records turned out to be defects in the criterion itself.
Naming an owner covers every class without listing them.

**Leave sequencing to the operator.** It works while the operator is careful, and it leaves the
choice unrecorded and the operator's seat irreplaceable.

## What would reverse it

A project in which owed items accumulate faster than any stage clears them. The mechanism would
still be right, and whether an open item blocks a slice would move in policy. The same goes for
a `next` whose recorded deviations show it routinely wrong: that is evidence against its rules,
not against reading the next stage from the record.

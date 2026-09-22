# 0040 · A record that invented human accountability

Status: accepted · 2026-09-22

## Context

A gate ruling is made from one of three places. A persona agent reads the gate holder's
written brief and rules in that role. A person runs the command themselves. And the runner
writes a verdict of its own: when an acceptance run fails, `verify` records a return at the
build gate, `by: runner:verify`, `held_by: runner`, with the failing rows as its conditions.
That third one has been written since the verify stage existed.

The state site knew two. Every reader asked whether `held_by` was the string `agent` and
took the false branch to mean a person, so the runner's automatic verdict was published in
the gate log's seat column as `human`, and on the HTML page as a chip reading **a person**.
The proposal page said `return by runner:verify` with no qualifier at all, where an agent
ruling was qualified `(persona agent)` — so the absence of a qualifier was itself the claim
that a person had ruled.

The project's owner read the published page, found a return attributed to a person, and
asked whether he had made a decision nobody had put to him. That is the cost of getting this
column wrong in this direction. It is the column that answers "did a person decide this?",
and a reader has no way to tell an invented sign-off from a real one — so one invented entry
devalues every true entry beside it. An audit trail that manufactures human accountability
is worse than no audit trail, because no audit trail at least declines to answer.

The mechanism was not a missing case. It was a two-valued mapping over a three-valued field,
written as a ternary, with the most consequential of the three values as its default. Five
readers each made the same choice independently, and each was right when it was written.

## Decision

### 1 — Three seats, named in one place

`src/lib/seat.mjs` holds the mapping and the vocabulary, and every reader and the one writer
go through it. `seatKind` places any value at all — a string none of the three names, a field
that is absent, something that is not a string — and `seatLabel` gives each kind the words it
is shown in, so the Markdown record in the repository and the HTML page a person reads cannot
come to disagree about which seat ruled.

| `held_by` | Shown as |
|---|---|
| `agent` | persona agent |
| `human` | a person |
| `runner` | the runner, automatically |
| anything else, or absent | unknown seat (`<value>`) |

**"the runner, automatically", not a third role.** The brief for this vocabulary was that a
runner ruling is not held by anyone in the sense a gate seat is. A name shaped like a job
title — "the runner" alone, or "automation" — sits in the column beside two seats that *were*
held and reads as a third one, which is the same category error in gentler words. The phrase
says what happened: the verdict was produced, nothing was held, nobody was asked. The HTML
chip is muted rather than coloured for the same reason; a colour of its own would give it the
visual weight of a role.

An unrecognised value is quoted back rather than described, because the reader's next move is
to go and look at the gate file and they need to know what they are looking for. It is quoted
safely: a Markdown cell ends at the first `|`, and the value comes off a file that can hold
anything, so whitespace collapses, the delimiters that would break the row are dropped, and a
long value is cut.

### 2 — The mapping is total, and its default is the least consequential reading

An unknown seat resolves to `unknown`, never to `human`. This is the structural half of the
fix and it is what makes the next value safe as well as this one: a `held_by` written by a
later version of the pipeline, or by a hand editing a gate file, is reported as something the
site cannot place instead of being quietly read as a person.

Unknown is the default because it is the least consequential reading available, not because
it is the likeliest. Where a mapping has to guess, it guesses towards claiming less.

The same mapping runs on the write side. `rule` derived the seat from whether `--by` began
`agent:`, with everything else falling to `human`; it now derives it from the prefixes that
name what produced a ruling — `agent:` and `runner:` — with a bare role meaning a person,
because naming the role you are sitting in is how a person rules and nothing else does it
that way. Gate holders are validated as roles or `agent:<persona>`, so no `runner:` value
reaches this path today; the derivation is total anyway, for the reason above.

### 3 — Each seat is counted on its own

The index reported `Agent-held rulings` and nothing else about seats, which left every other
seat to be reached by subtraction — and subtraction returns one number covering a person's
decision and the runner's arithmetic alike. It now reports four counts, one per kind, each
excluding escalations for the reason it always did: an escalation decided nothing and is
counted as an open escalation instead.

### 4 — Sampling

`human_sample_per_week` is a per-gate, per-ISO-week cap: the first N agent-held rulings that
week are marked for a person to read back. It is a spot check on agent judgement, so only a
persona agent's ruling is eligible, and the two other seats are out for reasons of their own.
A person's ruling is what the sampling exists *for*. The runner's verdict is a test result
written down — there is nothing a second reader could reach a different view on, and marking
it for re-read would spend a week's quota on arithmetic. An unknown seat is out because
nothing is known about it, least of all that it is an agent.

That is what the sampling code already did, and it is now expressed through the total mapping
rather than through the same `!== "agent"` test that was wrong five lines away. **No sampled
ruling was ever wrong, and no agent ruling ever lost its re-read to a runner ruling.** What
was overstated is the seat column itself: every verify return published a row claiming a
person ruled it, so the count of human involvement a reader takes off the gate log was
inflated by exactly the number of verify returns — which is the gate that carries the sample
quota, and the gate a build proposal is returned from most often.

### 5 — The seat column says the seat; the sample column says the sampling

The Markdown gate log's seat cell read `agent-held, unsampled` for every agent ruling,
including the ones its own `Sample` column marked `sample` on the same row. Two columns
claiming the sampling, one of them unconditionally, is a row that contradicts itself. The
seat cell now names the seat and nothing else, the `Sample` column is the only place a row
says anything about sampling, and the column is headed `Made by` in both renderings. `0003`
quotes the old cell text where it explains that phase 0 records assertions rather than
authenticated facts; that reasoning is untouched and the cell it points at now reads
`persona agent`.

## What `verify` should write, and what it should not

The question is whether `held_by: runner` is the right thing for an automatic verdict at all,
or whether it should be represented as something other than a held gate.

**Keep it, and keep it in `held_by`.** The alternatives split one fact across two fields. An
`automatic: true` flag beside an omitted `held_by` leaves every existing reader's
`held_by === "agent" ? … : …` intact and still reaching the wrong branch — it fixes the
record and not the defect, and the next reader written against the field inherits the bug.
Omitting `held_by` outright asserts nothing where the file has something definite to say. A
field naming what produced a ruling has to be total over the things that produce rulings, and
the runner is one of them; the honesty belongs in what the word is rendered as, which is §1.

**The larger question is real and is not settled here.** `verify` writes a *gate file* at the
build gate — a verdict at a seat whose holder was never asked — and the pipeline reads it as
one: the escalation ceiling counts these returns, `--revise` reads its conditions, and the
recorded return moves to `main` by the same path a ruled return does. Whether an automatic
verdict should be a gate file or a distinct record that the gate then rules on is a change to
the return, revise and escalation paths together, and it would want its own record and its
own tests. Nothing about it is clearly right today, and the defect that prompted this one is
answered without it. **Recommended as its own piece of work, and deliberately not done here.**

## The sweep

Every place a seat is read or derived, and what happened to each.

**Read a seat and were wrong.** All five now go through `seatKind`/`seatLabel`: the Markdown
gate log's seat cell; the HTML gate log's chip; the qualifier on a proposal page's ruling
sentence, which now qualifies every seat rather than only the agent, so an unqualified
sentence can no longer mean "a person"; the HTML gate legend, which explains the seats that
project's log actually carries and gained entries for the runner and for an unknown seat; and
the index's seat counts.

**Read a seat and were right.** The sampling filter (`computeSampled`) excluded everything
that was not an agent, which is the correct rule; it is expressed through the mapping now and
is covered by a test that a runner ruling neither is sampled nor spends the quota.
`verify`'s own `by === "runner:verify"` test, which counts its returns towards the escalation
ceiling, is a check for one specific writer rather than a seat classification, and a gate
holder cannot be configured with a `:` in a bare role, so a person's ruling can never be
counted into that ceiling. `stallReason` compares `by` against `agent:<escalate_to>`, which
no runner value can equal, so a runner escalation is never marked stalled — correct, since
it escalates to a role it does not hold.

**Carry `by` without deriving a seat from it, and were left alone.** The conditions check and
the revision ledger print `by` as the label it is; `splitRulingConditions` and
`returnedRulingOn` read a ruling's `rationale`/`note`/`conditions` and never ask who ruled;
the HTML returned-proposals table and recent-rulings table print `by` verbatim, which is the
raw record and needs no mapping. `simulatedRole` and the ruling dispatcher test an `agent:`
prefix on a *configured holder*, not on a gate file's seat. The `by` on a test attestation is
a different field in a different domain.

**`doctor` and `checks` report on no seat at all.** Neither reads `held_by` and neither has
anything to say about who ruled what; there was nothing to fix and nothing to add.

## Consequences

- A verdict the runner produced is shown as the runner's, everywhere it is shown, and counted
  as the runner's, everywhere it is counted. Nothing the pipeline publishes attributes it to
  a person.
- A `held_by` the site has never seen is reported as unknown and quoted back, on both
  renderings, instead of arriving as a human sign-off.
- The index carries one count per seat, so a reader never has to subtract, and a seat the
  site cannot place shows up as a number rather than as silence.
- A project's published record of human involvement is now exactly its human rulings. Any
  project whose site was built before this change is overstating it by its verify returns,
  and rebuilding the site — `sdlc status` — is the whole of the correction, since the gate
  files themselves were right all along.
- Recommended next, and deliberately not done here: whether an automatic verdict should be a
  gate file at the build gate, or a record of its own that the gate then rules on.

## What was considered instead

**A third chip beside the two seats.** The obvious shape — `runner` rendered like `persona
agent` and `a person`, in a colour of its own — and it is the defect one step less wrong. A
column of three role-shaped names invites the reading that a third seat was held, when the
fact worth publishing is that none was. What the column is for is telling held from unheld.

**Leaving the unknown case to fall to `agent`.** It keeps the human reading off the default,
which is the whole requirement, and it substitutes one invented claim for another: that
something the site cannot identify read a brief and ruled in a role. A mapping that must
guess should claim less, not merely claim something safer to be wrong about.

**Fixing the five readers in place, without a shared mapping.** It is what the five readers
already were — each one right when written, each one two-valued over a three-valued field —
and a sixth is written the moment the site grows a page. The cost of the shared module is one
import; the cost of not having it was five independent chances to reach the same wrong
default, of which five were taken.

**Reporting the runner's rulings in the sampling denominator, so a person re-reads a share of
them.** Sampling is a check on judgement and there is none here to check. A quota spent on a
verdict that is a test result is a quota not spent on a ruling somebody reasoned to.

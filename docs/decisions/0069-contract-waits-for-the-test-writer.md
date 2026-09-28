# 0069 · Contract waits for the test writer

Status: accepted · 2026-09-28

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Most of what `contract` owes in the Tests phase is filed by the rulings of `derive-tests`
proposals: a missing test owed by `contract` (a seeded record in a state the seed lacks, an
observation nobody declared), or a request addressed to `contract`. A test writer's run covers one
domain, and so does its ruling, so these needs arrive one domain at a time.

`sdlc next` orders owed work upstream stage first (`docs/stages/next.md`). The moment one domain's
ruling files a need, `sdlc run contract` is next, ahead of the test writer's ready work in every
other domain. The contract run is long, its approval changes the surface every adapter binds, and
the next domain's ruling then files another need. Each contract version answers one domain's
needs, the upstream work regenerates as fast as it is answered, and calibration, which comes after
it, is not reached.

The contract run is already handed everything contract owes: every open request addressed to it
(`revisionRound`, `src/stages/proposals.mjs`) and every open missing test it owes, across domains
(`handedNote`, `src/spec/missing-tests.mjs`). The cost is in when it runs, not in what it is
given.

## Decision

**The contract run that answers owed work is held while the test writer has ready work that does
not rest on contract.** That work is a `derive-tests` run, owed or in the sequence, in a domain
contract owes nothing, or a ruling of a `derive-tests` proposal an agent can make now. A domain
contract owes something is one with an open missing test contract owes and has not kept, or a
request to contract filed by a ruling in that domain's line of work.

While contract is held, the test writer's runs in the domains contract does owe are held behind
it, which is where the upstream-first order already puts them: each would be run again once
contract answers and hands its missing tests back. Both appear under `held:` with the reason,
and the rest of the order is unchanged. When no ready test-writer work is left outside those
domains, the contract run is offered as before, once, with every domain's needs.

**Work that rests on contract never holds it.** A revision whose own ruling asked contract for
something is already held on that request (`heldBy`), so it is not ready work. A test-writer run
in a domain contract owes is held behind contract, not in front of it. A proposal waiting on a
person is not ready work either. Contract is held only while something else can run, and each
thing that holds it either finishes its domain's line, files a need of its own (its domain then
stops holding contract), or is returned and revised.

A returned contract proposal is not held. Its revision is the contract's own line of work
(`docs/decisions/0064-a-returned-contract-is-the-next-contract-run.md`), and the downstream work
that waits on it is held on its answer.

This is engine behaviour, not a `policy.next` key. `policy.next.order` chooses between kinds of
ready work; this is an order inside the record, the same kind of rule as upstream-first, and a
project that wanted contract per domain would be choosing the loop.

## Alternatives

**Ask the test writer to report every contract gap in one go.** The `derive-tests` skill already
asks for every clause no test can assert and for every surface member the run needed and did not
find. The needs in question are mostly filed by the ruler of one domain's proposal, who reads one
domain. Asking harder does not change that a ruling covers one domain.

**Make it a policy key.** Rejected for the reason above: the choice is between batching and a loop,
and there is nothing for a project to prefer.

**Hold contract until every domain's tests are approved.** Rejected: a domain whose test writer
is waiting on contract would never be approved, and the hold would deadlock on exactly the work
that rests on contract.

## What would reverse it

A contract run cheap enough that one per domain costs less than the test-writer runs it saves.
A test writer whose ruling surfaces needs across domains would make the hold redundant.

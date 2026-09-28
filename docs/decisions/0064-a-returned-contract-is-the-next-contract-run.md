# 0064 · A returned contract is the next contract run

Status: accepted · 2026-09-25

## Context

Contract proposals are versioned, and an ordinary `contract` run is the command that
answers both an upstream request and a return of the contract's own proposal. A return
on the proposal branch can carry its whole explanation in the ruler's rationale, with no
separate condition lines. The returned draft also exists only on that branch. Without
reading either, a fresh run starts from main, repeats the original task and reaches a
proposal name the returned branch still occupies.

## Decision

The ordinary contract run first looks for the latest return of its own proposal that
main has not recorded. It gives the agent the rationale, any separate conditions and
the returned draft's changes under the contract-owned paths. Requests addressed from
other gates remain visible and open while this own return is answered. With no own
return, the ordinary run takes up those requests as before.

A dry run reads and previews the return and the next version without writing. On a real
run, the draft is applied to the in-place workspace only after authentication succeeds.
The runner checks the patch from the returned branch against current main before it
applies it, and refuses a conflict rather than replacing newer main content. It records
the return on main and preserves the returned branch under its own namespace only after
the replacement passes its post-checks, immediately before opening its successor at G1.
The successor's version is one above the highest ruled version, including when numbers
have gaps. The same gate still judges it.

Recording the return commits only its gate file and proposal page, so the replacement's
draft reaches main through G1 and no other way. The branch is moved under `returned/`
before anything is committed, so a name git cannot create stops the recording rather than
leaving a return on main whose branch still occupies the proposal name; the contract
pre-check asks the same question before the agent turn.

A run answering a return keeps that return in its run state. A resumed run answers the
same one, read from whichever of the two branch names holds the commit the run started
from, and records it at most once. It does not look for requests instead: after the return
is recorded there is no return left for a fresh search to find, and taking up the requests
would mark as answered an ask the run never saw.

## Alternatives

**Delete the returned branch and start from main.** That loses the draft and asks the
agent to reconstruct work the ruler has already reviewed.

**Record the return before the agent runs.** An authentication, preparation, agent or
post-check failure would spend the ruling without delivering a replacement.

**Restore the branch's whole contract tree over main.** That can erase an unrelated
contract edit merged after the returned proposal branched. Applying only its changes
with a conflict check keeps such edits visible or refuses the run.

## What would reverse it

A general revision mechanism for in-place stages could replace this contract-specific
handoff if it preserves returned drafts, gives each agent the ruling's explanation and
delays retirement until a replacement has passed its checks.

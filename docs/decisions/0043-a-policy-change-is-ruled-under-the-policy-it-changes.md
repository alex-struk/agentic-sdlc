# 0043 · A policy change is ruled at G-POL, under the policy it changes

Status: accepted · 2026-09-24

## Context

The `policy` block of `.sdlc/config.yaml` names who holds each gate, where each gate
escalates, and every limit the engine applies. The design says it changes only through
G-POL. A ruling reads the configuration off the proposal's own branch, and `policy` is
read from the branch on purpose: it is the terms the proposal was made under, and the
runner chooses the seat from it (`0013`, `0038`).

For a proposal that changes `policy`, those two rules together let the proposal choose its
own ruler. A branch that rewrites G2's holder, opened at G2, is ruled by the holder it
names; a branch that rewrites G-POL's holder is ruled at G-POL by the holder it proposes.
Agent stages cannot reach the file, since every stage's scope check keeps it out of what
the stage may change, so the route is a person's `sdlc propose` or a hand commit. Neither
seat is authenticated (`0003`), so this is not a security boundary; it is the record
saying a policy was ruled under terms nobody with authority over policy agreed to.

## Decision

**A proposal whose branch changes the `policy` block is ruled only at G-POL.** Whether it
changes the block is the comparison `rulingConfig` already makes: the branch against its
merge base with `main`, on the value. At any other gate the ruling is refused, from either
seat, and `rule --pending` leaves the proposal open and says why.

**It is ruled under `main`'s policy.** The seat, the escalation target, the tiers that force
an escalation and every other policy value the runner acts on for that ruling are `main`'s.
The prompt still quotes the proposed policy as the proposal's change, with `main`'s beside
it, because that change is what is being ruled on.

A proposal that changes nothing in `policy` is ruled exactly as before, under the branch's
policy.

## Alternatives

**Refuse at `sdlc propose`.** A person's hand commit or an edit after proposing reaches the
ruling without passing through `propose`, so the ruling is where the check has to live. A
check at `propose` as well would only move the same message earlier for one of the routes.

**Always seat every proposal from `main`'s policy.** It would change which seat rules every
open proposal the moment a policy change merged, which `0013` decided against for reasons
that still hold for proposals that do not touch policy.

## What would reverse it

A project that needs a policy change bundled with other work, ruled at that work's gate.
The answer then is two proposals, not a looser rule.

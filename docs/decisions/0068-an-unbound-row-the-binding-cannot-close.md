# 0068 · An unbound row the binding cannot close

Status: accepted · 2026-09-28 · decided by the project's tech lead

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

An open `unbound` calibration row is owed to `bind-adapter` as a rebind, bounded by
`policy.loops.rebind` (`docs/decisions/0067-an-unbound-row-is-owed-to-its-binding.md`). Past the
limit nothing could close it: no calibration verb applied to it, and `sdlc next` listed it as
waiting on a ruler with no command a ruler could type. The Tests phase exits only when every row
is pass, not-testable, attested or ruled, so one such row held the phase open for good.

The rows left past the limit are of two kinds. Some need a persona the approved contract already
says the target offers no way to act as: `spec/contract/personas.yaml` marks that persona's
sign-in for the target's identity `{ unavailable: "<reason>" }`, and the adapter's `signIn`
throws `unbound: signIn.<persona> — <reason>` for it, as `bind-adapter` is instructed to. Others
need a state the oracle cannot be put into, or observed in, without changing its code: behind an
external identity provider, reachable only through a link the application emails, enforced only
by a browser-native dialog. Neither kind is a gap a binding run can close, and neither is a
question about what the product must do.

## Decision

**A. The reviewer closes the rows the binding could not.** Once `bind-adapter` has been sent a
criterion on the oracle's target as often as `policy.loops.rebind` allows and the adapter still
reports it unbound, calibration puts the row on the reviewer's G3 triage page,
`calibrate-triage-<target>-<n>`, beside the failures, with the adapter's own reasons and how often
the binding was sent. The triage grammar gains a third verb:

- `oracle-cannot <ID>: <why>` records that the oracle cannot be driven into, or observed in, the
  state the test needs. The row is ruled `oracle-cannot`; the ruling is kept in
  `tests/results/<target>/applied.yaml` with the reviewer's reason, the gate and the criterion's
  version, like every applied ruling; any open rebind entry for the row is withdrawn; no
  criterion changes. It is applied only to a row that is unbound on the oracle's target. On any
  other row it is reported as not applied and the row is sorted again.

The other two verbs keep their meaning. `adapter-wrong <ID>: <why>` says the adapter could bind
it: the reviewer's finding is filed on the rebind list whatever the count, and a binding run
handed an item past the limit runs and has its proposal escalated, as for any reviewer rebind.
`product-question <ID>` says the criterion itself looks suspect, and the row goes to the product
owner at G1 with the failures.

The triage page and the reviewer persona say when each applies: `oracle-cannot` only when the
state lies outside what the oracle can reach without changing its code, and never as a way to
skip binding work; `adapter-wrong` wherever the application offers what the test needs under
another label, behind a step or as another persona.

**An `oracle-cannot` ruling does not lapse when the adapter changes; it lapses when the
criterion's version changes.** It is a finding about the oracle and the state a criterion needs,
and neither changes with the adapter: an `adapter-wrong` verdict lapses with the adapter because
the adapter is what it is about. A criterion that moves on may need another state, so the row is
asked about afresh, by the same version-bound reading every calibration ruling has. The test
still runs on every calibration, so a row that later passes shows it on the row.

**`next` routes the rows, rather than listing them as waiting.** When all that keeps the oracle's
calibration open is rows calibration can settle without running the suite, `next` offers
`sdlc run calibrate --target <oracle> --skip-suite`: the suite would only report them unbound
again. That run opens the triage, and while the triage is open the rows are its question. A spent
row on any other target still waits on a ruler: `oracle-cannot` is a statement about the oracle,
and a target the pipeline builds is changed by building it.

**B. A row needing a persona the approved contract marks unavailable closes itself.** A row is
closed this way when every failing test in it ended in the adapter's
`unbound: signIn.<persona>` error and each persona it names has its sign-in for the target's
identity (the oracle's `identity` for the oracle's target, the target's own otherwise) marked
`{ unavailable: "<reason>" }` with a non-empty reason in the contract calibration runs against. A
row with any other unbound member is still binding work and is not closed.

Calibration rules such a row `persona-unavailable`, and records on it the personas and the newest
approved `contract-v<n>` proposal, whose approval established the marking. It is never filed for
`bind-adapter`, never counted against the loop limit and never put to the reviewer. It is worked
out from the contract on every run rather than kept as a ruling, so a later contract that offers
the persona re-opens the row, and it is owed to `bind-adapter` from then on.

Both are reached by either seat: the triage verb is in the grammar a person types and a persona
is prompted with, and the persona closing is mechanical.

## Alternatives

**Let the exit accept unbound rows wholesale.** Rejected: it would pass the rows a binding run
could still close, and the calibration would certify criteria nobody had tested.

**Have the product owner rule them.** Rejected: whether the oracle can reach a state is a
technical judgement with an answer in the application and the adapter, which the product owner is
not asked (`docs/decisions/0008-adapter-wrong.md`).

**Stand up an identity provider in front of the oracle.** Deferred: the rebuilt target reaches
the criteria that need one through its sandbox identity provider, so they are tested there.

## What would reverse it

Reviewer rulings of `oracle-cannot` on rows a later binding run bound would show the verb being
used to skip binding work, and would call for a check against the application before it is
applied. A way to put the oracle into those states without changing its code would make the rows
bindable, and the verb unnecessary for them.

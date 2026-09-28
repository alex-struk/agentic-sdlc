# 0067 · An unbound row is owed to its binding

Status: accepted · 2026-09-28

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A calibration row is `unbound` when every failing test in it ended in the adapter's own
`unbound:` error: the adapter says the surface member the test needed does not exist on the
target. That is a gap in the binding, not a difference in behaviour, so the row is put to
neither the reviewer's triage nor the product owner (`docs/decisions/0008-adapter-wrong.md`).

The Tests phase exits when every calibration row is pass or ruled (design spec §15), and `next`
reads that literally: a row closes the phase when it is `pass`, `not-testable` or `attested`, or
carries a ruling. An unbound row is none of those, and nothing was owed for it. The reviewer and
the product owner see only `fail` rows, and `bind-adapter` was owed work only for a reviewer's
`adapter-wrong` verdicts and for contract members its bindings do not name. So an unbound row
could never close, and the phase could never exit: `next` offered calibration again and again, and
each run found the same rows.

The rows are not all alike. Some name a control the target does render, which the adapter did
not reach — under another label, behind a step or a sign-in, as another persona. Others name
something the target really does not offer.

## Decision

**An open unbound row is owed to `bind-adapter` for its target, as a rebind.** The entry is the
shape a reviewer's `adapter-wrong` verdict files on `tests/adapters/rebind.yaml`, with `found:
unbound` beside it, so a reader can tell the adapter's own report from a reviewer's finding, and
`adapter`, the tree of `tests/adapters/<target>` the row was found under. Its `why` is the
adapter's own reason: every distinct `unbound:` message on the row, once each, scrubbed of local
paths. The binding run is shown it in a block of its own, as the adapter's report rather than as
a judgement anybody made, and asked to look for each again and to say what it did to look where it
leaves one unbound (`src/spec/unbound.mjs`).

**One send per adapter, counted with the reviewer's.** A row records the adapter it ran with.
When calibration runs against an adapter that has changed since an entry was filed, the entry
lapses, closed as met, and a row still unbound under the new adapter is filed again: the item's
second send. `sends` counts every entry for the criterion on the target, so a reviewer's verdicts
and the adapter's reports about one binding count together. The loop is the same binding going
back to the same stage whichever of them sent it.

**The limit stops the sending, and the item waits on a ruler.** An item is filed, offered by
`next` and handed to a binding run only while it has been sent fewer times than
`policy.loops.rebind`. Once it has been sent that many times, `next` lists it under `waiting on a
person` as waiting on a ruler, and no longer offers calibration for a target whose only open rows
are such items: running the suite again cannot close them. No calibration verb closes an unbound
row, so such a row keeps the phase open until a person decides what it needs.

This differs from what the limit does for a reviewer's verdict, where a run handed an item past
the limit still runs and its proposal is escalated. An unbound item's evidence is the adapter's
own report, and a binding run that has already looked for a control that many times and not found
it is not likely to find it by looking again; a reviewer's verdict names what is wrong and why.

**Owed from the moment the row is on `main`.** `next` and a binding run read the rows nothing has
filed yet, the way they read an untestable record nothing has filed
(`docs/operating-model.md` §7). A row that records no adapter was found under the adapter at the
commit that last wrote the results file. The next calibration writes the entries, and counts a row
found under an adapter that has since changed as sent once under it.

**A row whose adapter has changed is checked again by calibration.** Whether the entry is filed
or read, `next` routes an unbound row found under an adapter other than the target's current one
to `calibrate --target <t>`, as it routes a rebind entry whose adapter has changed.

**Closing.** Calibration closes an entry whose row is no longer an open unbound row: as met when
the row now passes or fails, since the adapter reaches what the test needs, and as withdrawn when
the row is ruled, has some other result, or is gone. A `rebind` entry can therefore be withdrawn,
by the runner, as well as met.

## Alternatives

**Put unbound rows to the reviewer's triage.** The reviewer would be asked to sort rows whose
evidence is a message the adapter wrote about itself, and every one would come back
`adapter-wrong`, costing a ruling to learn what the row already says.

**A kind of owed work of its own.** It would need its own loop limit and its own route through
`next`, and a criterion that failed under one adapter and was unbound under the next would be
counted in two loops at once for one binding.

**Count sends from the dated results files instead of filing entries.** A run's rows say what
was unbound, not whether a binding run was ever sent it, and nothing would count a reviewer's
verdicts and the adapter's reports about one binding together.

## What would reverse it

A ruling that closes an unbound row, in a grammar a seat can use, would change what waits on a
ruler into something a ruler can answer; the sending and its limit would stand. A test harness
that could tell, before binding, which members a target does not offer would remove the rows that
can never be bound from the loop altogether.

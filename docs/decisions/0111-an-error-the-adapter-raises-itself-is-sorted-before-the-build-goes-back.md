# 0111 · An error the adapter raises itself is sorted before the build goes back

Status: accepted · 2026-10-18

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A verify that fails returns the build to its builder with each failure as a condition, except for
the failures only a look at the page can place. A test that stopped on a read that came back with
nothing may have met an adapter that looked in the wrong place as easily as an application that
drew nothing (`docs/decisions/0091`), and one the adapter stopped as a page the application does not
serve may be the build's to make, another slice's, or the adapter's mistake (`docs/decisions/0098`).
Either leaves the build open for its G3 ruler, who has the picture and the outline of each page, to
send each failure to the build or to `bind-adapter`.

An adapter member that acts on a page often waits for it to answer: a file is offered and the member
waits for its row to carry a download link, or a form is saved and the member waits for the screen
it lands on. When the wait runs out, the member raises an error of its own, naming itself and what it
did not find. That error is just as ambiguous. The member may be looking in a region by a name the
page no longer gives it while the page shows exactly what it waited for. Verify returned such a
failure to the builder, who cannot see the page or change the adapter, and the builder spent a
revision changing what the page draws to fit what the adapter looked for, before the escalation that
followed reached a ruler who traced it to the adapter.

## Decision

**A failure whose test stopped where the adapter raised an error of its own is sorted by the ruler.**
The steps a failed test records name the surface member it called last; when that step threw, and
what it threw is neither `unbound:` nor `absent:`, the adapter stopped the test itself. A failing
verify with one, in any case of any failing criterion, leaves the build open for its G3 ruler, as an
empty read does. The result names those criteria in `sort.adapter_errors`, beside `sort.empty_reads`
and `sort.absent`, and the ruler is asked to open the page and the adapter member, then return each
failure to the build or address it to `bind-adapter`.

A failure that is an empty read or a missing page is counted under that name and not again here. A
test that timed out or was interrupted did not record where it stopped, so it is not read this way.
A return that would reach verify's limit is verify's own, as for every sorted failure.

## Consequences

- A builder is no longer handed a failure it cannot see or answer, and does not change a screen to
  fit an adapter's search.
- A failure the adapter raised because the application really did not answer reaches the builder
  one ruling later, with the ruler's account of the page beside it.

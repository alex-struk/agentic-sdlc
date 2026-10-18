# 0110 · A rebuilt target is bound by the contract's test IDs

Status: accepted · 2026-10-18

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

The contract names every action and observation a test can use, and the design stage fills in a
`test_id` for each one on the pages of the application being built (`docs/stages/design.md`). A
filled test ID is kept as it is, because an adapter is bound to it (`docs/decisions/0086`), and a
build draws each screen from its story keeping every test ID. The design of the pipeline has the
old target's adapter bound by role, label, text and URL, recorded by walking the old application,
and the new target's adapter bound by the test IDs in `surface.yaml`.

The bind-adapter skill told every binding, whatever its target, never to use a `data-testid`. That
is right for the old target, whose pages carry none of the contract's identifiers, and wrong for
the new one. It also said the separation check would refuse a test ID in an adapter, which it does
not: the check keeps test IDs, selectors and routes out of the acceptance tests, which reach a page
only through an adapter.

A new target's adapter that finds every element by its words breaks whenever a screen is drawn
again. A redesign moves a status from a labelled detail into a page's head, numbers a form's
parts, and rewords a question and its choices, while keeping every test ID. Each change that a
member read by its words is a failed verify, a binding run and a ruling before the build is judged
on what it does, and a failure the adapter raises itself can be charged to a build that cannot
change it.

## Decision

**On a target the pipeline built, a member finds its element by the contract's test ID.** The
bind-adapter skill tells the binder to find the element a member works on with the `test_id` the
contract names for it, wherever the page carries it, and to fall back to role, label, visible text
or URL only where the contract names none or the page does not carry the one it names, saying which
in its journal. A member it revises that still finds its element by words, on a page that carries
its test ID, is moved to the test ID.

The test ID decides where a member looks and nothing else. What an observation hands back is still
the element's own text, in the form the old binding returns (`docs/decisions/0096`), so a test about
wording still reads the words.

The old target is bound by role, label, text and URL, as before. Selectors, classes and element ids
stay out of every adapter: nothing in the contract names them.

## Consequences

- A redesign that keeps the contract's test IDs no longer breaks the members that find their
  elements by them, and a build is judged on what it does sooner.
- A member found by test ID no longer shows, in passing, that a control is labelled with the words
  a person sees. The design stage's accessibility scan and the tests that read what a page says
  are what show that.
- An adapter already bound by words is moved to test IDs as its members are revised, or all at once
  by a binding run asked to do so.

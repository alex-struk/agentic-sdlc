# 0098 · A page the application does not serve is a failure

Status: accepted · 2026-10-04

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A test drives the application through the adapter, and a member the adapter cannot bind throws
`unbound: <page>.<member> — <reason>`. A row whose every failure is that error is `unbound`: the
gap is the binding's, the row is owed to `bind-adapter`, and nothing about it is charged to the
build (`docs/decisions/0067`, `0075`).

On the new target, some members cannot be bound because the build does not serve their page at
all: the route answers the application's own not-found page, and nothing in the application leads
to it, for any persona the contract lets onto it. On one project a binding run said exactly that
about seven criteria a slice claimed, and named the routes and personas it had walked. Reported as
unbound, those rows went to the binding, which could not reach a page that does not exist, while
the build that was missing the pages waited. They reached the build's ruler only after the binding
had had its turns (`0097`).

## Decision

**The adapter reports a page the application does not serve as absent.** The member throws
`absent: <page>.<member> — <reason>`, saying the route, each persona it was walked as, and what the
application answered, and `bindings.yaml` names the member `absent: <reason>`. The adapter
decides this when the member runs, not when it is bound: while the route answers the not-found
page the member is absent, and once the route answers anything else the member throws `unbound:`,
because the page has been built since and its controls have not been seen. The next binding run
binds it. `absent:` is for a missing page alone. A page that answers, with a control the adapter
cannot find, is still `unbound:`, and a page that answers and shows nothing is still an empty
answer (`0091`).

**A field is looked up when the action runs, too.** An action handed a value finds the field for
it by its label as it runs, and reports the key unbound only when the page has no such field then.
A list of the fields the binder saw, written into the adapter, refuses a field the build adds later
until another binding run rewrites it; a field looked up when the action runs is filled as soon as
the build has it.

**A test that stops at `absent:` fails, and the build's ruler sorts it.** The harness counts only
`unbound:` errors toward an unbound row, so the row fails. Verify does not return a build for such
a failure. It leaves the build open for G3's ruler, as it does for a read that came back with
nothing, and records the criteria in the result's `sort.absent`. The ruler is told to read the
adapter's reason and the plan, and then to return the failure to the build when the slice is the
one to make the page, to address it to `plan` when the plan makes the page in another slice, or to
address it to `bind-adapter` when the page is served after all. A return the ruler makes counts
toward verify's return limit, as a sorted return does.

## Consequences

- A build that lacks a page it was asked for is told so on its first verify, with the adapter's own
  account of the routes and personas it walked, rather than after the binding's turns.
- A page that belongs to a later slice reaches the planner through a request, not through a build
  that cannot make it.
- An adapter that wrongly calls a page missing is caught by the ruler, who is shown the reason, the
  plan, and the picture of the page where verify kept one.

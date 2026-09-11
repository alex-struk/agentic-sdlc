Your job this run is to write one Playwright acceptance test per accepted criterion in one
business domain, and nothing else — the same claim the header of every file you write makes:
`provenance: blind`.

## What you can see, and why that is the whole point

Your workspace holds only `spec/`, `tests/seed/`, `tests/generated/*` (the TypeScript this run's
own setup step generated from the contract) and whatever already exists under
`tests/acceptance/`. There is no `app/` here, no adapter, no locator, no URL — `surface`,
`persona`, `seed` and `mail` are the entire world a test may reach into. If a criterion cannot be
tested through what the contract already names, that is not a gap to work around by reading
further; see "When a criterion cannot be tested" below.

## Writing one file

For every criterion your prompt lists, write `tests/acceptance/<domain>/<ID>.spec.ts`, importing
only from `../../fixtures` and `../../generated/*`. Start with exactly the two header lines your
prompt gives you — `// criterion: @<ID> v<n>` and `// provenance: blind, spec@<sha>, derived
<date>` — then the test body:

- **Sign in** through `persona.<id>` (`surface.signIn(persona.<id>)`), when the criterion needs a
  signed-in actor at all.
- **Act** only through `surface.<page>.<action>()`.
- **Read** only through `surface.<page>.<observation>()`.
- **Refer to records** by `seed.<group>.<handle>`, never a raw id or a value you invented.
- **Observe email** through `mail`, never a database row or a log line.

One `test()` per given/when/then the criterion states — a criterion with two outcomes is two
tests, not one test with two assertions bolted together — titled with the criterion's own
statement, so a failing run names the requirement in its own words rather than a name you chose.

Never read or guess at how the system is built. Never write a CSS selector, a locator call, a
`data-testid`, a hardcoded route, or anything else that reaches past `surface` — that is exactly
what the separation check refuses, on your behalf, not looking over your shoulder afterward.

## When a criterion cannot be tested

If nothing in `surface` reaches what a criterion describes — no page, action or observation gets
you there — do not write a file for it. Add an entry to `tests/acceptance/not-testable.yaml`
instead: `{ id: <ID>, version: <n>, reason: "<why>" }`. A reason has to be real: name what is
missing, not that the criterion is "hard" or "out of scope".

Then say which of two things it is, because they are not the same and the difference is what
someone does about it next.

**Blocked**: the contract could reach this and does not. An observation nobody wrote, a page the
surface never declared, a starting state the seed could create. Begin the reason with
`blocked:` and name what would unblock it. These are work for the contract stage, and a run of
them in one area usually means one missing thing rather than many.

**Unobservable**: nothing this system does could show it, whatever the contract said. A claim
about what happens inside a scheduled job nobody can trigger, or about a fact the service never
puts on a page. Begin the reason with `unobservable:` and say why no addition would help. These
are permanent, and somebody has to accept the risk rather than plan to fix it.

If you cannot tell which, it is `blocked:` — say what you would need to decide.

## The journal

Your final message is read by whoever rules this proposal and by whoever writes the contract
next. Say how many criteria got a test, which were not testable and why, and — by name — which
surface actions or observations you needed but did not find, so the contract can be extended to
reach them. Never name a person in it.

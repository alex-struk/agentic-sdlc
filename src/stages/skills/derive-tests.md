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
instead:

```yaml
- id: <ID>
  version: <n>
  reason: "<why no test can be written today>"
  missing: "<what would have to exist for a test to reach it>"
  owner: <the stage that supplies it>
```

A reason has to be real: name what is
missing, not that the criterion is "hard" or "out of scope".

The entry is not a place to leave the criterion. Once it is approved, the test is owed: an open
item that stays open until a test for the criterion runs, handed to the stage you name as
`owner` the next time it runs. So `missing` is written for that stage, in terms it can act on —
the observation, the page, the seeded record, the sign-in — and `owner` is the stage that
produces that kind of thing. Most often it is `contract`, which writes the surface, the
observations and the seed. Where the criterion itself is the problem — it contradicts another,
or asks for two states at once — it is `ratify`. It is never `derive-tests`: a record owed back
to the writer is a test the writer declined to write. The run is refused if an entry you write
or change leaves either field out.

Then say which of two things it is, because they are not the same and the difference is what
someone does about it next.

**Blocked**: the contract could reach this and does not. An observation nobody wrote, a page the
surface never declared, a starting state the seed could create. Begin the reason with
`blocked:` and name what would unblock it. These are usually owed by `contract`, and a run of
them in one area usually means one missing thing rather than many — name it the same way in each.

**Unobservable**: nothing this system does could show it, whatever the contract said. A claim
about what happens inside a scheduled job nobody can trigger, or about a fact the service never
puts on a page. Begin the reason with `unobservable:` and say why no addition would help. Name as
`owner` the stage that could still change that — `ratify`, where the criterion could be stated
in terms something observes. If nothing can, a ruler withdraws the item with the reason written
down, and that is how the risk is accepted.

If you cannot tell which, it is `blocked:` — say what you would need to decide.

Before either, read the whole surface again. A page whose `open()` takes an identifier your
test has no way to obtain often has a sibling that reaches the same thing without one — a
person's own settings, the signed-in account's own profile, the current user's own list. The
surface names them separately because they are separately reachable, so a criterion about what
somebody sees of their *own* record is usually answered by a page that asks for nothing. Record
nothing as unreachable until you have looked for that sibling and it is not there.

And never do both for the whole criterion. A criterion gets a test file or a
`not-testable.yaml` entry, never one of each: an entry beside a test is a contradiction a check
will refuse. Note that the workspace starts from the last approved derivation, so a criterion
you decide is unreachable may already have a test file somebody else wrote. Deciding it is
unreachable means deleting that file. The one entry that sits beside a test is the one below.

## When part of a criterion cannot be tested

A criterion often states more than one thing: an outcome and a guarantee about it, or one
behaviour in two places. Write the test for every clause the surface reaches. For each clause it
does not, add an entry that names the clause, beside the test:

```yaml
- id: <ID>
  version: <n>
  clause: "<the clause no test asserts, in the criterion's own words>"
  reason: "<why the test cannot assert it today>"
  missing: "<what would have to exist for a test to assert it>"
  owner: <the stage that supplies it>
```

`reason`, `missing` and `owner` are chosen exactly as above, and `blocked:` or `unobservable:`
begins the reason the same way. One entry per criterion: where several clauses are out of reach,
name them together in `clause`.

This is not optional. A test that asserts part of its criterion and says nothing about the rest
reads as a test of the whole criterion: a passing run is taken as the criterion met, and the
missing test for it is closed on that run. The entry is what keeps the rest owed. It stays open
while the entry stands, whatever the test's runs say, and it goes to the stage you name as owner.
Remove the entry only when your test asserts the clause. Say in your journal, by criterion, which
clause each such entry names.

One more thing to check before you give up on reaching a record: the seed's handles carry
identifiers. `seed.users.<handle>.id` and its siblings are exactly what a page whose `open()`
asks for one is asking for, so "I have no way to name this record" is almost never true of a
record the seed defines.

## When a test needs a file

Name it the way a person would — `{ file: "scan0001.pdf" }` — and add `content` when the
criterion turns on what is inside, or `bytes` when it turns on how big it is. Never write a
path: the harness makes the file, so a name is all the adapter needs and a path would only be
true on one machine.

## The journal

Your final message is read by whoever rules this proposal and by whoever writes the contract
next. Say how many criteria got a test, which were not testable and why, and — by name — which
surface actions or observations you needed but did not find, so the contract can be extended to
reach them. Never name a person in it.

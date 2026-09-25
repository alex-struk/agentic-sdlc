Your job this run is to complete `spec/contract/` — the pages, personas, API description and
observables the acceptance tests (a later stage) and the oracle (a running comparison target)
will act through, and nothing else. Nobody who writes a test after you will read the old
application, the criteria's prose, or anything you decided along the way — only the files you
write here. Whatever a page, a persona or an observation cannot name, a test cannot reach.

## Where to look

When this project configures `sources.old`, it is checked out read-only at `sources/old`, the
same way archaeology reads it: entry points, models, validation, status transitions, permissions,
and any docs or OpenAPI/swagger file it carries. `sources/old/tests` stays off limits, for the
same reason it was off limits to archaeology — a test suite is a second opinion about intent, not
independent evidence of behaviour. When this project has no `sources.old` at all, there is nothing
under `sources/old` to read; work from `spec/domains/` and, once ratify has run,
`spec/criteria-index.json` instead — the ratified criteria are the whole account of what the
system does.

You may also read `constitution.md`, `spec/`, and `intent/` for context, the same three paths
archaeology could read outside `sources/old`.

## The five (or six) files

**`spec/contract/surface.yaml`.** One entry per page the criteria actually need, each carrying a
`domain: <d>` field. A route, a title, and the actions and observations a test will call —
named in the vocabulary the criteria themselves use ("submit", "status"), never a CSS selector, a
DOM path, or a test ID (those are filled in at the design gate, by a later stage that can see the
real markup). Archaeology may already have appended pages here for the domains it recovered; keep
and normalise what is there, and add what is still missing. Never delete a page — a later
criterion might still need it even if this run cannot see why.

A route parameter a test has no way to obtain makes every criterion on that page untestable, so
check each one you write. If a page's route carries ":something", a test must be able to get a
value for it: either it is a handle in tests/seed/manifest.yaml, or some observation somewhere
returns it. A test that creates a record and then cannot address it is the common case — if an
action creates something the criteria later refer to, the page it lands on needs an observation
returning that record's identifier. And if a page is also reachable as the signed-in person's own —
their profile, their settings, their dashboard — declare that as its own entry with no parameter,
because a test acting as themselves has no id to pass and should not have to invent one.

**`spec/contract/personas.yaml`.** Every role the criteria name, with a `can` list, and a
`sign_in` entry for every identity this project's configuration actually uses (`oracle.identity`
and each `targets.<t>.identity` — read `.sdlc/config.yaml`, never guess). `session-route` needs
`{ route: <path> }` — the path a session cookie is minted at. `sandbox-idp` needs
`{ username: <name> }` — a synthetic account a sandbox identity provider is seeded with. A role
nobody ever signs in as — an anonymous visitor a page's own logic distinguishes by having no
session at all — writes `sign_in: null` explicitly, not a missing key: a missing key looks like an
omission, and `null` says on purpose that there is nothing to sign in with.

A role the target genuinely offers no way to act as writes `sign_in: { <identity>: { unavailable:
"<reason>" } }` instead — an old application with three fixed test users cannot host a second
staff member, and no amount of looking harder will find a fourth. Use this only when the target
truly has no way to act as this role, never as a shortcut past one you have not found yet; say why
in the reason, since whoever rules on the proposal reads it to judge whether the gap is real.
`bind-adapter` throws from `signIn` for an identity marked this way, so every criterion needing the
persona reports as `unbound` in calibrate rather than as a failure that looks like a real defect.

**`spec/contract/openapi.yaml`.** Only when this project has `sources.old`. Assemble it from the
old application's own API description files if it carries any (an OpenAPI or Swagger document,
even a partial one); otherwise write it from the routes you find, one `operationId` per route.
Either way, open the file with a comment naming exactly where it came from:
`# recovered from <path(s)> at <commit>`. Without `sources.old` there is nothing to recover an API
description from — leave this file as it is.

**`spec/contract/observables.yaml`.** Side effects a test can observe without reading the
application's internals: email, observed through a mail catcher reachable at
`${SDLC_MAIL_API}` (never a literal host or port — the oracle chooses the port at run time), and
any file or notification endpoint the criteria depend on.

**`tests/seed/`.** `NNN-<name>.sql` files, applied in ascending name order, that a later stage
loads into the oracle's database before any test runs. Insert one synthetic user per persona whose
identity a session route or sandbox IdP looks up, plus whatever fixture records the accepted
criteria's given-clauses describe ("an application already submitted", "a fee already
calculated"). Every value is invented and clearly synthetic — `example.test` email addresses,
names that read as placeholders rather than real people — never anything that could be mistaken
for a real record. Write `tests/seed/manifest.yaml` alongside it, naming every inserted record by
a handle a test will refer to (`users.applicantOne`, not a raw UUID with no explanation).

Reach for the seed before you call a state unreachable. An interface will not create the past: a
form that takes a deadline refuses one that has already gone by, a trial cannot be started six
months ago, a retention period cannot be waited out. The seed can put a record straight into the
database in whatever state the schema allows, and that is what it is for. A whole area of the
criteria going untestable because no screen can set up its starting point is almost always this,
and it is a row in a seed file rather than a limitation.

Seed the conditions, never the outcome. A record the application will act on is legitimate: an
opportunity that is published with a deadline that has passed, an account whose trial ended
yesterday. A record already in the state the criterion is about is not, because the application
then did nothing and the test is checking your fixture rather than the system. Set up the before
and let the application produce the after — if nothing in the application will produce it, say so
instead of writing it in.

**`.sdlc/oracle/compose.yml` (or wherever `oracle.compose_override` names).** Only when this
project configures `oracle` at all. A Docker Compose override layered on top of
`oracle.compose` that: publishes the application on `${SDLC_APP_PORT}`, the database on
`${SDLC_DB_PORT}`, and a `mailpit` service (`axllent/mailpit:v1.28.0`) on `${SDLC_MAIL_API_PORT}`;
points the application's own mail configuration at that mailpit service; sets whatever environment
the application needs to run outside production with its test sign-in routes enabled; and, for any
service the base compose file loads an `env_file` for, uses Compose's `!override` merge tag so this
override's own `environment` block actually wins over it rather than merging underneath it. Define
the migration one-off service `oracle.migrate_service` names, if the config names one. Without
`oracle` configured at all, there is nothing to write here.

## Proving the oracle starts

When this project configures `oracle`, your prompt asks you to bring it up with the override you
wrote, and to take it down again before you finish. Nothing you can read tells you whether the
application will start, so this is how you find out.

Done is not "a page was served": done is that the migration ran, the seed loaded, and a record from
tests/seed/manifest.yaml is visible through the application itself. An application that starts with
a broken database connection also serves a page.

If it does not come up, read the container logs, change this override, and try again. Three
attempts, not more. Each attempt rebuilds the image and takes minutes, and a failure you cannot fix
in three is a failure a person needs to see.

You may change this override's environment, paths, ports and service definitions. You may not make
the application easier to start by weakening it: do not skip or disable the migration, do not relax
authentication or authorisation, do not stub out a service the application really uses, and do not
set a flag that changes what the application does rather than where it runs. This target is the
definition of correct behaviour for everything built against it, and an oracle that starts because
it was weakened is worse than one that does not start at all.

If it still will not start, that is a result and not a failure. Leave the override as your best
honest attempt, and say in your journal exactly what happens, what you tried, and what you think is
needed. A contract whose surface is complete and whose oracle does not start is a reasonable thing
to put in front of a gate.

## Missing tests handed to you

A criterion the test writer could not reach is owed a test, and when what it lacked is yours to
supply — a page, an action, an observation, a sign-in, a seeded record — the item is handed to
this stage. Your prompt lists every one you owe, each with what the writer said was missing.

Supply what you can. A run of them in one area usually wants one thing — the same missing
observation named five ways — so read them together before you add anything, and add the one
thing rather than five near-copies. Then hand each item you supplied to `derive-tests`, which
writes its test next, saying in the line what now reaches it:

```
re-address missing-test/<id> to derive-tests: <what you added, by name>
```

An item that is not yours to supply goes to the stage whose it is, the same way, with the reason.
A criterion that asks for something contradictory or unobservable in itself goes to `ratify`. Do
not hand on an item you did not supply: it comes straight back, and the gate that rules this
proposal reads the line as a claim that you did.

A hand-on to `derive-tests` takes effect when this proposal is approved, since the test writer
needs what you supplied to be on `main`; a hand-on to any other stage takes effect when the run
finishes.

An item you write no line for stays owed by this stage, which is the right answer for one you
could not supply this run. When the proposal is approved it is recorded as kept, and no run of
this stage is offered for it again: it waits on a ruler to withdraw it, or on somebody to run the
stage once something has changed. Say why in the journal, so that reader does not start from
nothing.

## The journal

Your final message is read by whoever writes tests against this contract next, and by the
product-owner persona who rules whether it is trustworthy. Say which pages exist, which sign-in
method each persona uses, what the seed contains, and — as plainly as archaeology's own journal
does — what you could not recover and why. Never name a person in it.

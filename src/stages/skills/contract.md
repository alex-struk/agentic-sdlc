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

**`spec/contract/personas.yaml`.** Every role the criteria name, with a `can` list, and a
`sign_in` entry for every identity this project's configuration actually uses (`oracle.identity`
and each `targets.<t>.identity` — read `.sdlc/config.yaml`, never guess). `session-route` needs
`{ route: <path> }` — the path a session cookie is minted at. `sandbox-idp` needs
`{ username: <name> }` — a synthetic account a sandbox identity provider is seeded with. A role
nobody ever signs in as — an anonymous visitor a page's own logic distinguishes by having no
session at all — writes `sign_in: null` explicitly, not a missing key: a missing key looks like an
omission, and `null` says on purpose that there is nothing to sign in with.

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

## The journal

Your final message is read by whoever writes tests against this contract next, and by the
product-owner persona who rules whether it is trustworthy. Say which pages exist, which sign-in
method each persona uses, what the seed contains, and — as plainly as archaeology's own journal
does — what you could not recover and why. Never name a person in it.

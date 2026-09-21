# Build one slice

You are building one slice of the rebuilt application: the slice named in your task, and
nothing else. The criteria it lists are the whole of what it must do. Read each one in
`spec/domains/<domain>.md` before writing any code for it.

## What you have and what you do not

You have the specification (`spec/`), the contract (`spec/contract/`: the API in
`openapi.yaml`, the pages in `surface.yaml`, the personas), the design catalogue
(`design/`), the plan (`plan/`), the application as it stands (`app/`), and the seed
manifest (`tests/seed/manifest.yaml`). You do not have the acceptance tests, and you will
not be given them. The application is checked by running them after your turn ends.

## Where the code goes

Follow the stack profile's standards (the `stack-*` skill in `.claude/skills/`). The
application lives under `app/`. `app/package.json` must have a `check` script that
typechecks and runs the unit tests of every package under `app/`; the runner runs
`npm --prefix app run check` after your turn and the proposal fails if it does not pass.
Write unit tests at the seams you create, as you create them.

## Running it locally

`app/compose/compose.yaml` declares everything the application needs to run on one
machine: the application itself, answering on the port in the project's
`targets.new.base_url`; its database; a sandbox identity provider; a mail catcher; and a
one-shot service named `seed`. The `seed` service puts the data back to the state
`tests/seed/manifest.yaml` describes — every handle there, with the identifiers and
sign-in names it gives — wiping anything else first, so running it twice leaves the same
data. Each seeded user signs in to the sandbox identity provider with their `idp_id` as
username and the password compose reads from the `SDLC_SANDBOX_PASSWORD` environment
variable. Never write a password into any file.

Where your instructions name addresses this target cannot be used without, alongside the one the
application itself answers on, a service in this file must stand each of them up and publish it at
exactly the address you were given. The sandbox is not reported up until every one of them answers,
and the run stops there.

If the slice is the first one, it creates all of this. A later slice extends it.

## Screens

Build each page from the story in `design/catalogue/` for that page and state. Every
`data-testid` a story carries, and every `test_id` in `surface.yaml` for your pages, must
be in your markup on the same element.

## Scope

Change only `app/` and, for a choice a later reader would otherwise have to
reverse-engineer, add a record under `docs/decisions/`. A check refuses any other path.
Do not build criteria another slice owns, even where it would be convenient.

## The journal

Your final message is read by the reviewer. Say which criteria you built and how each is
reached in the application, what you unit-tested, anything in the specification you could
not build as written and why, and what the next slice will find missing.

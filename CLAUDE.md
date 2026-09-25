# Working in this repository

This is the pipeline, not a project built with it. Nothing here is tuned to any particular
application, and an agent working here is changing the machinery every project runs.

The reasoning of record is `docs/decisions/`, numbered and dated. Read the ones that touch
what you are about to change before you change it, and add a new one, numbered after the
highest, when you make a decision somebody later would otherwise have to re-derive. Stage
behaviour is documented in `docs/stages/`. This file is only the things it is expensive to
get wrong.

## Node 24, ESM, `node:test`, and exactly two runtime dependencies

`yaml@2.9.0` and `ajv@8.20.0`, pinned. **No third is added** — not a CLI parser, not a test
framework, not a helper library, whatever it would save. The pipeline is installed by
reference into other people's repositories, and every dependency here is one they inherit
without asking (`docs/decisions/0001-node-esm-two-dependencies.md`). Tests are `node --test`
with `node:test` and `node:assert/strict`, in `test/*.test.mjs`.

## The pipeline stays generic

No project, stack, domain, criterion id, screen, table or business rule appears anywhere in
`src/`, `schema/`, `docs/` or the tests. What is specific to a project lives in that
project's own repository; what is specific to a technology lives in a stack profile under
`stacks/`. Examples in documentation and tests are neutral ones. A rule that only makes
sense for the application you happen to be building is a rule in the wrong repository.

## Any gate seat can be held by a person

Every gate is ruled either by a persona agent or by a human typing `--by <role>`, and the
two must reach the same rulings on the same evidence. Anything added to one path is added
to the other: a check enforced only on the agent path is a check a person can walk around,
and a power given only to a person is a promise the pipeline stops keeping the moment it is
simulated. Neither seat is authenticated, so neither is a trust boundary
(`docs/decisions/0003-caller-workflow-and-unauthenticated-roles.md`).

## Secrets are named, never written

No credential, token, key, password or local home path goes into a file, a log line, a
command argument, a prompt, a run record, a proposal page, a gate file or a commit message.
Say what kind of thing it is and where it comes from. The sandbox sign-in password reaches
the containers through the environment alone (`SDLC_SANDBOX_PASSWORD`); a stage checks that
it is set and never reports what it is. Rulings, journals and published pages are scrubbed
of local paths where they are written
(`docs/decisions/0020-a-published-page-is-scrubbed-where-it-is-written.md`).

## A document reads as if for the first time

No drafting history in anything this repository produces or holds — not in a decision
record, not in a stage doc, not in a code comment, not in a commit message. State what is
true now. A caveat about the data or a note saying which definition was used is a fact the
next reader needs; "this used to say something else" is not.

## A fix without a failing test is not a fix

Write the test first and watch it fail for the reason you think it is failing. Then make it
pass. Before committing, run the whole suite and `npm run check`, and leave neither worse
than you found it:

```
npm test
npm run check
```

Commit in logical units, and end every commit message with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

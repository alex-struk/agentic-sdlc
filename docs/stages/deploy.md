# Stage: `deploy`

## Purpose

Take a built application to a hosting platform, once per platform the project lists in its
`deploy` setting (`docs/config.md`). The stage writes three things and nothing else:

- one deployment definition (`deploy/<platform>/`, Bicep or YAML),
- one deploy script, `deploy/<platform>/deploy.sh <environment>`, which prints `DEPLOYED_URL=<url>`,
- one GitHub workflow, `.github/workflows/deploy-<platform>.yml`, that calls that same script.

The platform is chosen here, not in phase 0. What is specific to a platform lives in its deploy
profile under `deploys/<platform>/`; the stack profile says nothing about hosting. Supporting two
platforms is running the stage twice.

It holds gate G3, ruled by the reviewer persona, with proposals named `deploy-<platform>`.

## Inputs

`sdlc run deploy --platform <p>`, run from the project's working tree. `<p>` must be listed in
`deploy` and have a deploy profile; `app/` must exist. The stage runs after the last build step.
`--revise` is not supported: a returned proposal is answered by running the stage again.

## Test-environment run

Before it proposes, the runner runs `bash deploy/<platform>/deploy.sh test` from the machine, requires
a `DEPLOYED_URL=` line, and fetches that URL (a status below 400 passes). The outcome is written into
the proposal page under "Test-environment run", so the gate sees what the script did.

## After approval

GitHub does every deploy. The workflow deploys automatically on a push to the `development` branch;
production is a manual dispatch with a confirmation. There is no second, local deploy path.

## Scope

A deploy session may change `deploy/<platform>/`, its workflow and `docs/decisions/`. A change
elsewhere fails the post-checks. Credentials are never written: sign-in is by the platform's
secretless mechanism, and anything else is named and read from the environment.

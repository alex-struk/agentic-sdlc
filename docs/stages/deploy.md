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

## Bootstrap

Before the agent turn, and before anything is spent on it, the runner sets the platform up from the
operator's machine. A deploy profile that carries `bootstrap/preflight.sh` and `bootstrap/bootstrap.sh`
has them run in that order, from the project directory, with the terminal attached:

- the preflight checks the tools, the sign-in to the platform and, where it can tell, the roles the
  operator holds; it fails the run naming what is missing;
- the bootstrap asks whether to create the platform's resources or use existing ones, what they are
  called and where, then creates or checks them and signs in to the image registry. It writes its
  answers, which are names, ids and regions and never credentials, to
  `.sdlc/deploy-<platform>.local.txt`, a file every project's `.gitignore` already covers.

Every question names a variable. One already set in the environment, or kept in the settings file
from an earlier run, answers it, so a run with no terminal (`sdlc drive`) asks nothing and fails
naming the first variable it lacks. A run that fails here is recorded and committed as
`run(deploy): bootstrap failed`; no agent turn is started.

A run cannot set variables in the shell that started it. On success the runner names the settings it
kept and prints the line that loads them into a shell: `set -a; . .sdlc/deploy-<platform>.local.txt; set +a`.
The bootstrap runs on the operator's machine rather than in the agent's session because the session
holds no platform credentials, may be isolated in a container and cannot ask anyone anything
(`docs/decisions/0109`). A dry run skips it.

## Test-environment run

Before it proposes, the runner runs `bash deploy/<platform>/deploy.sh test` from the machine, with
the bootstrap's settings laid over its environment, requires
a `DEPLOYED_URL=` line, and fetches that URL (a status below 400 passes). The outcome is written into
the proposal page under "Test-environment run", so the gate sees what the script did.

## After approval

GitHub does every deploy. The workflow deploys automatically on a push to the `development` branch;
production is a manual dispatch with a confirmation. There is no second, local deploy path.

## Scope

A deploy session may change `deploy/<platform>/`, its workflow and `docs/decisions/`. A change
elsewhere fails the post-checks. Credentials are never written: sign-in is by the platform's
secretless mechanism, and anything else is named and read from the environment.

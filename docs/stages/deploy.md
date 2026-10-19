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
(`docs/decisions/0115`). A dry run skips it.

## Development run

Before it proposes, the runner runs `bash deploy/<platform>/deploy.sh development` from the machine,
with the bootstrap's settings laid over its environment, requires a `DEPLOYED_URL=` line, and fetches
that URL (a status below 400 passes). The outcome is written into the proposal page under
"Development run", so the gate sees what the script did.

The run deploys the same development environment GitHub deploys on a push to `development`, not an
environment of its own. Whatever it stands up, GitHub's first deploy replaces in place, so a deploy
leaves no environment behind that nothing else uses.

## After approval

GitHub does every deploy. The workflow deploys automatically on a push to the `development` branch;
production is a manual dispatch with a confirmation. There is no second, local deploy path.

## Running it on a built project

The steps below take a project the pipeline has already built to Azure Container Apps. The other
profiles follow the same shape with their own prerequisites.

### Prerequisites

- **The project.** Its `app/` exists and its build slices are approved. The working tree is clean
  and on `main`; `sdlc run` refuses anywhere else. The repository is on GitHub, where the
  workflow will run.
- **The pipeline.** The project's `.sdlc/config.yaml` pins (`pipeline.ref`) a pipeline that has the
  deploy stage, and its profile includes `deploy` (`rebuild`, `greenfield` and `feature` all do).
- **Tools on the operator's machine.** Node 24, `git`, `curl`, `jq`, the Azure CLI (`az`), Docker
  with a daemon the account can reach, and the GitHub CLI (`gh`). Bicep is installed through
  `az bicep install` when it is missing. The agent CLI the project runs its stages on is signed in,
  as for any other stage; `sdlc doctor` reports it.
- **Azure.** A subscription, and an `az login` to it; the preflight offers a device-code sign-in
  when there is none. To create resource groups the account needs Owner or Contributor on the
  subscription; with less, use existing groups. The bootstrap also assigns roles to the identity
  GitHub deploys as, which needs Owner, User Access Administrator or Role Based Access Control
  Administrator; without one, it prints the exact assignments for someone who has it. The
  resource providers the profile uses are registered by the bootstrap when they are not.
- **GitHub.** `gh auth login` as someone who administers the repository, so the bootstrap can
  create the `development` and `production` environments and their variables. Without it the
  deploy still runs, and the environments are left to be set up by hand.
- **Network.** GitHub's hosted runners reach Azure's public endpoints. A subscription that only
  admits private traffic needs self-hosted runners inside its network instead.

### Steps

1. **Name the platform.** Add it to `.sdlc/config.yaml` and commit, then refresh the installed
   pipeline files (`sdlc init` commits what it changes) and push:

   ```yaml
   deploy: [azure-container-apps]
   ```

   ```sh
   sdlc init
   git push origin main
   ```

2. **Check the machine.** `sdlc doctor` reports the tools, sign-ins and configuration.

3. **Run the stage.** `sdlc next` names `sdlc run deploy --platform azure-container-apps` once the
   last build slice is approved. Run it. Running it before then needs `--reason "<why>"`.

   The preflight runs first, then the bootstrap asks whether to create resources or use existing
   ones, what to call them, and which region. Created resources are three resource groups
   (`rg-<prefix>-shared` for the registry and identities, `rg-<prefix>-development` and
   `rg-<prefix>-production`), a container registry, the identity the application pulls its image
   as and the identity GitHub deploys as, with its federated credentials. Each question names a
   variable (`deploys/azure-container-apps/SKILL.md` lists them); setting it beforehand
   answers it, and the answers are kept in `.sdlc/deploy-azure-container-apps.local.txt` for the
   next run.

   The agent then writes the deployment definition, the script and the workflow. The runner runs
   the script against the development environment, checks the application answers, and opens the
   proposal `deploy-azure-container-apps` with the outcome.

4. **Rule on the proposal** at G3:

   ```sh
   sdlc rule deploy-azure-container-apps approve --by reviewer
   ```

   or `--by agent:reviewer` to have the reviewer persona rule. Before approving, check that every
   `uses:` line in the workflow is pinned to a full commit SHA. Approval merges it into `main`.

5. **Hand deploys to GitHub.** Push `main`, and create the `development` branch from it; each push
   to `development` deploys the development environment:

   ```sh
   git push origin main
   git push origin main:development
   ```

   Production is a manual run, approved by the production environment's reviewers when the
   bootstrap was given any:

   ```sh
   gh workflow run deploy-azure-container-apps.yml -f confirm=deploy
   ```

To take everything down, delete the three resource groups (`az group delete --name <group>`); the
GitHub environments and variables are removed from the repository's settings.

## Scope

A deploy session may change `deploy/<platform>/`, its workflow and `docs/decisions/`. A change
elsewhere fails the post-checks. Credentials are never written: sign-in is by the platform's
secretless mechanism, and anything else is named and read from the environment.

# Stage: `deploy`

## Purpose

Take a built application to a hosting platform, once per platform the project lists in its
`deploy` setting (`docs/config.md`). The stage reads the application, works out what deploying it
needs, and writes:

- the plan, `deploy/<platform>/plan.md`: every resource the application needs, every change to
  the application the deploy makes (each by its path under `app/`, with why), and every secret by
  name;
- those changes to `app/`, and only those;
- one deployment definition (`deploy/<platform>/`, Bicep or YAML);
- one deploy script, `deploy/<platform>/deploy.sh <environment>`, which prints `DEPLOYED_URL=<url>`;
- one GitHub workflow, `.github/workflows/deploy-<platform>.yml`, that calls that same script.

The platform is chosen here, not in phase 0. What is specific to a platform lives in its deploy
profile under `deploys/<platform>/`; the stack profile says nothing about hosting. Supporting two
platforms is running the stage twice. There is one environment, development; production is set up
apart from the pipeline.

It holds gate G3, ruled by the reviewer persona, with proposals named `deploy-<platform>`.

## Inputs

`sdlc run deploy --platform <p>`, run from the project's working tree. `<p>` must be listed in
`deploy` and have a deploy profile, and `app/` must exist. The stage runs after the last build
step. `--revise` is not supported: a returned proposal is answered by running the stage again.

The session works in a workspace of its own: the constitution and the stack skill to read, and the
application, `deploy/<platform>/`, the workflow and `docs/decisions/` as what it reads and writes.
A person can hand those files in from a branch instead, with `--hand-in <branch>`, and the run
judges them as it would a session's.

## Checks

Once the session (or the hand-in) is done, the post-checks hold its files to these, in order, and
stop at the first set that fails, with nothing provisioned and nothing pushed:

- **Scope.** The run changes `deploy/<platform>/`, its workflow, `docs/decisions/`, and a path
  under `app/` only where `deploy/<platform>/plan.md` names it.
- **Files.** The plan, a definition, the script and the workflow all exist.
- **Definition.** A Bicep definition stays in its one resource group, since provisioning deploys it
  signed in as a person before anyone has ruled on it: `targetScope` is `resourceGroup`, no module
  is deployed to another scope or pulled from a registry, and it defines nothing under
  `Microsoft.Authorization` (role assignments, locks, policy) and no `deploymentScripts`.
- **Workflow.** It runs the script, deploys development on a push to `main` and to `development`,
  pins every action, reusable workflow and image, reads secrets only one by one, and grants its
  jobs `contents: read`, `id-token: write` and, for images in GitHub's container registry,
  `packages: write`, and nothing more.

A failure goes back to the session as a repair turn, and the checks run again.

## Provisioning

A deploy profile may carry provisioning: `bootstrap/preflight.sh` and `bootstrap/bootstrap.sh`.
Once the files pass their checks, the run executes them on the machine of the person running the
stage, from the project directory, with the terminal attached, signed in to the platform as that
person. The agent session never runs them: it holds no sign-in and cannot ask anyone anything.

- The preflight checks the tools, the sign-ins to the platform and to GitHub and, where it can
  tell, the roles the person holds; it fails naming what is missing.
- The bootstrap asks whether to create the platform's resource group and registry or use existing
  ones, what they are called and where. It asks for each secret the definition reads that is not
  already in the environment, without showing it, before it creates anything, and never writes
  it. It then creates what does not exist, shows what deploying the definition would change, and
  deploys it. Then it gives the identity GitHub deploys as the right to change what the
  definition stood up and to push images, and nothing else, and creates the repository's
  `development` environment, admitting deploys from `main` and `development` and no other branch.
  It writes its answers, which are names, ids and regions and never credentials, to
  `.sdlc/deploy-<platform>.local.txt`, a file every project's `.gitignore` already covers. What
  the person's account cannot do (a role it cannot assign, an environment it cannot create) is
  printed as the exact step for someone who can, and provisioning does not pass until it has run
  again after them.

Every question names a variable. One already set in the environment, or kept in the settings file
from an earlier run, answers it, so provisioning with no terminal asks nothing and fails naming the
first variable it lacks. A repair turn provisions again, and nothing that exists is created twice.
Provisioning that does not pass stops the run before the trial.

`sdlc run deploy --platform <p> --setup` provisions alone, from the definition the checkout holds,
and stops: no workspace, no agent turn, no proposal. It is for deploying the definition `main`
holds again (once an owed step is done, or after a change made by hand), and is recorded and
committed as `run(deploy): set up <p>` or `run(deploy): setup of <p> failed`. It proposes nothing,
so it is not held to what `sdlc next` names (`docs/decisions/0117`).

## Trial deploy

Once provisioning passes, the runner has GitHub deploy the session's work to the development
environment:

1. It commits the working tree as the session left it, on top of `main`, through an index of its
   own, so neither the project's index nor any branch of it moves. What git ignores, the settings
   file among it, is left out.
2. Before anything is published, it refuses the trial: while the commits `main` holds and `origin`
   does not touch anything but the pipeline's run records and journal, since the push publishes
   their history; while the files the trial adds hold anything the egress check forbids or
   anything shaped like a credential; and while the repository's workflows can read a repository
   or organization secret, which no environment holds back from a workflow nobody has ruled on.
3. It pushes that commit to the repository `origin` names on GitHub, to its `development` branch,
   which the workflow deploys, replacing whatever the branch held.
4. It waits for GitHub's run of the workflow on that commit, riding out a call to GitHub that
   fails, reads the run's `DEPLOYED_URL=<url>` line, and fetches the URL; a status below 400
   passes.

What provisioning did and the outcome of the trial, with a link to GitHub's run, are written into
the proposal page under "Provisioning" and "Trial deploy", so the gate sees both. GitHub's run
signs in as the development environment's own identity, which can change the application's
running images and push images to the registry and nothing else, so the workflow is tried before
it is ruled on without being able to create, delete or grant anything. Every deploy runs the
image its own run pushed, by digest.

## After approval

GitHub does every deploy. The workflow deploys development on every push to `main`, and on a push
to `development`, where a trial goes. A deploy changes only which images run; a new resource or a
changed setting is a change to the definition, which the next run of the stage provisions. A
person can still run `deploy/<platform>/deploy.sh <environment>` by hand; it is the same script.

## Running it on a built project

The steps below take a project the pipeline has already built to Azure Container Apps. The other
profiles follow the same shape with their own prerequisites.

### Prerequisites

- **The project.** Its `app/` exists and its build slices are approved. The working tree is clean
  and on `main`, and `main` is pushed; `sdlc run` refuses anywhere else. The repository is on
  GitHub, where the workflow runs.
- **The pipeline.** The project's `.sdlc/config.yaml` pins (`pipeline.ref`) a pipeline that has the
  deploy stage, and its profile includes `deploy` (`rebuild`, `greenfield` and `feature` all do).
- **The machine.** Node 24, `git`, the Azure CLI (`az`) with Bicep, and the GitHub CLI (`gh`), and
  the agent CLI the project runs its stages on, signed in as for any other stage (`sdlc doctor`
  reports it).
- **Azure.** An `az login` to the subscription, as the person running the stage; the preflight
  offers a device-code sign-in when there is none. To create the resource group the account needs
  Owner or Contributor on the subscription; with less, use an existing group. Provisioning also
  assigns roles, which needs Owner, User Access Administrator or Role Based Access Control
  Administrator; without one, it prints the exact assignments for someone who has it.
- **GitHub.** `gh auth login` as someone who administers the repository, so provisioning can create
  the `development` environment and its variables; without it, it prints what an administrator
  sets.
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

2. **Run the stage.** `sdlc next` names `sdlc run deploy --platform azure-container-apps` once the
   last build slice is approved. Run it; running it before then needs `--reason "<why>"`. The agent
   reads the application, writes the plan, the changes to `app/` it names, the definition, the
   script and the workflow. Provisioning then asks whether to create the resource group and
   registry or use existing ones, what to call them, the region, and any secret the definition
   reads, shows what it will deploy, and deploys it into `rg-<prefix>-development`. Each question
   names a variable (`deploys/azure-container-apps/SKILL.md` lists them); setting it beforehand
   answers it, and the answers are kept in `.sdlc/deploy-azure-container-apps.local.txt` for the
   next run. GitHub then deploys the work to the development environment as the trial, and the
   runner opens the proposal `deploy-azure-container-apps` with what both did.

3. **Rule on the proposal** at G3:

   ```sh
   sdlc rule deploy-azure-container-apps approve --by reviewer
   ```

   or `--by agent:reviewer` to have the reviewer persona rule. Approval merges it into `main`.

4. **Push `main`.** From then on every push to `main` deploys the development environment.

   ```sh
   git push origin main
   ```

To take everything down, delete the resource group (`az group delete --name <group>`); the GitHub
environment and its variables are removed from the repository's settings.

## Scope

A deploy session may change `deploy/<platform>/`, its workflow, `docs/decisions/`, and the paths
under `app/` its plan names; nothing else it changes leaves its workspace. Credentials are never
written: sign-in is by the platform's secretless mechanism, and anything else is named and read
from the environment.

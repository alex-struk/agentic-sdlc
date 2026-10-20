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
`deploy` and have a deploy profile; `app/` must exist; and a profile with a setup of its own must
have been set up on this machine (below). The stage runs after the last build step. `--revise` is
not supported: a returned proposal is answered by running the stage again.

The session works in a workspace of its own: the application, the constitution and the stack
skill to read, and `deploy/<platform>/`, the workflow and `docs/decisions/` as what it writes. A
person can hand those files in from a branch instead, with `--hand-in <branch>`, and the run
judges them as it would a session's.

## Setup

A deploy profile may carry a setup: `bootstrap/preflight.sh` and `bootstrap/bootstrap.sh`. It is
the one step that needs a person signed in to the platform, with the rights to create resources
and assign roles, and it runs in a run of its own:

```sh
sdlc run deploy --platform <p> --setup
```

That run executes the two scripts in that order, from the project directory, with the terminal
attached, records the run, and stops: no workspace, no agent turn, no proposal.

- The preflight checks the tools, the sign-ins to the platform and to GitHub and, where it can
  tell, the roles the operator holds; it fails the run naming what is missing.
- The bootstrap asks whether to create the platform's resources or use existing ones, what they
  are called and where, then creates or checks them, gives each environment's deploys an identity
  of their own, and creates the repository's environments, each admitting deploys from its own
  branches and no others. It refuses environments that share a resource group with each other, or
  with the registry, the identities or the SRE agent, since an environment's deploys can change
  everything in their group. It writes its answers, which are names, ids and regions and never
  credentials, to `.sdlc/deploy-<platform>.local.txt`, a file every project's `.gitignore` already
  covers. What the operator's account cannot do (a role it cannot assign, an environment it cannot
  create) is printed as the exact step for someone who can, and the setup is not complete until it
  has been run again after them.

Every question names a variable. One already set in the environment, or kept in the settings file
from an earlier run, answers it, so a setup with no terminal asks nothing and fails naming the
first variable it lacks. A setup that completes is recorded and committed as `run(deploy): set up
<p>`, and one that does not as `run(deploy): setup of <p> failed`. A setup proposes nothing, so it
is not held to what `sdlc next` names, and it starts no agent turn, so nothing that would refuse
one refuses it.

A deploy run never runs the setup. It is refused at its pre-checks, naming the command above, until
the run records on `main` show that the platform's last setup completed. The records are committed,
so a setup run on one machine counts on every other, and nothing that runs the stage afterwards, an
agent running the pipeline among them, needs to be signed in to the platform at all
(`docs/decisions/0115`, `docs/decisions/0116`).

## Trial deploy

Before it proposes, the runner has GitHub deploy the session's work to the development
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

The outcome, with a link to GitHub's run, is written into the proposal page under "Trial deploy",
so the gate sees what the deploy did. GitHub's run signs in as the development environment's own
identity, which can change nothing but the development resource group and push images to the
registry, so the workflow is tried before it is ruled on without reaching anything else. Every
deploy runs the image its own run pushed, by digest, so an image a trial pushed is never the one
production runs. For the same reason the post-checks refuse a workflow that leaves an action, a
reusable workflow or an action of its own unpinned to a full commit SHA, runs an image not pinned
by digest, reads its secrets other than one by one, or grants a job anything beyond
`contents: read`, `id-token: write` and, for images in GitHub's container registry,
`packages: write`.

The trial deploys the development environment that GitHub's own deploys use, not an environment of
its own, so a deploy leaves nothing behind that nothing else uses.

## After approval

GitHub does every deploy. The workflow deploys development on every push to `main`, and on a push
to `development`, where a trial goes; production is a manual dispatch with a confirmation. A person
can still run `deploy/<platform>/deploy.sh <environment>` by hand; it is the same script.

## Running it on a built project

The steps below take a project the pipeline has already built to Azure Container Apps. The other
profiles follow the same shape with their own prerequisites.

### Prerequisites

- **The project.** Its `app/` exists and its build slices are approved. The working tree is clean
  and on `main`, and `main` is pushed; `sdlc run` refuses anywhere else. The repository is on
  GitHub, where the workflow runs.
- **The pipeline.** The project's `.sdlc/config.yaml` pins (`pipeline.ref`) a pipeline that has the
  deploy stage, and its profile includes `deploy` (`rebuild`, `greenfield` and `feature` all do).
- **For the setup, once.** On the machine: Node 24, `git`, the Azure CLI (`az`) and the GitHub CLI
  (`gh`). In Azure: an `az login` to the subscription; the preflight offers a device-code sign-in
  when there is none. To create resource groups the account needs Owner or Contributor on the
  subscription; with less, use existing groups. The setup also assigns roles to the identities
  GitHub deploys as, which needs Owner, User Access Administrator or Role Based Access Control
  Administrator; without one, it prints the exact assignments for someone who has it. The resource
  providers the profile uses are registered when they are not. On GitHub: `gh auth login` as
  someone who administers the repository, so the setup can create the environments and their
  variables; without it, it prints what an administrator sets.
- **For a deploy run.** The agent CLI the project runs its stages on, signed in as for any other
  stage (`sdlc doctor` reports it), and `gh` and `git` able to push to the repository. No sign-in
  to Azure.
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

2. **Set the platform up**, as a person with the rights above:

   ```sh
   sdlc run deploy --platform azure-container-apps --setup
   ```

   It asks whether to create resources or use existing ones, what to call them, and which region.
   Created resources are the resource groups (`rg-<prefix>-shared` for the registry and
   identities, `rg-<prefix>-development`, and `rg-<prefix>-production` unless production is
   skipped), a container registry, the identity the application pulls its image as, and an
   identity for each environment's deploys, with its federated credential. A group that already
   exists is used as it is, so an environment the application already runs in can be taken over.
   Each question names a variable (`deploys/azure-container-apps/SKILL.md` lists them); setting
   it beforehand answers it, and the answers are kept in
   `.sdlc/deploy-azure-container-apps.local.txt` for the next run.

3. **Run the stage.** `sdlc next` names `sdlc run deploy --platform azure-container-apps` once the
   last build slice is approved. Run it; running it before then needs `--reason "<why>"`. The agent
   writes the deployment definition, the script and the workflow; GitHub deploys them to the
   development environment as the trial; and the runner opens the proposal
   `deploy-azure-container-apps` with the outcome.

4. **Rule on the proposal** at G3:

   ```sh
   sdlc rule deploy-azure-container-apps approve --by reviewer
   ```

   or `--by agent:reviewer` to have the reviewer persona rule. Approval merges it into `main`.

5. **Push `main`.** From then on every push to `main` deploys the development environment.
   Production is a manual run, approved by the production environment's reviewers when the setup
   was given any:

   ```sh
   git push origin main
   gh workflow run deploy-azure-container-apps.yml -f confirm=deploy
   ```

To take everything down, delete the resource groups (`az group delete --name <group>`); the GitHub
environments and variables are removed from the repository's settings.

## Scope

A deploy session may change `deploy/<platform>/`, its workflow and `docs/decisions/`; nothing else
it changes leaves its workspace. Credentials are never written: sign-in is by the platform's
secretless mechanism, and anything else is named and read from the environment.

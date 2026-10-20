---
name: deploy-azure-container-apps
description: Deploy standards for hosting an application on Azure Container Apps, with Log Analytics and Application Insights for monitoring and an optional connection to the Azure SRE Agent.
---

# Deploy profile: Azure Container Apps

## Use when

- The project's `.sdlc/config.yaml` lists `azure-container-apps` in `deploy`.

## Two things to settle before the first deploy

1. **Whether GitHub's runners can reach the subscription.** The hosted runners are on the public
   internet. They reach the Azure management API and a public Container Apps environment, and
   they do not reach a data service that is private to a virtual network. If the application
   needs one (a database with no public endpoint), production needs self-hosted runners inside
   that network; the workflow's `runs-on` is then the only line that changes. Say in the
   decision record which case applies. A subscription policy can also stop a hosted runner
   short: run a canary deployment early and read the denial, rather than trusting a validation
   that passed.
2. **Which sign-in methods the subscription allows.** Use OpenID Connect federation, so GitHub
   signs in with no stored secret. Registry admin credentials, service-principal passwords and
   some managed-identity setups are commonly blocked by policy; OIDC is the one that is not.

## Sign-in

- Every workflow that logs in declares `permissions: id-token: write` (and `contents: read`),
  and signs in with the `azure/login` action using a client id, tenant id and subscription id
  read from repository or environment **variables**. None of the three is written in a file.
- The federated credential is scoped to the repository and to a GitHub **environment**
  (`development`, `production`), not to a branch, so the environment's own rules apply. The
  subject is `repo:<owner>/<repo>:environment:<name>`.
- Each environment has an identity of its own, `id-<prefix>-github-<environment>`, which only
  its own GitHub environment can sign in as. It holds Contributor on that environment's resource
  group alone, AcrPush on the registry, and Managed Identity Operator on the identity the app
  pulls its image as, and nothing on the SRE agent. The setup (below) creates the identities,
  their federated credentials and their role assignments, and the GitHub environments with
  their variables, each admitting deploys only from its own branches: development from `main`
  and `development`, production from `main`. Where the operator cannot assign a role or
  administer the repository, the setup prints the exact steps for someone who can.
- Pin every action to a full commit SHA, pin the runner image, set `permissions: {}` on the
  workflow and grant each job only `contents: read` and `id-token: write` (and `packages: write`
  where the images go to GitHub's container registry), and start each script with
  `set -euo pipefail`. A deploy's trial runs the workflow before it is ruled on, so a post-check
  refuses one that leaves an action unpinned or grants anything more.

## Setup and settings

The platform is set up once, by a person signed in to Azure with the rights below:
`sdlc run deploy --platform azure-container-apps --setup`. That run executes
`bootstrap/preflight.sh` and then `bootstrap/bootstrap.sh` from this profile on the operator's
machine, with the terminal attached, and nothing else. The preflight checks the tools (the
Azure and GitHub CLIs, git and node), the Azure sign-in (offering `az login` when there is a
terminal), the operator's roles and the resource providers. The bootstrap asks whether to create
the resources or use existing ones, their names or ids and the region, then creates or checks
them, and writes its answers to `.sdlc/deploy-azure-container-apps.local.txt`, which git ignores,
with `SETUP=complete` once nothing a deploy needs is owed. A deploy run refuses to start until
it is. Every question names a variable; setting it beforehand answers it, so an unattended run
asks nothing.

A resource group that already exists is used as it is, so an environment the application already
runs in can be taken over by naming it as `RESOURCE_GROUP`. Setting `RESOURCE_GROUP_PRODUCTION`
to nothing sets up development alone.

| Setting | What it is |
|---|---|
| `AZURE_SUBSCRIPTION_ID`, `AZURE_TENANT_ID` | Where everything is deployed. |
| `LOCATION` | The region; one where `Microsoft.App/managedEnvironments` is offered. |
| `RESOURCE_GROUP` | The development environment's group, which a deploy's trial also deploys to. On GitHub, each environment's own. |
| `RESOURCE_GROUP_PRODUCTION` | The production environment's group; empty for none. |
| `SHARED_RESOURCE_GROUP` | The registry and the identities. |
| `REGISTRY_NAME`, `REGISTRY` | The Azure Container Registry, and the image path in it. |
| `PULL_IDENTITY_ID` | The user-assigned identity the app pulls its image as (AcrPull). |
| `SRE_AGENT_ID` | An existing Azure SRE Agent to connect; empty for none. |
| `GITHUB_REPO`, `PRODUCTION_REVIEWERS` | Where the workflow runs, and who approves production. |
| `AZURE_CLIENT_ID_DEVELOPMENT`, `AZURE_CLIENT_ID_PRODUCTION` | The identity each environment's deploys sign in as; on GitHub, that environment's `AZURE_CLIENT_ID`. |
| `SETUP` | `complete` once nothing a deploy needs is owed. |

These are names, ids and a region. No credential is among them, and none is needed: GitHub
signs in by OpenID Connect and the app pulls by managed identity.

The setup does not create the Azure SRE Agent itself or supply the application's own secrets;
the deploy script reads those from the environment.

## What the definition stands up

One Bicep file (or a small set of modules) at `deploy/azure-container-apps/`, parameterised by
environment name, deployed into one resource group per environment:

- a **Log Analytics workspace**, of its own so this environment's data stays apart from any
  other, and a **workspace-based Application Insights** component writing to it;
- a **Container Apps environment** whose logs go to that workspace;
- one **Container App** per service, with external ingress for the one that serves users and
  internal ingress for one only another service calls. Co-locate a backend only one other
  service calls with its caller. Application Insights' connection string reaches the app as a
  setting, and the app is configured to report to it;
- **alerts**: an availability web test on the application's status page, an alert when that
  test fails from two locations, and an alert on server errors (5xx) from the app;
- a PostgreSQL flexible server where the application needs a database, with TLS required
  (`sslmode=require` in the connection string) and its password taken from a secret supplied by
  the environment, never a file;
- the app pulls its image as the user-assigned identity `PULL_IDENTITY_ID`, named in its
  `registries` configuration;
- secrets are passed in as `readEnvironmentVariable` parameters, from secrets of the GitHub
  environment the job deploys, each named in the workflow, and held as Container Apps secrets.

Enable ingress over HTTPS. A subscription policy may deny plain-HTTP ingress even where the
validation passes.

## Images

- Build the image in the deploy script on every run and push it to the registry the project uses
  (Azure Container Registry, or GitHub's container registry). Tag it with the commit SHA (12
  characters) and never by `latest` alone, and deploy it by the digest of the image its own run
  pushed (`<registry>/<image>@sha256:…`), never by a tag. Every environment's deploys can push to
  the registry, a trial's among them, so a tag is no proof of who pushed it; a digest the run read
  back from its own push is. Lowercase the registry path.
- A registry package on GitHub's container registry is made public by a person, once; the API
  cannot do it. Say so in the decision record if it applies.
- An address that is only known after the first deploy (the application's own public address,
  which an identity provider behind ingress must be told) forces two passes: stand the
  foundation up, build and push the images, then deploy the apps. The script does both, in that
  order, and is safe to run again.

## The deploy script

`deploy/azure-container-apps/deploy.sh <environment> [image-tag]`:

1. Reads its settings from the environment (resource group, location, registry, pull
   identity); it holds none of them itself, and reports which is missing by name. The resource
   group is the environment's own and must exist.
2. Deploys the foundation, then the apps, with the image tag (the current commit's by default).
3. Smoke-tests the deployed application with `curl` against its status page and at least one
   page that needs the application to be talking to its own dependencies, retrying for up to
   two minutes, and fails if none answers.
4. Prints `DEPLOYED_URL=<address>` as its last line, and nothing else a reader of the
   workflow's public log should not see.

A person deploying by hand runs the same command as the workflow, image build included. The
workflow adds only sign-in.

## The workflow

`.github/workflows/deploy-azure-container-apps.yml`:

- A `push` to `main` deploys the `development` environment, and so does a push to
  `development`, the branch a deploy's trial is pushed to before its proposal is ruled on.
- `workflow_dispatch` with a typed confirmation (`deploy`) deploys production, with an optional
  image tag that defaults to the commit's. The production job uses the `production` GitHub
  environment, so its protection rules apply.
- Each job runs under a concurrency group that never cancels a deploy in progress.
- Both call the one script. Neither carries deploy logic of its own.

## Monitoring and the SRE Agent

Application Insights and Log Analytics are always part of the definition. Connecting the Azure
SRE Agent is part of the setup, and optional: it happens when the setup is given `SRE_AGENT_ID`,
the agent's resource id.

- The setup gives the agent's identity read-only roles on each environment's resource group
  (Reader, Monitoring Reader, Log Analytics Reader) and sets the agent to watch each group. No
  deploy touches the agent, so no identity GitHub deploys as holds any right on it, and a trial
  cannot change what the agent does. Anything the agent changes stays behind its own approval
  mode.
- Setting the agent to watch a group reads the agent resource, adds the group to
  `knowledgeGraphConfiguration.managedResources` (the union with what is there, so nothing is
  dropped), and patches it back **with `knowledgeGraphConfiguration.identity` included**; the
  API refuses the change without it. The patch is asynchronous: `provisioningState` is polled
  until it leaves `InProgress`. A group the agent already watches is left as it is.
- The alerts above are what the agent responds to. The agent's own Application Insights is not
  the application's; query the application's Log Analytics workspace tables, not
  `az monitor app-insights query`.
- Where the agent is to report findings back into the pipeline's process, that wiring is the
  project's to record; this profile stops at the agent being attached and able to read.

## Templates

The files below are starting points to adapt to the application, not text to copy unread.

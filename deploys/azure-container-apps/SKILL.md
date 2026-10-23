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
   they do not reach a data service that is private to a virtual network. If a deploy needs to
   reach one, it needs self-hosted runners inside that network; the workflow's `runs-on` is then
   the only line that changes. Say in the decision record which case applies.
2. **Which sign-in methods the subscription allows.** Use OpenID Connect federation, so GitHub
   signs in with no stored secret. Registry admin credentials, service-principal passwords and
   some managed-identity setups are commonly blocked by policy; OIDC is the one that is not.

## Read the application first

Before writing anything, read `app/` through and write `deploy/azure-container-apps/plan.md`,
from the template below:

- **What the application needs**: every resource it needs to run (a container app per service,
  a database, storage, a cache, an identity provider's settings) and the file of the definition
  that stands each up.
- **Changes to the application**: each change a deploy needs, by its path under `app/`, with what
  changes and why: a port read from the environment, a status page the smoke test and the
  availability test can ask, a `Dockerfile` where there is none, a setting read from the
  environment rather than a file. The stage refuses a change to `app/` the plan does not name by
  its path. Anything else the application needs is the build stage's, not a deploy's.
- **Secrets**: each secret, by the name the definition reads it under and where it comes from.
  Never a value.
- **Provisioning**: what the person provisioning provides beyond signing in.

The gate reads the plan with the definition, so it is where a reader learns why each resource
and each change is there.

## Who creates what

Everything is created by **provisioning**, run on the machine of the person running the stage,
signed in to Azure as themselves. Nothing is created by a deploy. The workflow's identity can
change the container apps provisioning stood up and push images, and nothing else, so a deploy,
a trial among them, cannot create, delete or grant anything (`docs/decisions/0117`).

- **Provisioning** (`bootstrap/preflight.sh`, then `bootstrap/bootstrap.sh`) runs within a
  deploy run once the session's files pass their checks, and before the trial. It uses one
  resource group, the development environment's, and puts in it:
  - the container registry (Basic, admin user off);
  - `id-<prefix>-pull`, the identity the application pulls its images as, with AcrPull on the
    registry;
  - `id-<prefix>-github-development`, the identity GitHub deploys as, which only the
    repository's `development` environment can sign in as;
  - whatever `main.bicep` defines, deployed from `main.bicepparam` after a what-if is shown.

  It then gives `id-<prefix>-github-development` **Container Apps Contributor on each container
  app** the definition stood up, and **AcrPush on the registry**, and nothing else: no
  Contributor, no right on the group, no right on any identity. It creates the repository's
  `development` environment, admitting deploys from `main` and `development` only, with its
  variables. Where the person cannot assign a role or administer the repository, it prints the
  exact steps for someone who can.
- **A deploy** (`deploy.sh`, from the workflow) builds the images, pushes them, and points the
  container apps at them. A new resource, a new container app, a changed setting or scale is a
  change to the definition, which the next provisioning deploys.

Because provisioning runs as the person, before the gate rules, a post-check holds the
definition to its one resource group: `targetScope` is `resourceGroup`, no module is deployed
to another scope or pulled from a registry, and nothing under `Microsoft.Authorization` (role
assignments, locks, policy) or `Microsoft.Resources/deploymentScripts` is defined. Provisioning
assigns the roles.

## Sign-in

- The workflow declares `permissions: {}` and grants its job `contents: read` and
  `id-token: write` (and `packages: write` where the images go to GitHub's container registry),
  and signs in with the `azure/login` action using a client id, tenant id and subscription id
  read from the environment's **variables**. None of the three is written in a file.
- The federated credential is scoped to the repository and to the GitHub `development`
  environment, not to a branch, so the environment's own rules apply. Provisioning adds one for
  each form of subject GitHub may send: `repo:<owner>/<repo>:environment:development`, and
  `repo:<owner>@<owner-id>/<repo>@<repo-id>:environment:development` for a repository whose
  OIDC subject carries the ids.
- Pin every action to a full commit SHA, pin the runner image, and start each script with
  `set -euo pipefail`. A deploy's trial runs the workflow before it is ruled on, so a post-check
  refuses one that leaves an action unpinned or grants anything more.

## Provisioning and settings

A deploy run provisions once its files pass their checks; a repair turn provisions again, and
nothing that exists is created twice. `sdlc run deploy --platform azure-container-apps --setup`
provisions alone, from the definition the checkout holds, for when the definition on `main` is
to be deployed again or an owed step has since been done.

The preflight checks the tools (the Azure and GitHub CLIs, Bicep, git and node), the Azure
sign-in (offering `az login` when there is a terminal), the person's roles and the resource
providers. The bootstrap asks whether to create the group and registry or use existing ones,
their names and the region, and writes its answers to
`.sdlc/deploy-azure-container-apps.local.txt`, which git ignores, with `SETUP=complete` once
nothing a deploy needs is owed. Every question names a variable; setting it beforehand answers
it, so an unattended run asks nothing. A resource group that already exists is used as it is, so
an environment the application already runs in can be taken over by naming it as
`RESOURCE_GROUP`.

| Setting | What it is |
|---|---|
| `AZURE_SUBSCRIPTION_ID`, `AZURE_TENANT_ID` | Where everything is deployed. |
| `LOCATION` | The region; one where `Microsoft.App/managedEnvironments` is offered. |
| `RESOURCE_GROUP` | The development environment's group, which holds everything. |
| `REGISTRY_NAME`, `REGISTRY` | The Azure Container Registry, and its login server. |
| `PULL_IDENTITY_ID` | The user-assigned identity the app pulls its images as (AcrPull). |
| `SRE_AGENT_ID` | An existing Azure SRE Agent to connect; empty for none. |
| `GITHUB_REPO` | Where the workflow runs. |
| `AZURE_CLIENT_ID` | The identity GitHub deploys as. |
| `SETUP` | `complete` once nothing a deploy needs is owed. |

These are names, ids and a region. No credential is among them, and none is needed: GitHub
signs in by OpenID Connect and the app pulls by managed identity. The repository's
`development` environment gets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`,
`RESOURCE_GROUP` and `REGISTRY` as variables.

## What the definition stands up

`deploy/azure-container-apps/main.bicep` (with modules beside it where it grows), deployed by
provisioning from `main.bicepparam` into the one resource group:

- a **Log Analytics workspace**, and a **workspace-based Application Insights** component
  writing to it;
- a **Container Apps environment** whose logs go to that workspace;
- one **Container App** per service, with external ingress for the one that serves users and
  internal ingress for one only another service calls. Co-locate a backend only one other
  service calls with its caller. Application Insights' connection string reaches the app as a
  setting, and the app is configured to report to it;
- **alerts**: an availability web test on the application's status page, an alert when that
  test fails from two locations, and an alert on server errors (5xx) from the app;
- a PostgreSQL flexible server where the application needs a database, with TLS required
  (`sslmode=require` in the connection string) and its password a secret parameter;
- the app pulls its images as the user-assigned identity `pullIdentityId`, named in its
  `registries` configuration.

The parameters file reads from the environment what provisioning hands it: `NAME_PREFIX`,
`LOCATION`, `REGISTRY_SERVER`, `PULL_IDENTITY_ID`, and `EXISTING_IMAGES`, the image each
container runs now as `{"<app>/<container>": image}`. A container takes its image from there,
and the placeholder (`initialImage`) until its first deploy, so provisioning again never puts back
an image a deploy replaced. The placeholder answers on another port than the application, so a
container app running it keeps no replica (`minReplicas: 0`) until a deploy has run.

Each secret the application needs is a `@secure()` parameter the parameters file reads with
`readEnvironmentVariable('<NAME>')` and no default, held as a Container Apps secret. Provisioning
asks the person for each one it finds unset, without showing it, or takes it from the
environment, before it creates anything, and never writes it. The workflow reads no secret: a
deploy changes only images.

Enable ingress over HTTPS. A subscription policy may deny plain-HTTP ingress even where the
validation passes.

## Images

- Build each image in the deploy script on every run and push it to the registry, as
  `<registry>/<container>:<commit SHA, 12 characters>`, never by `latest` alone, and deploy it by
  the digest of the image its own run pushed (`<registry>/<container>@sha256:…`), never by a tag.
  A trial's deploy pushes to the same registry, so a tag is no proof of who pushed it; a digest
  the run read back from its own push is. Lowercase the registry path.
- An address that is only known after the first deploy (the application's own public address,
  which an identity provider behind ingress must be told) is read from the container app once
  provisioning has stood it up, and set in the definition, which the next provisioning deploys.

## The deploy script

`deploy/azure-container-apps/deploy.sh <environment> [image-tag]`:

1. Reads `RESOURCE_GROUP` and `REGISTRY` from the environment; it holds neither itself, and
   reports which is missing by name.
2. Builds and pushes each image named in its `BUILD` map (container name to build context),
   reading back each digest.
3. For each container app in the group, changes the image of each container it built, by a
   `PATCH` of the app's `properties.template` alone, and waits for it to finish. It fails if an
   image it built runs nowhere. It creates nothing and deploys no Bicep.
4. Smoke-tests the deployed application with `curl` against its status page, retrying for up to
   two minutes, and fails if it does not answer.
5. Prints `DEPLOYED_URL=<address>` as its last line, and nothing else a reader of the workflow's
   public log should not see.

A person deploying by hand runs the same command as the workflow, image build included. The
workflow adds only sign-in.

## The workflow

`.github/workflows/deploy-azure-container-apps.yml`:

- A `push` to `main` deploys the `development` environment, and so does a push to
  `development`, the branch a deploy's trial is pushed to before its proposal is ruled on.
- Its one job uses the `development` GitHub environment and runs under a concurrency group that
  never cancels a deploy in progress.
- It calls the one script and carries no deploy logic of its own.

## Monitoring and the SRE Agent

Application Insights and Log Analytics are always part of the definition. Connecting the Azure
SRE Agent is part of provisioning, and optional: it happens when provisioning is given
`SRE_AGENT_ID`, the agent's resource id.

- Provisioning gives the agent's identity read-only roles on the resource group (Reader,
  Monitoring Reader, Log Analytics Reader) and sets the agent to watch it. No deploy touches the
  agent, so the identity GitHub deploys as holds no right on it, and a trial cannot change what
  the agent does. Anything the agent changes stays behind its own approval
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

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
  (`development`, `production`), not to a branch, so the production environment's own approval
  rules apply. The subject is `repo:<owner>/<repo>:environment:<name>`.
- The identity holds Contributor on the resource group, and AcrPush on the registry when the
  images go to Azure Container Registry. Assigning a role needs Owner, so the one-time setup is
  done by a person, and is written down in the decision record, not automated here.
- Pin every third-party action to a full commit SHA, pin the runner image, set
  `permissions: {}` on the workflow and grant each job only what it needs, and start each script
  with `set -euo pipefail`.

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
- secrets are passed in as `readEnvironmentVariable` parameters or workflow secrets and held as
  Container Apps secrets.

Enable ingress over HTTPS. A subscription policy may deny plain-HTTP ingress even where the
validation passes.

## Images

- Build the image in the deploy script and push it to the registry the project uses (Azure Container
  Registry, or GitHub's container registry). Tag it with the commit SHA (12 characters) and never
  by `latest` alone. Lowercase the registry path.
- A registry package on GitHub's container registry is made public by a person, once; the API
  cannot do it. Say so in the decision record if it applies.
- An address that is only known after the first deploy (the application's own public address,
  which an identity provider behind ingress must be told) forces two passes: stand the
  foundation up, build and push the images, then deploy the apps. The script does both, in that
  order, and is safe to run again.

## The deploy script

`deploy/azure-container-apps/deploy.sh <environment> [image-tag]`:

1. Reads its settings from the environment (resource group, location, registry, environment
   name); it holds none of them itself, and reports which is missing by name.
2. Deploys the foundation, then the apps, with the image tag (the current commit's by default).
3. Smoke-tests the deployed application with `curl` against its status page and at least one
   page that needs the application to be talking to its own dependencies, retrying for up to
   two minutes, and fails if none answers.
4. When `SRE_AGENT_ID` is set, attaches the environment's resource group to the SRE agent
   (below).
5. Prints `DEPLOYED_URL=<address>` as its last line.

Running it from a machine and running it from the workflow are the same command, image build
included. The workflow adds only sign-in.

## The workflow

`.github/workflows/deploy-azure-container-apps.yml`:

- `push` to the `development` branch deploys the `development` environment.
- `workflow_dispatch` with an `environment` input and a typed confirmation (`deploy`) deploys
  production, and an optional image tag that defaults to the commit's. The production job uses
  the `production` GitHub environment, so its protection rules apply, and runs under a
  concurrency group that never cancels a deploy in progress.
- Both call the one script. Neither carries deploy logic of its own.

## Monitoring and the SRE Agent

Application Insights and Log Analytics are always part of the definition. Connecting the Azure
SRE Agent to the deployed application is part of the same deploy, and optional: it happens when
the repository variable `SRE_AGENT_ID` (the agent's resource id) is set.

- Give the agent's identity read-only roles on the environment's resource group in the
  definition: Reader, Monitoring Reader, Log Analytics Reader. Anything it changes stays behind
  its own approval mode.
- Attach by reading the agent resource, adding the environment's resource group to
  `knowledgeGraphConfiguration.managedResources` (the union with what is there, so nothing is
  dropped), and patching it back **with `knowledgeGraphConfiguration.identity` included**; the
  API refuses the change without it. The patch is asynchronous: poll `provisioningState` until
  it leaves `InProgress`, and fail unless it ends `Succeeded`. If the group is already
  attached, do nothing.
- The alerts above are what the agent responds to. The agent's own Application Insights is not
  the application's; query the application's Log Analytics workspace tables, not
  `az monitor app-insights query`.
- Where the agent is to report findings back into the pipeline's process, that wiring is the
  project's to record; this profile stops at the agent being attached and able to read.

## Templates

The files below are starting points to adapt to the application, not text to copy unread.

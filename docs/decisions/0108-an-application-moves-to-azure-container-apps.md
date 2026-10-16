# 0108 · An application built here moves to Azure Container Apps

Status: accepted · 2026-10-06

## Context

An application built by the pipeline was first hosted on OpenShift. Hosting it on Azure Container
Apps, with Log Analytics and Application Insights for telemetry and an Azure SRE Agent watching it,
was worked out by hand on a branch of such a project, and a pilot's GitHub workflows showed how
GitHub signs in to Azure and deploys to Container Apps.

## Decision

The application's move to Azure is recorded as a deploy run with the `azure-container-apps`
profile (`docs/decisions/0107`). What was learned is in that profile:

- GitHub signs in by OIDC with no stored secrets; the one-time federated-credential and role setup
  needs an owner and is manual.
- Images are tagged by commit SHA and pushed to a container registry; the app is deployed in two
  passes, the second pointing at the pushed image.
- A smoke test follows each deploy.
- Attaching the SRE agent reads the agent, unions the resource group into its managed resources,
  patches with its identity included, then polls until provisioning leaves `InProgress`.
- The agent's identity needs Reader, Monitoring Reader and Log Analytics Reader on the group.

## Consequences

The project's `deploy` setting lists `azure-container-apps`; OpenShift remains a profile, not a
default. Running deploy again for a platform replaces nothing already approved.

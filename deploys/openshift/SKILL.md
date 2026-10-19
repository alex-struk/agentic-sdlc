---
name: deploy-openshift
description: Deploy standards for hosting an application on OpenShift, through the reusable workflows the platform's team maintains.
---

# Deploy profile: OpenShift

## Use when

- The project's `.sdlc/config.yaml` lists `openshift` in `deploy`.

## Deploy

- Deploy through the `bcgov/quickstart-openshift-helpers` reusable
  workflows, referenced by a pinned, versioned commit.
- No project workflow defines a route to a production namespace.
- The deploy script, `deploy/openshift/deploy.sh <environment>`, drives those workflows' own
  deploy action for the named environment and prints `DEPLOYED_URL=<address>` once the
  application answers there.
- The workflow, `.github/workflows/deploy-openshift.yml`, runs that script: on a push to the
  `development` branch, and for production only by a manual `workflow_dispatch` that asks for
  confirmation.

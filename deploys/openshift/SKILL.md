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
- `deploy/openshift/plan.md` says what the application needs on the platform, each change to
  `app/` a deploy makes by its path and why, and each secret by name.
- The workflow, `.github/workflows/deploy-openshift.yml`, runs that script against development
  on a push to `main` and on a push to the `development` branch, where a deploy's trial is
  pushed.
  It sets `permissions: {}`, grants each job only `contents: read`, `id-token: write` and, to
  push images to GitHub's container registry, `packages: write`, and pins every action and
  reusable workflow to a full commit SHA.

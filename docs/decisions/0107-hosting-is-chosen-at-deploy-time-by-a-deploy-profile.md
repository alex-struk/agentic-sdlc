# 0107 · Hosting is chosen at deploy time, by a deploy profile

Status: accepted · 2026-10-06

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

The stack profile carried the project's deploy instructions, so the choice of hosting was made in
phase 0 with the stack, and moving a project to another platform meant changing its stack. A
deployed application also needs monitoring and an operations agent attached, and by hand that is the
work the pipeline exists to remove.

## Decision

**Hosting is a deploy-time choice.** Each platform has a deploy profile under `deploys/`
(`openshift`, `azure-container-apps`). The plan skill no longer lists deploy among the things the
stack decides.

**A project setting, `deploy: [<platform>...]`, is read only by the deploy stage.** It is not
`targets`, which names the applications the tests run against.

**The `deploy` stage runs after `build`, once per listed platform.** It writes one deployment
definition, one script and one GitHub workflow that calls the script. Before it proposes, the runner
runs the script against the development environment and checks the application responds; the result
goes to gate G3 with the proposal. It uses development rather than an environment of its own, so a
deploy stands up nothing that GitHub's own deploys do not go on to use.

**After approval GitHub does every deploy**: automatic on the `development` branch, production by
manual dispatch. No local deploy path is kept, because two paths drift apart.

**Monitoring and SRE-agent attachment belong to the Azure profile**, not to a separate stage: the
definition stands up the log workspace, application telemetry and alerts, and the script attaches
the agent's managed resources when the project names an agent.

## Consequences

Switching platforms is another deploy run. Gate G3 is reused rather than adding a gate. Hosted GitHub
runners reach the Azure management API and public Container Apps endpoints but not private-network
data services; production behind a private network needs self-hosted runners. Sign-in is OIDC only.
Neither is verified end to end by this repository; the Azure profile states both as checks to make
first.

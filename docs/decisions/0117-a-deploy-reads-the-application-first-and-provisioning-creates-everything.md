# 0117 · A deploy reads the application first, and provisioning creates everything a deploy runs on

Status: accepted · 2026-10-23

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

The deploy stage asked for the platform to be set up in a run of its own before the agent had read
the application (`docs/decisions/0115`, `docs/decisions/0116`). The setup chose resources from a
fixed list, without knowing what the application needs: a database, storage, a second service, a
secret. The stage could not change the application either, so a deploy that needed the
application to read its port from the environment, or to answer on a status page, could not be
proposed.

Each deploy then deployed the definition itself, from GitHub. The identity GitHub signed in as
held Contributor on the environment's resource group and Managed Identity Operator on the pull
identity, since a deploy created and changed resources. A trial runs that workflow before anyone
has ruled on it, so what the session wrote could create, delete or reconfigure anything in the
group.

The setup also made a shared group for the registry and identities, and a production group and
environment. Production belongs on a subscription of its own, set up apart from the pipeline.

## Decision

**The session reads the application first.** It writes `deploy/<platform>/plan.md` before anything
else: every resource the application needs, every change to the application the deploy makes,
each by its path under `app/` with why, and every secret by name. Then it makes those changes and
writes the definition, the script and the workflow. The stage collects `app/`, and its scope check
refuses a change to a path under `app/` the plan does not name. The plan is required on every
platform.

**Provisioning runs within the deploy run, as the person running it.** Once the files pass their
checks, the runner runs the profile's preflight and bootstrap on that person's machine, signed in
to the platform as themselves, and only then the trial. The bootstrap deploys the project's own
definition, after showing a what-if, and asks for each secret the definition reads, without
showing or writing it. Provisioning that does not pass stops the run before the trial; a repair
turn provisions again, and nothing that exists is created twice. A deploy run needs no setup
before it. `--setup` provisions alone, from the definition the checkout holds.

**A definition stays in its one resource group.** Provisioning deploys it as a person, before the
gate rules, so a post-check refuses a definition whose `targetScope` is not `resourceGroup`, that
deploys a module to another scope or pulls one from a registry, or that defines anything under
`Microsoft.Authorization` or a `deploymentScripts` resource. Provisioning assigns every role.

**A deploy creates nothing.** The deploy script builds and pushes the images and points the
container apps provisioning stood up at them, by changing their template alone. The identity GitHub
deploys as holds Container Apps Contributor on each of those container apps and AcrPush on the
registry, and nothing else. A new resource or a changed setting is a change to the definition,
which the next run of the stage provisions.

**One environment, in one resource group.** The development environment's group holds the
registry, the identities and what the definition defines. There is no shared group and no
production group, environment, job or `workflow_dispatch` trigger; the workflow deploys
development on a push to `main` or `development`.

**GitHub signs in by either form of subject.** Provisioning adds a federated credential for the
repository by name and one by its owner's and its own ids, so a repository whose OIDC subject
carries the ids signs in too.

This supersedes the parts of `docs/decisions/0115` and `docs/decisions/0116` that make setup a run
every deploy waits for, give the deploy identity Contributor, Managed Identity Operator and an
identity per environment, keep groups apart, and deploy production by dispatch. The trial, what it
refuses to publish, the checks on the workflow, deploying by digest, and the SRE agent being set up
by the person and never by a deploy stand.

## Consequences

- Whoever runs a deploy needs to be signed in to the platform with the rights to create resources
  and assign roles, or to have someone who has run the steps provisioning prints. An agent running
  the pipeline unattended stops at provisioning unless every answer, and every secret, is in the
  environment.
- What the session wrote runs before it is ruled on twice: the definition as the person, held to
  its resource group by the post-check, and the workflow as an identity that can change only which
  images the container apps run and push images.
- A container app runs a placeholder image from provisioning until its first deploy, and
  provisioning again keeps whatever image a deploy put there.
- The person's machine needs Bicep, for provisioning; it still needs no Docker, since images are
  built on GitHub.
- Production, when it comes, is set up on its own subscription, apart from this stage.

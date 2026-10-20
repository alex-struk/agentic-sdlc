# 0116 · A deploy's trial runs on GitHub, as the development environment's own identity

Status: accepted · 2026-10-19

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

The deploy stage tries its work before the gate (`docs/decisions/0113`). The runner ran the deploy
script the session wrote from the operator's machine, signed in as the operator, against the
development environment. That script ran with everything the operator's account can do in the
platform before anyone had read it, and the stage could not run at all unless whoever ran it was
signed in with those rights, an agent running the pipeline included. The platform's setup
(`docs/decisions/0115`) ran at the start of every deploy run for the same reason. Yet the setup is
the one step that needs a person's rights, to create resources and assign roles, and once it is
done a deploy needs none of them: GitHub deploys with an identity of its own.

The setup gave one identity to every environment's deploys, with Contributor on each
environment's group and on the SRE agent. A development deploy could change production, and any
deploy could change what the agent watches.

## Decision

**Setup is a run of its own.** `sdlc run <stage> --setup` runs the stage's setup and nothing else
(for `deploy`, the profile's preflight and bootstrap) and records the run. It is the one step that
needs a person signed in to the platform. A deploy run never runs it, and is refused at its
pre-checks, naming the setup command, until the run records show that the platform's last setup
completed. A setup records `set up <p>` only once nothing a deploy needs is owed, and the records
are committed, so a setup run on one machine counts on every other. A setup proposes nothing and
starts no agent turn, so it is not held to what `next` names, and nothing that would refuse an
agent turn refuses it.

**The trial runs on GitHub.** Once the post-checks on the files pass, the runner commits the
working tree on top of `main` through an index of its own, pushes the commit to the `development`
branch of the repository `origin` names, waits for GitHub's run of the workflow on it, and reads the
run's `DEPLOYED_URL=` line. The address's answer goes to the gate as before, with a link to the
run. The runner never signs in to the platform.

**Nothing is published that should not be.** The trial is refused, before anything is pushed:

- while the commits `main` holds and `origin` does not touch anything but the pipeline's run
  records and journal, since the push publishes their history;
- while the files the trial adds hold anything the egress check forbids, or anything shaped like
  a credential;
- while the repository's workflows can read a repository or organization secret, which no
  environment holds back from a workflow nobody has ruled on.

**Each environment's deploys have an identity of their own.** The setup creates one per
environment, trusted only by that environment's GitHub environment, with Contributor on that
environment's group alone, AcrPush on the registry and Managed Identity Operator on the pull
identity. The `development` environment admits deploys from `main` and `development`;
`production` admits them from `main` only, and the setup takes away any other branch it finds
admitted. The setup refuses environments that share a group with each other, or with the
registry, the identities or the SRE agent, since Contributor on a group reaches everything in it.

**Every deploy runs the image its own run pushed.** The deploy script builds and pushes on every
run and deploys by the digest its push gave back. Every environment's deploys can push to the
registry, a trial's among them, so a tag is no proof of who pushed it.

**The SRE agent is set up once, and no deploy touches it.** The setup gives the agent's identity
its read roles and sets the agent to watch each environment's group. No identity GitHub deploys as
holds any right on the agent.

**Development deploys on every push to main.** The workflow deploys development on a push to
`main` or to `development`, and production only by manual dispatch.

**A workflow is checked before a trial runs it.** The post-checks refuse a workflow that:

- uses an action, a reusable workflow, or an action in the repository whose own steps use one,
  that is not pinned to a full commit SHA;
- runs an image not pinned by its digest;
- reads every secret at once, or one by a name worked out as it runs, or hands every secret on;
- sets no top-level `permissions`, or grants a job anything beyond `contents: read`,
  `id-token: write` and `packages: write`.

**The stage works in a workspace of its own.** It reads the application, the constitution and the
stack skill, and takes back only its platform's directory, its workflow and `docs/decisions/`. That
is also what lets a person hand the stage's work in from a branch (`docs/decisions/0107`).

## Consequences

- Whoever runs a deploy, a person or an agent, needs no rights in the platform once the setup is
  done. What the session wrote runs before it is ruled on only as an identity that can change the
  development environment and push images that no other environment will run.
- A trial takes as long as GitHub's deploy does. It needs the repository on GitHub, `main` pushed,
  and `git` able to push and `gh` signed in on the operator's machine.
- A repository whose workflows can read repository or organization secrets runs no trial until
  those secrets move into the environments that use them.
- The `development` branch belongs to the deploy workflow: each trial replaces what it held, and a
  push to `main` while a trial waits can take its place, which the trial reports.
- A run of the workflow is as public as the repository, so the deploy script prints nothing but
  the address and what went wrong.
- The operator's machine needs no Docker, Bicep, `jq` or `curl`: images are built, and every deploy
  is run, on GitHub.

# 0109 · A platform is set up by the runner, on the operator's machine, before the agent turn

Status: accepted · 2026-10-06

## Context

Deploying to a platform needs things the project's files cannot hold: a signed-in account,
resource groups, a container registry, identities and the roles between them, and the
repository's deploy environments. Each is a one-time step a person would otherwise do by hand from
a list. The deploy stage's agent session cannot do them. It holds no platform credentials, may run
isolated in a container with egress limited to what its stage needs, and cannot ask anyone a
question. A step that needs a choice (create or reuse, what to call it, which region) needs
someone to answer it, or an answer given ahead of time.

## Decision

A deploy profile may carry `bootstrap/preflight.sh` and `bootstrap/bootstrap.sh`. The runner runs
them, in that order, on the operator's machine with the terminal attached, after the stage's
pre-checks and before the agent turn.

- The preflight checks the tools, the sign-in and the roles it can see, and stops the run naming
  what is missing.
- The bootstrap asks its questions, creates or checks the resources, signs in to the registry,
  and writes its answers to `.sdlc/deploy-<platform>.local.txt`, which every project ignores.
- Each question is answered by a named variable when one is set, so `sdlc drive` and any other
  unattended run asks nothing and fails naming the variable it lacks.
- The settings are names, ids and regions. No credential is asked for, written or printed: the
  platform's own sign-in holds the operator's, and the deploys sign in without one.
- The test-environment run gets the settings laid over its environment. The runner prints the
  line that loads them into a shell, because no process can change the environment of the shell
  that started it.
- What cannot be done by the operator's account (a role assignment needing rights it lacks) is
  printed as the exact command for someone who can, and a step the application cannot run without
  fails the run.
- A failed bootstrap is recorded and committed as `run(deploy): bootstrap failed`.

## Consequences

The first deploy to a platform needs no list of manual steps; running the stage again reuses the
saved answers and creates nothing that exists. A platform whose profile has no bootstrap is
deployed as before. The bootstrap is the runner's, not the session's, so it is the same whether the
gate seat is held by a person or a persona agent.

# Deploy the application to one platform

You are writing how the built application is deployed to the platform named in your task, and
nothing else. The deploy profile that follows this skill is the standard for that platform; the
application is in `app/`.

You write three things, and only these:

1. **One deployment definition** in `deploy/<platform>/` (Bicep or YAML, whichever the profile
   says): everything the platform has to stand up for the application to run.
2. **One deploy script**, `deploy/<platform>/deploy.sh`, that takes an environment name
   (`test`, `development` or `production`) as its first argument, deploys the application to it
   from the definition, checks it answers, and prints one line, `DEPLOYED_URL=<address>`, with
   the address the application is reachable at. It is the only way the application is deployed.
3. **One GitHub workflow**, `.github/workflows/deploy-<platform>.yml`, that runs that same
   script: automatically on a push to the `development` branch, and for production only by a
   manual `workflow_dispatch` that asks for confirmation. The workflow holds no deploy logic of
   its own beyond signing in and calling the script.

There is no second path. Nothing in the definition, the script or the workflow may depend on a
person's machine, a stored credential, or a step that only a laptop can do. Sign-in to the
platform uses whatever the profile names, and no credential, token, key, password, tenant or
subscription identifier, or local path is ever written into a file: name what kind of thing it
is and where it comes from (a repository variable, an environment variable).

## What you have and what you do not

You have the whole project. You change only `deploy/<platform>/`, the workflow file and
`docs/decisions/`. A change anywhere else ends the run.

After your turn the runner runs `deploy/<platform>/deploy.sh development` from this machine,
deploying the same development environment GitHub deploys on a push to `development`, then asks
the address it printed whether the application answers. The
proposal goes to its gate with that result. You cannot run the script yourself: your shell lists
and makes directories, and does not reach the platform. Write the script so that a failure at any
step stops it with a non-zero status and a plain message.

## Where decisions go

Where the profile leaves a choice, make it and write a decision record under `docs/decisions/`
for anything a later reader would otherwise have to re-derive: a service the application needs
that the profile does not name, a departure from the profile, a limit of the platform you worked
around. Say in your journal entry anything you could not do, and what it would take.

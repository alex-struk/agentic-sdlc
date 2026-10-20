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
   It builds and pushes the images on every run and deploys each by the digest its own push gave
   back, never by a tag.
3. **One GitHub workflow**, `.github/workflows/deploy-<platform>.yml`, that runs that same
   script: against development, automatically, on a push to `main` and on a push to the
   `development` branch; against production only by a manual `workflow_dispatch` that asks for
   confirmation. The workflow holds no deploy logic of its own beyond signing in and calling the
   script. Every action it uses, its own included, is pinned to a full commit SHA and every image
   by its digest; it names each secret it reads, from the environment its job deploys; and its
   jobs are granted `contents: read`, `id-token: write` and, to push images to GitHub's container
   registry, `packages: write`, and nothing else. The post-checks refuse a workflow that is not.

There is no second path. Nothing in the definition, the script or the workflow may depend on a
person's machine, a stored credential, or a step that only a laptop can do. Sign-in to the
platform uses whatever the profile names, and no credential, token, key, password, tenant or
subscription identifier, or local path is ever written into a file: name what kind of thing it
is and where it comes from (a repository variable, an environment variable).

## What you have and what you do not

You have the application in `app/`, to read, and the project's decision records. What you write
in `deploy/<platform>/`, the workflow file and `docs/decisions/` is what the run takes back;
nothing else you change leaves the workspace.

After your turn the runner commits what you wrote on top of `main`, pushes that commit to the
`development` branch, and waits for GitHub's run of your workflow, which deploys the development
environment with it. It then asks the address your script printed whether the application
answers, and the proposal goes to its gate with that result. Nothing in your session reaches the
platform or GitHub: your shell lists and makes directories. Write the script so that a failure at
any step stops it with a non-zero status and a plain message. The workflow's log is as public as
the repository, so the script prints nothing a reader of it should not see: the
`DEPLOYED_URL=<address>` line, and what went wrong when something does.

## Where decisions go

Where the profile leaves a choice, make it and write a decision record under `docs/decisions/`
for anything a later reader would otherwise have to re-derive: a service the application needs
that the profile does not name, a departure from the profile, a limit of the platform you worked
around. Say in your journal entry anything you could not do, and what it would take.

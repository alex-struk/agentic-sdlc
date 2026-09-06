# Stage: `propose`

## Purpose

Open a named proposal — a decision at a policy gate — as its own git branch with a decision page,
for a gate holder to rule on later.

## Inputs

`sdlc propose <name> --gate G<n> --question "..." --recommendation "..." [--page "..."]`, run from
inside the project's working tree.

## Outputs

- A new branch `proposal/<name>`, created from `main`.
- `.sdlc/proposals/<name>.md`: YAML front matter (`gate`, `question`, `recommendation`, `opened`)
  followed by the question as a heading, the recommendation, and any extra `--page` content.
- An appended `.sdlc/runs/<date>.md` entry.
- One commit on the proposal branch containing both files.

The command leaves the working tree checked out on the new proposal branch.

## Workspace the agent sees

No agent. `propose` only writes the decision page and commits it; whatever produced the question
and recommendation text runs as a separate step before this command is invoked.

## Checks that block

- `name` must match `^[a-z0-9][a-z0-9-]*$`.
- `--gate`, `--question` and `--recommendation` are all required.

## Exit criterion

Exits 0 and prints `opened proposal/<name>`.

## Re-run behaviour

Not idempotent under the same name: `git checkout -b` fails if `proposal/<name>` already exists,
so re-running `propose` with a name already in use errors out. A different name opens a new,
independent branch.

## Failure modes

- Invalid name format or a missing required flag: throws before any git command runs.
- A branch of that name already exists: the underlying `git checkout -b` fails and its error
  surfaces as-is.

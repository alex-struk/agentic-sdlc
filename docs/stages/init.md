# Stage: `init`

## Purpose

Install or refresh the pipeline inside an existing project directory: pin the pipeline and skill
pack versions, install the configured skill packs, generate the CI caller workflow, and seed the
machine-local egress name list.

## Inputs

`sdlc init [dir]`, defaulting to the current directory. Reads `<dir>/.sdlc/config.yaml`.

## Outputs

- `.sdlc/lock.json`: `{ pipeline: { repo, ref, commit }, packs: [...resolved], created }`. The
  pipeline commit is the pipeline repository's own `HEAD` when run from a checkout of it, else
  the configured ref.
- Each configured skill pack cloned (or already present) under `.sdlc/packs/<name>`, checked out
  at its pinned commit.
- The skills each pack lists copied into `.claude/skills/<skill>`, once, on first install.
- `.github/workflows/sdlc-checkpoint.yml`, generated from the template with the pipeline repo and
  ref filled in.
- An appended `.sdlc/runs/<date>.md` entry and a commit — but only when the lockfile, the caller
  workflow, or the installed skills actually changed. A re-run against unchanged inputs writes
  nothing and commits nothing.
- `~/.config/agentic-sdlc/egress-names.txt`, created once per machine if it does not already
  exist. This file lives outside every project directory, so it never affects whether `init`
  considers anything "changed", and it is never part of the commit above.

## Workspace the agent sees

No agent.

## Checks that block

- The configuration must parse and validate against `schema/config.schema.json`; `init` throws
  before doing anything otherwise.
- Each pack's `ref` is resolved to a commit with `git ls-remote` unless it is already a 40-character
  hex commit; a ref that does not resolve throws.

## Exit criterion

Exits 0 and prints `init ok: N skills installed`.

## Re-run behaviour

Idempotent. Running `init` again against the same configuration and the same pack commits detects
no change, installs nothing further, and leaves the working tree and run record untouched. It
only writes and commits again when the configuration, the resolved pack commits, or the generated
workflow actually differ from what is already on disk.

## Failure modes

- Missing or invalid `.sdlc/config.yaml`: throws with every schema error listed.
- A pack `ref` that cannot be resolved by `git ls-remote`: throws naming the pack and the ref.
- A skill named in a pack's `skills` list that is not found inside the cloned pack: reported as a
  warning (`warning: <pack>: skill <name> not found`) rather than a failure — installation of the
  other packs and skills continues.

## The implement-guard table

`templates/hooks/implement-guard.sh` is installed by `new` as a Claude Code `PreToolUse` hook. It
reads the `SDLC_STAGE` environment variable and blocks edits to paths outside the current stage's
territory. An unset `SDLC_STAGE` defaults to `build`, the most restrictive default.

| Stage | Blocked paths |
| --- | --- |
| `build`, `verify`, `review-and-ship` (and unset, which defaults to `build`) | `spec/`, `tests/acceptance/`, `constitution.md`, `.sdlc/config.yaml`, `.github/workflows/` |
| `derive-tests` | `app/`, `tests/adapters/`, `tests/seed/`, `spec/`, `constitution.md`, all of `.sdlc/` |
| `bind-adapter` | `app/`, `tests/acceptance/`, `spec/`, `constitution.md`, all of `.sdlc/` |
| `intent`, `archaeology`, `ratify`, `design`, `plan` | `app/`, `tests/acceptance/`, `tests/adapters/`, `.github/workflows/`, `.sdlc/config.yaml` |
| any other stage name (`calibrate`, `deploy`, `operate`, `status`, `init`, …) | nothing blocked |

A blocked edit exits the hook with status 2 and a message naming the stage and the path; anything
else exits 0 and the edit proceeds.

## The deny list

`templates/project/.claude/settings.json` sets `permissions.deny` for every agent session running
inside a project. Each entry:

| Deny rule | Prevents |
| --- | --- |
| `Bash(git push*)` | Pushing to any remote from inside the agent's session. |
| `Bash(git merge*)` | The agent merging branches itself; merges happen only through `sdlc rule approve`. |
| `Bash(git rebase*)` | Rewriting commit history. |
| `Bash(git reset --hard*)` | Discarding working-tree changes. |
| `Bash(git commit --no-verify*)` | Bypassing commit hooks (long flag form). |
| `Bash(git commit -n *)` | Bypassing commit hooks (short flag form). |
| `Bash(gh pr merge*)` | The agent merging a pull request. |
| `Bash(gh pr review*)` | The agent submitting its own pull request review. |
| `Bash(gh pr close*)` | The agent closing a pull request. |
| `Bash(gh release*)` | The agent cutting a release. |
| `Bash(gh secret*)` | The agent reading or writing repository secrets. |
| `Bash(oc *)` | Direct access to an OpenShift cluster. |
| `Bash(kubectl *)` | Direct access to a Kubernetes cluster. |
| `Bash(helm *)` | Direct cluster changes through Helm. |
| `Bash(npm publish*)` | The agent publishing a package. |
| `Bash(docker push*)` | The agent pushing a container image. |
| `Read(.env*)` | The agent reading local environment secrets. |
| `Read(**/*.pem)` | The agent reading private key material. |
| `Read(**/*.key)` | The agent reading key files. |

`sdlc doctor` treats the presence of the first git-push rule as a proxy for "the deny list is
installed" and warns to re-run `sdlc init` if it is missing.

## Egress name list

`sdlc init` creates `~/.config/agentic-sdlc/egress-names.txt` once per machine. Add colleagues'
names, one per line. The file is never committed; the egress check fails any tracked file that
contains one of them. `sdlc doctor` warns while the list is missing or empty.

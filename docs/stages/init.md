# Stage: `init`

## Purpose

Install or refresh the pipeline inside an existing project directory: pin the pipeline and skill
pack versions, install the configured skill packs, install the agent guardrails (the deny list,
the implement-guard hook and the run-record merge attribute), generate the CI caller workflow,
reconcile the project's `.gitignore`, and seed the machine-local egress name list.

## Inputs

`sdlc init [dir]`, defaulting to the current directory. Reads `<dir>/.sdlc/config.yaml`.

## Outputs

- `.sdlc/lock.json`: `{ pipeline: { repo, ref, commit }, packs: [...resolved], created }`. The
  pipeline commit is the pipeline repository's own `HEAD` when run from a checkout of it, else
  the configured ref.
- Each configured skill pack cloned (or already present) under `.sdlc/packs/<name>`, checked out
  at its pinned commit.
- The skills each pack lists copied into `.claude/skills/<skill>`. A skill folder is copied when
  it is not there; when a pack's pinned commit differs from the commit in the previous lockfile,
  that pack's skill folders are removed first so the new version replaces the old one.
- `.claude/settings.json` (the agent deny list and the `PreToolUse` hook registration),
  `.sdlc/hooks/implement-guard.sh` (made executable) and `.gitattributes` (which marks
  `.sdlc/runs/*.md` as `merge=union`), each written from the pipeline's templates when missing or
  different.
- The five persona briefs a gate's agent holder rules from — `.sdlc/personas/ux-reviewer.md`,
  `tech-lead.md`, `product-owner.md`, `architect.md` and `reviewer.md` — copied from the pipeline's
  own templates the same way: written when missing, rewritten when the pipeline's copy has changed.
  `sdlc rule <name> --by agent:<persona>` reads whichever of these matches the gate's `holder`.
- `.github/workflows/sdlc-checkpoint.yml`, generated from the template with the pipeline repo
  filled in and the pipeline pinned to the commit recorded in `.sdlc/lock.json`, not to the
  floating ref.
- A reconciled `.gitignore` (see "The ignore file" below) and, on a project that still tracks
  `.sdlc/run-state.json`, that file dropped from the index with `git rm --cached
  --ignore-unmatch` — staged with the init commit, with the file itself left on disk because a
  run in progress may be using it.
- The regenerated state site, staged through the same helper every other command uses, so a
  project whose `.gitignore` used to hide `site/` starts tracking it here.
- An appended `.sdlc/runs/<date>.md` entry and a commit — but only when the lockfile, the caller
  workflow, the guardrail files, the ignore file, the tracked state of `.sdlc/run-state.json`, or
  the installed skills actually changed. A re-run against
  unchanged inputs writes nothing and commits nothing.
- The machine's egress name list (see "Egress name list" below for how its path resolves),
  created once if it does not already exist. This file lives outside every project directory, so it never affects whether `init`
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
only writes and commits again when the configuration, the resolved pack commits, the installed
guardrail files, the ignore file, the tracked state of `.sdlc/run-state.json`, or the generated
workflow actually differ from what is already on disk. The ignore reconciliation and the
run-state untracking are both no-ops on a project already in that shape.

## Failure modes

- Missing or invalid `.sdlc/config.yaml`: throws with every schema error listed.
- A pack `ref` that cannot be resolved by `git ls-remote`: throws naming the pack and the ref.
- A skill named in a pack's `skills` list that is not found inside the cloned pack: reported as a
  warning (`warning: <pack>: skill <name> not found`) rather than a failure — installation of the
  other packs and skills continues.

## The ignore file

`init` reconciles `<dir>/.gitignore` **by line, never by overwrite**: a project's own entries — a
build directory, a local tool's scratch file, whatever a team added — are none of the pipeline's
business and are left exactly where they are. Only two edits are ever made.

**Lines that must exist** (appended when missing, in this order, at the end of the file):

| Line | Why |
| --- | --- |
| `node_modules/` | Installed dependencies are never committed. |
| `.sdlc/packs/` | Cloned skill pack repositories: pinned by commit in `.sdlc/lock.json`, re-cloned on demand. |
| `.sdlc/run-state.json` | A run's own scratch — which stage it is on and how far it got. Never a project artifact. |
| `.sdlc/*.local.yaml` | Machine-local configuration overrides. |
| `.sdlc/*.local.txt` | Machine-local lists, including the per-project egress name list. |

**The one line that must not exist**: a line that is exactly `site/`. The generated state site is
a tracked artifact — a run or a ruling folds the freshly regenerated `site/*.md` into the same
commit it makes — so a project carrying that line (an earlier version of the pipeline wrote it)
has it removed, and the site starts being committed from this `init` onward.

Two consequences worth naming. `.sdlc/run-state.json` may already be *tracked* on such a project,
and an ignore line does nothing about a file git already knows: `init` drops it from the index
with `git rm --cached --ignore-unmatch` and stages that removal, leaving the file itself alone in
case a run is using it right now. And `sdlc run`'s own commit filters `.sdlc/run-state.json` out
by name regardless of what any ignore file says, so a half-finished run's bookkeeping can never
land in a stage's record.

## The implement-guard table

`templates/hooks/implement-guard.sh` is installed by `init` as `.sdlc/hooks/implement-guard.sh`
and registered as a Claude Code `PreToolUse` hook by `.claude/settings.json`. It reads the
`SDLC_STAGE` environment variable and blocks edits to paths outside the current stage's territory.
An unset `SDLC_STAGE` defaults to `build`, the most restrictive default.

The path an edit names is resolved and made relative to the project directory before it is
matched, so `./spec/spec.md`, `spec/../spec/spec.md` and an absolute path inside the project are
all matched as `spec/spec.md`. A path that resolves outside the project is allowed through: a
stage's territory is a statement about the project tree, and agents legitimately write scratch
files elsewhere.

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

`templates/project/.claude/settings.json` is installed as `.claude/settings.json` by `init`, and
sets `permissions.deny` for every agent session running inside a project. Each entry:

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

`sdlc init` creates the machine's egress name list once, at the path the check reads:
`SDLC_EGRESS_NAMES` if that is set, otherwise `<XDG_CONFIG_HOME>/agentic-sdlc/egress-names.txt`,
with `XDG_CONFIG_HOME` defaulting to `~/.config`. Add colleagues' names, one per line. The file is never committed; the egress check fails any tracked file that
contains one of them. `sdlc doctor` warns while the list is missing or empty.

# Stage: `rule`

## Purpose

Record a verdict — `approve` or `return` — on an open proposal, checked against who is allowed to
hold that gate, and merge the proposal into `main` on approval.

## Inputs

`sdlc rule <name> approve|return --by <role or agent:persona> [--note "..."]`, run from inside the
project's working tree.

## Outputs

On the proposal branch:

- `.sdlc/gates/<name>.yaml`: `gate`, `verdict`, `by`, `held_by` (`agent` or `human`, derived from
  whether `by` starts with `agent:`), `note`, `at`.
- An appended `.sdlc/runs/<date>.md` entry.
- One commit, staging those two paths by name and nothing else.

On `verdict: approve` only: the working tree is checked out onto `main` and the proposal branch is
merged in with `--no-ff`, so `main` gains the gate file, the run-record entry, and a merge commit.
Two proposals opened on the same day both append to the same `.sdlc/runs/<date>.md`, which
`.gitattributes` marks `merge=union` so both sets of lines survive. If the merge fails anyway it
is aborted, the working tree is returned to the proposal branch, and the error names the
conflicted files — `main` is never left mid-merge.
On `return`, the proposal branch is left exactly as it is — not merged — so it stays open for
another round.

## Workspace the agent sees

No agent.

## Checks that block

- `verdict` must be `approve` or `return`.
- `--by` is required. It asserts a role and is not authenticated in phase 0: the check is that the
  role named holds the gate, not that the person running the command is that role (see
  `docs/decisions/0003-caller-workflow-and-unauthenticated-roles.md`).
- The working tree must be clean. A gate commit that swept in unrelated edits would make the
  record of a ruling untrustworthy, so `rule` refuses to start and lists the dirty paths.
- The branch `proposal/<name>` must exist.
- `.sdlc/proposals/<name>.md` must exist and its `gate:` front-matter line must be present.
- The project's configuration must load and validate.
- The named gate must exist in `policy.gates`.
- `by` must equal that gate's `holder` or `escalate_to`; anyone else is rejected, and the error
  names who is allowed.

## Exit criterion

Exits 0 and prints `<name>: <verdict> at <gate>`.

## Re-run behaviour

Ruling the same name again overwrites `.sdlc/gates/<name>.yaml` and commits it on the proposal
branch, so a second `approve` does have something to merge: the fresh gate file, followed by
another merge commit on `main`. That is a second ruling on the same proposal, not a no-op, and
the gate log will show both. Treat a proposal as ruled once its verdict is recorded.

## Failure modes

- Bad verdict string, missing `--by`, or no such proposal branch: throws immediately.
- The proposal file is missing its `gate:` line: throws naming the proposal.
- The named gate is not in the project's policy: throws.
- `by` is not a listed holder or escalation target for that gate: throws, naming who is allowed.
- The working tree is dirty: throws before anything is checked out, listing the dirty paths.
- The approval merge conflicts: the merge is aborted, `main` is left as it was, the working tree
  returns to the proposal branch, and the error names the conflicted files.

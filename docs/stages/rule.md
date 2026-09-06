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
- One commit.

On `verdict: approve` only: the working tree is checked out onto `main` and the proposal branch is
merged in with `--no-ff`, so `main` gains the gate file, the run-record entry, and a merge commit.
On `return`, the proposal branch is left exactly as it is — not merged — so it stays open for
another round.

## Workspace the agent sees

No agent.

## Checks that block

- `verdict` must be `approve` or `return`.
- `--by` is required.
- The branch `proposal/<name>` must exist.
- `.sdlc/proposals/<name>.md` must exist and its `gate:` front-matter line must be present.
- The project's configuration must load and validate.
- The named gate must exist in `policy.gates`.
- `by` must equal that gate's `holder` or `escalate_to`; anyone else is rejected, and the error
  names who is allowed.

## Exit criterion

Exits 0 and prints `<name>: <verdict> at <gate>`.

## Re-run behaviour

Ruling the same name again overwrites `.sdlc/gates/<name>.yaml` and appends another commit, but a
second `approve` on a proposal already merged into `main` has nothing left to merge, so treat a
proposal as ruled once its verdict is recorded.

## Failure modes

- Bad verdict string, missing `--by`, or no such proposal branch: throws immediately.
- The proposal file is missing its `gate:` line: throws naming the proposal.
- The named gate is not in the project's policy: throws.
- `by` is not a listed holder or escalation target for that gate: throws, naming who is allowed.

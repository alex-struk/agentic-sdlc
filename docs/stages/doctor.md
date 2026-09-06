# Stage: `doctor`

## Purpose

Check that the local machine and the target project have what the pipeline needs: required and
optional tools, the agent deny list, the egress name list, and a valid configuration.

## Inputs

`sdlc doctor [dir]`, defaulting to the current directory.

## Outputs

To stdout, one line each for:

- `node` and `git` (required), and `gh`, `claude`, `docker` (optional) — found/not-found and
  version.
- Whether `<dir>/.claude/settings.json` has a deny rule starting `Bash(git push`, used as a proxy
  for "the deny list from `sdlc init` is present".
- The egress name list's state (`missing`, `empty`, or `<n> names`) and its path
  (`~/.config/agentic-sdlc/egress-names.txt`).
- The result of `checkConfig(dir)` (see `docs/stages/checks.md`).

## Workspace the agent sees

No agent.

## Checks that block

For the exit code only: `node` and `git` must both be found, and the config check must be `ok`.
The deny-list line, the egress-name-list line, and the optional tools (`gh`, `claude`, `docker`)
are reported but do not affect the exit code.

## Exit criterion

Exits 0 only when node, git and config all check out; otherwise 1. Every line is printed
regardless of the final exit code, so a failing run still shows the full report.

## Re-run behaviour

Read-only and idempotent. Safe to run repeatedly, including immediately after `sdlc init`, since
`doctor` never writes anything itself.

## Failure modes

- `node` or `git` not found on `PATH`: fails the required-tools check.
- `.sdlc/config.yaml` missing or invalid: reported through the config line's message.
- The deny rule is missing from `.claude/settings.json`: reported as a warning suggesting
  `sdlc init` be re-run.
- The egress name list is missing or empty: reported as a warning naming the file to fill in.

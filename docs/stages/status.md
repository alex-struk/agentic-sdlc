# Stage: `status`

## Purpose

Regenerate the generated state site from the project's criteria index, gate log and run log.

## Inputs

`sdlc status [dir]`, defaulting to the current directory. Reads `.sdlc/config.yaml`,
`spec/criteria-index.json` (if present), every `.sdlc/gates/*.yaml`, and every `.sdlc/runs/*.md`.

## Outputs

- `site/index.md`: project name, profile, a generation timestamp, a coverage table counting
  criteria by state (`proposed`, `accepted`, `implemented`, `verified`, `monitored`), and the
  total criteria count.
- `site/gates.md`: one row per gate ruling, newest first, showing when, which proposal, which
  gate, the verdict, who ruled, and whether the ruling was `agent-held, unsampled` or `human`.
- `site/runs.md`: the concatenation of every run-record file, in reverse filename order (most recent day first).

Files are written directly; nothing is committed by this command.

## Workspace the agent sees

No agent.

## Checks that block

None. A missing `spec/criteria-index.json` is treated as zero criteria; a missing
`.sdlc/gates/` or `.sdlc/runs/` directory is treated as no rows, rather than as an error.

## Exit criterion

Exits 0 and prints the three generated file paths.

## Re-run behaviour

Fully idempotent for unchanged inputs: every run overwrites all three files from the current
state on disk, so it is safe — and expected — to call after every checkpoint.

## Failure modes

- `.sdlc/config.yaml` missing or invalid: throws. Unlike the criteria index, gates and runs,
  `status` has no fallback for this file.
- A `spec/criteria-index.json` present but without a top-level `criteria` array: throws when counting criteria.

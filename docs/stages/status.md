# Stage: `status`

## Purpose

Regenerate the generated state site — a readable run record — from the project's criteria
index, journal, gate log, proposals and run log.

## Inputs

`sdlc status [dir]`, defaulting to the current directory. Reads `.sdlc/config.yaml`,
`spec/criteria-index.json` (if present), every `.sdlc/journal/*.md`, every `.sdlc/gates/*.yaml`,
every `.sdlc/proposals/*.md`, and every `.sdlc/runs/*.md`.

## Outputs

- `site/index.md`: project name, profile, a generation timestamp, a coverage table counting
  criteria by state (`proposed`, `accepted`, `implemented`, `verified`, `monitored`), the total
  criteria count, links to the journal, gates and runs pages and to every proposal page, and
  totals: journal cost so far, the number of agent-held rulings, the number of open escalations
  (gate files with `verdict: escalated`), and the number of open proposals (proposal files with
  no gate file yet).
- `site/gates.md`: one row per gate ruling, newest first, showing when, which proposal, which
  gate, the verdict, who ruled, whether the ruling was `agent-held, unsampled` or `human`, and a
  `Sample` column: for each gate, the first `human_sample_per_week` (from that gate's policy
  entry, default 0) agent-held rulings in each ISO week (grouped by `at`) are marked `sample`;
  every other row — including every human ruling — is left blank.
- `site/journal.md`: every journal entry, newest first, as a `## NNN · <stage> · <date>` heading,
  a `cost $<c> · turns <t>` line, then the entry's body.
- `site/proposals/<name>.md`: one page per file in `.sdlc/proposals/`, with the front matter
  rendered as a short table (gate, opened, tier when set, and the gate's holder from policy),
  then the proposal page's own body. A proposal whose page already carries a `## Ruling` section
  (the agent ruling path appends one) needs nothing added; an unruled proposal with no gate file
  yet gets `_Open, waiting for <holder>_`; a gate file with `verdict: escalated` gets
  `_Escalated to <escalate_to>: <rationale>_`.
- `site/runs.md`: the concatenation of every run-record file, in reverse filename order (most recent day first).

`loadConfig` supplies the policy used for gate holders and sampling rates; a config with schema
errors still produces a site, with missing policy treated as empty (no holder, no sampling).

Files are written directly; nothing is committed by this command.

## Workspace the agent sees

No agent.

## Checks that block

None. A missing `spec/criteria-index.json` is treated as zero criteria; a missing
`.sdlc/gates/`, `.sdlc/journal/`, `.sdlc/proposals/` or `.sdlc/runs/` directory is treated as no
rows, rather than as an error.

## Exit criterion

Exits 0 and prints every generated file path (the fixed pages plus one per proposal).

## Re-run behaviour

Fully idempotent for unchanged inputs: every run overwrites every page from the current state on
disk, so it is safe — and expected — to call after every checkpoint.

## Failure modes

- `.sdlc/config.yaml` missing or invalid: throws. Unlike the criteria index, gates and runs,
  `status` has no fallback for this file.
- A `spec/criteria-index.json` present but without a top-level `criteria` array: throws when counting criteria.

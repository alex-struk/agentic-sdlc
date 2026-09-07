# Stage: `status`

## Purpose

Regenerate the generated state site — a readable run record — from the project's criteria
index, journal, gate log, proposals, run log, and blind-test coverage and calibration results.

## Inputs

`sdlc status [dir]`, defaulting to the current directory. Reads `.sdlc/config.yaml`,
`spec/criteria-index.json` (if present), every `.sdlc/journal/*.md`, every `.sdlc/gates/*.yaml`,
every `.sdlc/proposals/*.md`, every `.sdlc/runs/*.md`, `tests/acceptance/<domain>/*.spec.ts`,
`tests/acceptance/not-testable.yaml`, and every `tests/results/<target>/*.json`.

## Outputs

- `site/index.md`: project name, profile, a coverage board, links to the journal, gates and
  runs pages, to every proposal page and to every criteria page, and a totals list:

  The coverage board is one row per domain — columns `proposed`, `accepted`, `implemented`,
  `verified`, `monitored`, `obsolete` (counts by `state`), `open questions` (count of criteria
  with `confidence: open`) and `total` — plus a `Totals` row summing every column. A domain gets
  a row when either `config.project.domains` names it or a criterion in the index does; rows are
  ordered by `config.project.domains` when that list is available, alphabetically otherwise, with
  a domain the config doesn't name sorted after every configured one. A project with no criteria
  at all still renders one zero row per configured domain — the board never collapses to an empty
  table just because nothing has been recovered or authored yet.

  Two more columns follow `total`: `tests` and one column per target directory under
  `tests/results/` (sorted; the header names the target, e.g. `old`, `new`) — a project with no
  `tests/results/` directory yet gets no target columns at all, rather than one rendered blank.

  | Column | What it shows |
  | --- | --- |
  | `tests` | `<covered>/<accepted>` from `coverage(projectDir, domain)`, plus ` (n/t <count>)` when any of the domain's accepted criteria are recorded not-testable. Blank when the domain has neither a `*.spec.ts` file under `tests/acceptance/<domain>/` nor a not-testable entry — a bare `0/0` would misread as "nothing accepted" rather than "coverage not run yet". |
  | `<target>` | `<n> pass · <n> fail · <n> unbound · <n> stale`, counting this domain's rows in `tests/results/<target>/latest.json` (a `not-testable` row is not counted again here — the `tests` column already covers it). Blank when that target has no `latest.json` yet. |

  | Total | What it sums |
  | --- | --- |
  | `Journal cost` | The `cost` front-matter field of every journal entry — what the pipeline's stage turns have cost. |
  | `Rulings cost` | The `cost` field of every gate file — what the persona turns that ruled proposals have cost. |
  | `Total cost` | Those two added together: everything this project has spent on agent turns. |
  | `Agent-held rulings` | Gate files with `held_by: agent` and a verdict other than `escalated`. |
  | `Open escalations` | Gate files with `verdict: escalated`. |
  | `Open proposals` | Proposal files with no gate file yet. |

  There is no generation timestamp on the page. The site is committed by whatever run or ruling
  regenerated it, so git already dates it, and a timestamp would make every rebuild a diff —
  which is exactly what would leave `sdlc status` on an unchanged project with a dirty tree.
- `site/gates.md`: one row per gate ruling, newest first, showing when, which proposal, which
  gate, the verdict, who ruled, whether the ruling was `agent-held, unsampled` or `human`, a
  `Cost` column — what that ruling's own agent turn cost, blank for a human ruling because there
  was no turn to measure, and `$0` for an agent ruling that genuinely cost nothing (a mandatory
  escalation never asks the persona anything) — and a `Sample` column: for each gate, the first `human_sample_per_week` (from that gate's policy
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
- `site/criteria/<domain>.md`: one page per domain that actually has a criterion in
  `spec/criteria-index.json` — a domain the config names but the index doesn't gets a zero row
  on the coverage board but no page here, since there would be nothing to list. The page opens
  with a `## Tests` table, one row per criterion in the domain (in index order): a `test` column
  (the spec file's path relative to `tests/`, e.g. `acceptance/<domain>/<id>.spec.ts`, when
  `coverage` found one; `not testable: <reason>` when the criterion is recorded not-testable
  instead; `—` otherwise) and one column per target directory under `tests/results/` (that
  target's row for this criterion — its `result`, with ` (ruled: <verb>)` appended when the row
  carries a calibration ruling — blank when the target's results have no row for this criterion).
  Below the table, each criterion gets its own section, headed
  `### <id> · v<version> · <confidence> · <state>`, followed by the statement and then whichever
  of these the criterion actually carries: a `given`/`when`/`then` line each, `cites:` entries
  (`path:line`, or bare `path` when the recovery had no line) — present on recovered criteria,
  empty for authored ones — `reconciliation:`, `replaces:` / `superseded-by:`, and one `note:`
  line per note. `site/index.md` links every one of these pages under its own "Criteria" heading,
  in the same domain order as the coverage board.
- `site/runs.md`: the concatenation of every run-record file, in reverse filename order (most recent day first).
- `site/results.md`: one `## <target>` section per target directory under `tests/results/`, each
  with a table of every dated results file in it (`<date>.json`, `<date>-2.json`, …; `latest.json`
  and `applied.yaml` are not rows here — the first duplicates the newest dated file, the second is
  calibration's own bookkeeping) — file name, the run's `at`, and a count per `result` value
  (`pass`, `fail`, `unbound`, `stale`, `not-testable`) — sorted newest `at` first, followed by a
  line naming the open calibration proposal for that target (`followUpState(projectDir,
  "calibrate-<target>")`) or, when none is open, "no calibration ruling open." A project with no
  `tests/results/` directory at all gets a page saying there are no results yet, instead of an
  empty page with no sections.

`loadConfig` supplies the policy used for gate holders and sampling rates; a config with schema
errors still produces a site, with missing policy treated as empty (no holder, no sampling).

Files are written directly; nothing is committed by this command. The site is a tracked artifact
of `main` and of nothing else: a gate-less stage run commits it alongside its own work
(`docs/stages/run.md`), and a ruling regenerates and commits it after a merge
(`docs/stages/rule.md`). A stage that holds a gate deliberately builds no site, because every page
is regenerated whole and two proposals open at once would conflict on all of them.

## Workspace the agent sees

No agent.

## Checks that block

None. A missing `spec/criteria-index.json` is treated as zero criteria; a missing
`.sdlc/gates/`, `.sdlc/journal/`, `.sdlc/proposals/` or `.sdlc/runs/` directory is treated as no
rows, rather than as an error. A missing `tests/results/` directory is treated as no targets (no
board columns beyond `tests`, and `site/results.md` says there are no results yet); a target's
`latest.json` that is missing or does not parse is treated as no results for that target, not an
error.

## Exit criterion

Exits 0 and prints every generated file path (the fixed pages, one per proposal, and one per
domain with a criterion in the index).

## Re-run behaviour

Fully idempotent for unchanged inputs, and byte-for-byte so: every page is a pure function of the
state on disk, with nothing dated or numbered by when the build ran, so a second `sdlc status`
against unchanged inputs rewrites the same bytes and leaves the working tree clean. It is safe —
and expected — to call after every checkpoint.

## Failure modes

- `.sdlc/config.yaml` missing or invalid: throws. Unlike the criteria index, gates and runs,
  `status` has no fallback for this file.
- A `spec/criteria-index.json` present but without a top-level `criteria` array is treated as zero
  criteria, the same as a missing file. A file that is not valid JSON at all throws.

# Stage: `calibrate`

## Purpose

Run the blind acceptance suite against a real, running target — normally the old application, started
as the oracle — and turn the result into one row per criterion. A row that fails is not a defect
report. The tests were written from the criteria alone by an agent that never saw the application
(`docs/stages/derive-tests.md`), and the adapter was bound by walking the running application without
reading its source (`docs/stages/bind-adapter.md`), so a failure is a genuine disagreement between
two independent readings of the same system, and exactly one of three things is wrong: the
application, the criterion, or the test. Only the product owner can say which. So `calibrate` writes
the rows, opens one G1 proposal over every failure nobody has ruled on yet, and applies the answers
mechanically on its next run.

There is no agent turn — `calibrate` carries `agent: false`, the second stage in the registry to do
so after `ratify` — because running a suite and mapping its report onto criteria is deterministic,
and the one judgement in the stage is asked at a gate rather than of an agent.

## Inputs

`sdlc run calibrate [--target <t>]`, run from inside the project's working tree, with the acceptance
suite and the target's adapter already merged onto `main`.

`--target` defaults to `config.oracle.target`, since calibrating the rebuild against the application
it replaces is what the stage exists for. `old` requires `config.oracle` (with `oracle.target: old`);
any other target has to be one `config.targets` configures with a `base_url` — calibrating against
`new` later is legitimate and has no oracle lifecycle of its own.

What it reads:

- `.sdlc/gates/calibrate-<t>-<n>.yaml` — every approved calibration ruling for this target, oldest
  first, so a later ruling's condition on a criterion is applied after (and therefore over) an
  earlier one's. A ruling already recorded in `tests/results/<t>/applied.yaml` is skipped.
- `spec/domains/*.md` — the criteria the rulings name, and where two of the three verbs write.
- `spec/criteria-index.json` — the accepted criteria, their current versions and their
  `generated_from` commit, which the results file records as the spec it ran against.
- `tests/acceptance/` — the suite itself, and `not-testable.yaml`, whose entries become rows with no
  test of their own.

## Outputs

- **`tests/results/<t>/<YYYY-MM-DD>.json`** and **`tests/results/<t>/latest.json`**, the same content
  written twice: the dated file is the record of a particular run, `latest.json` is what everything
  that only wants the current state reads. Each is `{ target, base_url, spec, at, rows }`, where
  `spec` is the criteria index's `generated_from` commit and `rows` is one entry per criterion:

  | field | meaning |
  | --- | --- |
  | `id`, `version` | the criterion, read from the spec file's own provenance header rather than its filename |
  | `domain`, `file` | where the test lives; `file` is null for a `not-testable` row |
  | `result` | `pass`, `fail`, `unbound`, `stale` or `not-testable` |
  | `tests` | one entry per `test()` in the file: title, status, and the failure message where there is one |
  | `ruled` | the verb an applied ruling gave this criterion, present only when one has been |

  `unbound` is a failure whose every message begins `unbound:` — the adapter says the surface member
  it needed does not exist on this target, which is a gap in the binding rather than a difference in
  behaviour. `stale` is a test whose header version trails the index, so it was written against a
  criterion that has since moved on and its result says nothing about the target.

- **`tests/results/<t>/applied.yaml`** — `{ applied: [<gate file names>], rulings: [{ id, version,
  verb, gate }] }`. The first list is what makes the stage re-run safe: a ruling whose name is on it
  is never applied a second time. The second is what puts `ruled` on a row, and it records the
  version the criterion carried *after* the ruling was applied, so a criterion later moved on again
  — by another calibration pass, or by re-running archaeology — comes back unruled and is asked
  about afresh rather than resting on an answer given about a different statement.

- **`spec/domains/<d>.md`**, rewritten through the same serialiser `ratify` uses (preamble and all)
  when a ruling changed something in it: `defect-in-old` appends a note, `spec-wrong` replaces the
  statement and bumps the version. Confidence is untouched by every verb — a failing test says
  nothing about the strength of the evidence a criterion was recovered from.

- **`tests/acceptance/redo.yaml`** — `{ redo: [{ id, why }] }`, appended by `test-wrong`. It is the
  list `derive-tests --stale` reads to know a criterion needs its test written again even though the
  criterion itself has not moved. An id already on it is left as it is; nothing here ever removes an
  entry.

- **`spec/criteria-index.json`** and **`spec/spec.md`**, regenerated whenever a ruling changed a
  domain file. This happens *before* the suite runs, not after: staleness is the comparison between a
  criterion's version in the index and the version written in its test's own header, so an index
  regenerated afterwards would report this run's own edits as passes or failures for one more run
  before the tests they invalidated were ever marked stale.

- A journal entry and a run-record line. The journal states how the suite came out (counts by
  result), which criteria are failing with no ruling, which rows carry one, what the last ruling
  actually did, and any condition naming an id the project does not have.

- No gate of its own: the ruling `calibrate` acts on is asked by its follow-up, so a successful run
  commits straight to `main` as `stage(calibrate): calibrate against <t>`.

- A G1 proposal, `proposal/calibrate-<t>-<n>`, whenever a row failed with no ruling — see "The
  ruling loop".

## Workspace the agent sees

None. `agent: false` tells `runStage` to skip materialising a workspace and spawning an agent turn
entirely and call `stage.execute(projectDir, ctx)` in-process instead, in the project's own working
tree. `execute` is awaited — unlike `ratify`'s, it is asynchronous, because it has to start the
oracle and run a suite before it has anything to report — and its return (`{ text, changed }`) stands
in for an agent's own result the same way `runStage` synthesises the rest of one (`cost: 0`, `turns:
0`, `sessionId: "deterministic"`).

The `implement-guard` hook gives `calibrate` the same empty territory it gives `ratify`: a session
running under `SDLC_STAGE=calibrate` may write nothing at all. What the stage writes, it writes from
the runner's own process, never through a tool call.

## What `execute` does, in order

1. **Point at the target.** For `old`, `sdlc oracle up` runs first (`oracleUp`, exported from
   `src/commands/oracle.mjs`) — it is idempotent, so this is a no-op against an oracle already up and
   the way it gets started when it is not — and the base URL and mail API come from the local file it
   writes (`.sdlc/oracle-old.local.yaml`). Under `SDLC_ORACLE=mock` nothing is started; the local
   file is read if it exists and `http://mock` stands in when it does not. Any other target's base
   URL is whatever its own `config.targets` entry names, with no mail catcher of its own.
2. **Apply the rulings that came back.** Every approved `calibrate-<t>-<n>` gate file not already in
   `applied.yaml`, in order, applied across every domain file (`applyCalibrateRulings`,
   `src/spec/criteria.mjs`). Each domain file is read once, offered the whole condition list, and
   written back only if something in it actually changed.
3. **Regenerate the index and the spec page** if step 2 changed a domain file — before the suite,
   for the staleness reason above.
4. **Run the suite** (`runSuite`, `src/testrun/playwright.mjs`): the harness's dependencies and
   browser are installed if missing, Playwright runs with `SDLC_TARGET`, `SDLC_TARGET_URL` and
   `SDLC_MAIL_API` set, and its JSON report is mapped onto rows. `SDLC_TEST_RUNNER=mock` reads canned
   rows from `<SDLC_MOCK_DIR>/calibrate.json` instead, for a caller with no browser in reach.
5. **Write the result set**, marking each row `ruled` where an applied ruling covers that id at its
   current version.
6. **Return the summary and every path written.**

## Checks that block

- **Pre-check.** `calibrate-target-option` — a target is resolved (given, or defaulted from
  `config.oracle.target`), and it is either `old` with `config.oracle` configured, or a name in
  `config.targets` carrying a `base_url`.
- **Post-checks**, run against the working tree after `execute` returns:
  - `calibrate-results` — `tests/results/<t>/latest.json` exists, parses, and has one row for every
    accepted criterion of every domain that has at least one test file. A domain nobody has derived
    tests for yet is not this run's business; once a domain has any test at all, a criterion of it
    missing from the results is a criterion nothing ran and nothing reported.
  - `calibrate-fails-answerable` — no row failed without a criterion id to rule on. A ruling names a
    criterion by id and the follow-up page asks about it by id, so a failing row with no id (a spec
    file whose provenance header did not parse, leaving nothing to say which criterion it belongs to)
    could never be answered and would sit in the results as a permanent unanswerable failure.
  - `checkTests` — the same structural check `sdlc checks` runs over the suite: every spec file's
    header names a real accepted criterion, the filename matches it, and a `blind` claim is backed by
    the commit that wrote the file.

## Exit criterion

The stage's own exit condition is the one in the design spec: **no row is `fail` without a ruling**.
That is reached over runs rather than within one — a run that finds unruled failures still exits 0,
having written the results and opened the proposal that asks about them. The loop is closed when a
run finds every failure ruled and opens nothing.

Any pre-check or post-check failure exits 1 and prints the failing check's messages;
`stage(calibrate): post-checks failed` is committed with only the journal and run record staged, and
whatever `execute` wrote is left in the working tree to inspect.

## The ruling loop

Once the calibration commit has landed on `main`, `calibrate` opens a G1 proposal named
`calibrate-<t>-<n>` (`n` continuing past any calibration proposal already ruled or open) whenever a
row failed with no ruling. Its page lists exactly those criteria: the statement as the spec holds it,
the criterion's given/when/then, the test file, and every failing test's title, status and failure
message trimmed to twenty lines — enough to tell a real behavioural difference from a broken test
without opening the report. It closes with the calibration grammar, which is the whole vocabulary the
answer may use:

- `defect-in-old <ID>` — the old application really does fail this and the criterion is right anyway.
  The test stands as written and the rebuild has to pass it; the criterion keeps a note saying the old
  target fails it. This is the ruling that turns a known defect into a requirement instead of letting
  the old behaviour define the new system.
- `spec-wrong <ID>: <corrected statement>` — the criterion misdescribes what the application does.
  The statement is replaced and the version bumped, which marks the test stale so `derive-tests
  --stale` writes it again from the corrected criterion.
- `test-wrong <ID>: <why>` — the criterion is right and the test is not. The id goes to
  `redo.yaml` for `derive-tests` to redo, still blind, so `<why>` has to say what the test got wrong
  without describing how the application is built.

`sdlc rule` reads these in the calibration grammar rather than the ratification one, selected by the
proposal's name (`docs/stages/rule.md`, "Calibration conditions"), and re-prompts the persona once
for any line it cannot read.

At most one calibration proposal is open per target at a time: while `calibrate-<t>-<n>` is unruled
it is the question the stage is waiting on, and a second would ask it twice. A run that finds
failures while one is open says so in its own summary rather than opening nothing silently.

## Re-run behaviour

Re-running is safe and is the ordinary way the stage is used: rule the proposal, run again, and the
answers are applied. Two things make that safe.

- **A ruling is applied exactly once.** `applied.yaml` records the gate file's name the first time
  its conditions are applied, and every later run skips it. Independently of that, each verb is
  idempotent against a row it has already changed — the note is appended only when the row does not
  already carry one saying the same thing, and `spec-wrong` bumps the version only when the statement
  actually differs — so neither route can double-apply a ruling.
- **A returned or escalated ruling is neither applied nor recorded**, so the ruling that eventually
  replaces it is still read.

Unlike `ratify`, `calibrate` never reports itself as a no-op: every run writes a result set, and the
dated file plus `latest.json` are a fresh record of a fresh run even when the rows are identical to
last time's. That is the point of the file — it is evidence of what the target did today, not a
derived artifact that should be stable.

## Failure modes

- **No target resolves** (no `--target`, no `config.oracle.target`), or the named target is neither
  `old` with an oracle configured nor a `config.targets` entry with a `base_url`: the pre-check fails
  before anything is started or written.
- **The oracle will not start**: `oracleUp` throws with the exit code's own reason (no compose file,
  no Docker Compose on the machine, a service that never answered), and nothing is written.
- **The suite produces no report**: `runSuite` throws naming the missing
  `tests/test-results/results.json` and the run's stderr — a Playwright invocation that failed before
  it could write one. Any ruling this run had already applied is left in the working tree, so the
  tree needs committing or resetting before the next `sdlc run` (which requires a clean one).
- **A condition names an id the project does not have**: reported in the run's own summary as a
  condition naming nothing this project has, and the ruling is still recorded as applied. One dead
  line must not block every other line in the same ruling.
- **A ruling carries `unparsed_conditions`**: those lines are reported the same way, since the
  persona was already asked to restate them once and the ruling's verdict still stands.
- **A criterion fails and nothing rules on it**: the run succeeds, the proposal opens, and the same
  failure is reported again on every run until it is answered. Nothing in the pipeline treats an
  unanswered failure as a pass.

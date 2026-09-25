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

`--domain <d>` narrows the run to that domain's specs. A whole-suite calibration takes hours on a
real project, which makes checking one fix an afternoon; scoped, it is minutes. The rows it
produces are laid over the ones already on file, so `latest.json` stays a complete account of every
criterion rather than becoming a partial one — which is also why it refuses to run before a full
calibration has happened at least once. A row nobody re-ran says what it said last time, and the
dated file beside it records when that was.

## Outputs

- **`tests/results/<t>/<YYYY-MM-DD>.json`** and **`tests/results/<t>/latest.json`**, the same content
  written twice: the dated file is the record of a particular run, `latest.json` is what everything
  that only wants the current state reads. A second run on a day that already has a record writes
  `<YYYY-MM-DD>-2.json`, a third `-3.json`, and so on — each run against a live target is its own
  evidence of what that target did, not a correction of the last one, so no dated file is ever
  rewritten. `latest.json` is the one that is meant to be overwritten, and it is, every run.

  Each file is `{ target, base_url, spec, at, rows }`, where `base_url` is the target's **configured**
  URL (`config.oracle.base_url` for `old`, `config.targets.<t>.base_url` otherwise) rather than the
  one this run actually pointed at — `oracle up` binds whatever port was free on the machine it ran
  on, and a committed file recording that would be one laptop's accident in shared history. `spec` is
  the criteria index's `generated_from` commit, and `rows` is one entry per criterion:

  | field | meaning |
  | --- | --- |
  | `id`, `version` | the criterion, read from the spec file's own provenance header rather than its filename |
  | `domain`, `file` | where the test lives; `file` is null for a `not-testable` row |
  | `result` | `pass`, `fail`, `unbound`, `stale`, `not-testable` or `attested` |
  | `reason` | why the application was never asked about this criterion, on a `not-testable` or `attested` row — the entry's own text, carried onto the row because the file it was written in is the only place it exists |
  | `tests` | one entry per `test()` in the file: title, status, and the failure message where there is one |
  | `ruled` | the verb an applied ruling gave this criterion, present only when one has been |
  | `error` | why the row is `fail` when no individual test in it carries a failure message of its own — present only then. `no result recorded` (every test in the file was skipped, or it ran none); `<path>: spec file not found on disk` (the suite's own report names the file but it is missing from disk); or the provenance header's own parse error (the header could not be read at all). The last two also leave `id` and `version` null, since neither the filename nor a missing header can say which criterion the row is for. |

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

  Two kinds of domain file are never written at all. One no condition named is left exactly as it is,
  byte for byte: serialising rewrites a file into the canonical format, and a domain still in the
  shape an agent wrote it — recovered, awaiting ratification — would be silently reformatted by a
  pass it had nothing to do with. One that **does not parse** is also left alone, and this matters
  more: the parser returns the criteria it could read and reports the rest as errors, so writing that
  back would delete the blocks it could not read. The run reports `spec/domains/<d>.md does not parse;
  <n> condition(s) not applied` instead, and does not record the ruling those conditions came from as
  applied, so the next run — once the file is fixed — reads it again.

- **`tests/adapters/rebind.yaml`** — `{ rebind: [{ id, target, why, closed? }] }`, owed work of kind
  `rebind` (`src/spec/owed.mjs`), appended by the reviewer's `adapter-wrong` triage verdicts. The next
  `bind-adapter` run for that target reads its own open entries into its prompt. `calibrate` closes
  them once it runs against an adapter that has changed since they were written, and a closed entry
  stays on file, so a finding made again about the new adapter counts as a second send of the same
  binding (`policy.loops.rebind`). Keyed by target as well as by criterion, because an adapter exists
  per target and a finding about one says nothing about another's.

- **`tests/acceptance/redo.yaml`** — `{ redo: [{ id, version, why, closed? }] }`, owed work of kind
  `redo` (`src/spec/owed.mjs`), appended by `test-wrong`. It is the list `derive-tests --stale` reads
  to know a criterion needs its test written again even though the criterion itself has not moved;
  `version` is the version the criterion carried when the ruling was made. An id already open on the
  list is left as it is, so the first reason recorded is the one somebody wrote about. `derive-tests`
  closes the entries for the ids it has just derived — a request that has been answered must not send
  the same id back through `--stale` forever (`docs/stages/derive-tests.md`) — and a closed entry stays
  on file, so a later `test-wrong` on the same criterion counts as a second send
  (`policy.loops.redo`).

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
   writes (`.sdlc/oracle-old.local.yaml`). Its run-record line is written with this stage's own, not
   committed on its own mid-stage (`docs/stages/oracle.md`). Under `SDLC_ORACLE=mock` nothing is started; the local
   file is read if it exists and `http://mock` stands in when it does not. Any other target's base
   URL is whatever its own `config.targets` entry names, with no mail catcher of its own.
2. **Apply the rulings that came back.** Every approved `calibrate-<t>-<n>` gate file not already in
   `applied.yaml`, in order, applied across every domain file (`applyCalibrateRulings`,
   `src/spec/criteria.mjs`). Each domain file is read once, offered the whole condition list, and
   written back only if something in it actually changed.
3. **Regenerate the index and the spec page** if step 2 changed a domain file — before the suite,
   for the staleness reason above — and commit steps 2 and 3 together as
   `stage(calibrate): apply rulings <gate names>`, staging exactly the paths they wrote. The suite
   in step 4 can throw for reasons that have nothing to do with those edits (no browser, no npm
   registry, the target gone mid-run), and a throw leaves whatever is in the working tree behind:
   committing first means a failure leaves a clean tree with the applied rulings safe, and the next
   run reads `applied.yaml` and applies nothing twice. A pass that wrote nothing commits nothing.
4. **Run the suite** (`runSuite`, `src/testrun/playwright.mjs`): the harness's dependencies and
   browser are installed if missing, Playwright runs with `SDLC_TARGET`, `SDLC_TARGET_URL` and
   `SDLC_MAIL_API` set, and its JSON report is mapped onto rows. `SDLC_TEST_RUNNER=mock` reads canned
   rows from `<SDLC_MOCK_DIR>/calibrate.json` instead, for a caller with no browser in reach.

   **A target that was not usable halts the run here.** A row whose failing test reports that the
   harness could not reset the target to its seed, or that the browser could not connect to it
   (`ENVIRONMENT_FAULT_RE`, `src/testrun/results.mjs`), says what the machine did, not the
   application. When more such rows come back than `policy.calibrate.environment_faults` allows
   (none by default), the run writes no result set, opens no proposal and closes no owed work. It
   commits one run-record line, `calibrate <t>: halted, environment fault — …`, and exits 1 with
   the evidence: how many of the rows that ran were affected, what their tests said grouped by
   message with a count of tests each, and which criteria. This is the design spec's `env-defect`
   route (§7.1): the runner halts and reports, and a person decides what to fix
   (`docs/decisions/0056-a-calibration-that-measured-the-machine.md`). Under `--skip-suite` the
   same check runs over the rows on file, so results a broken run left behind are never asked
   about either.

5. **Write the result set** — this run's own dated file (`<date>.json`, or `<date>-<n>.json` when the
   day already has one) and `latest.json` — marking each row `ruled` where an applied ruling covers
   that id at its current version.
   Each row that names a spec file carries `file_sha`, git's object id for that file as the suite
   ran it, and a row carried over from an earlier run keeps its own.
   Then the missing tests (`docs/operating-model.md` §7): an open item whose test these rows show
   ran at the criterion's current version — `pass` or `fail`, from the spec file as it now stands,
   not ruled `test-wrong` or `spec-wrong`, and not a failure whose test never reached the target
   (step 4's environment fault, kept when the run is within the threshold) — is closed as met, the row cited as its evidence
   (`tests/results/<t>/latest.json: <id> v<n> <result>`) and the file's id recorded, and one whose
   test exists and has not run is owed by `calibrate` for this target. `.sdlc/owed.yaml` is committed
   with the result set.
6. **Return the summary and every path written.**

## Checks that block

- **Pre-checks.**
  - `calibrate-target-option` — a target is resolved (given, or defaulted from
    `config.oracle.target`), and it is either `old` with `config.oracle` configured, or a name in
    `config.targets` carrying a `base_url`.
  - `calibrate-sandbox-password` — a target whose identity is `sandbox-idp` needs
    `SDLC_SANDBOX_PASSWORD` in the environment: without it the suite signs in with an empty
    password, is refused, and every row comes back a failure that says nothing about the work.
    The message names the variable and never a value (`export SDLC_SANDBOX_PASSWORD before
    calibrating <target>`).
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
whatever `execute` wrote after the ruling commit — the result set — is left in the working tree to
inspect. The applied rulings themselves are already on `main` under their own commit, so no failure
here can lose them or leave the spec half-rewritten.

## The ruling loop

Once the calibration commit has landed on `main`, `calibrate` opens a G1 proposal named
`calibrate-<t>-<n>` (`n` continuing past any calibration proposal already ruled or open) whenever a
row failed with no ruling. Its page lists at most 40 of them — a calibration against an application
nobody has rebuilt yet can fail hundreds of criteria at once, and a page that long is neither
readable nor rulable in one sitting, so the page says how many more there are and the rest come back
on the next run's proposal. For each one it carries the statement as the spec holds it,
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

Every failure on the product owner's page has already been sorted by the reviewer — see "Sorting
the failures first" below — so these three verbs are only ever asked of a question about the product.

## Sorting the failures first

A failing test can be the application's fault, the criterion's, the test's, or the project's own
adapter's. The last is a technical question with a right answer in the adapter's code, and it is not
the product owner's to answer (`docs/decisions/0008-adapter-wrong.md`). So the failures go to two
personas in turn:

1. A failure whose every failing test ended in the adapter's own `unbound:` error is recorded as
   `unbound`, not `fail`, and reaches neither.
2. Every other failure is first put to the reviewer at G3, as `calibrate-triage-<target>-<n>`, in
   the triage grammar: `adapter-wrong <ID>: <why>` or `product-question <ID>`. Nothing goes to the
   product owner while any failure is unsorted or a sorting is still waiting on its ruling.
3. Once every failure is sorted, the ones passed on as `product-question` go to the product owner at
   G1, as `calibrate-<target>-<n>`, in the three verbs above.

An `adapter-wrong` verdict changes no criterion. It takes its row out of both queues, puts the
criterion on `tests/adapters/rebind.yaml` for the next `bind-adapter` run, and records which version
of the adapter it was about. It lapses — row back to an open question, rebind entry closed — once a
calibration runs against an adapter that has changed since.

`--skip-suite` applies whatever rulings have come back and asks the next question over the rows
already on file, without running anything. Sorting and ruling are two rulings in a row with no change
to the application between them, so the usual sequence is: `calibrate`, rule the triage proposal,
`calibrate --skip-suite`, rule the product owner's proposal. It writes `latest.json` only, never a
dated file, because a dated file is the record of a suite having run.

`sdlc rule` reads these in the calibration grammar rather than the ratification one, selected by the
proposal's name (`docs/stages/rule.md`, "Calibration conditions"), and re-prompts the persona once
for any line it cannot read.

At most one calibration proposal is open per target at a time: while `calibrate-<t>-<n>` is unruled
it is the question the stage is waiting on, and a second would ask it twice. A run that finds
failures while one is open says so in its own summary rather than opening nothing silently.

A calibration proposal whose rows should never have been asked about, such as one opened over rows
that a target which was not usable produced, is set aside with `sdlc withdraw <name> --by <seat>
--reason "<why>"` (`docs/stages/withdraw.md`), which closes it without an answer on any row. The
next run then asks afresh, so the rows it asks about must be sound: run the full calibration, not
`--skip-suite` over the rows the broken run left on file.

A proposal the persona **escalated** is unruled: escalation hands the question to `escalate_to` and
answers nothing, so the gate file it leaves on the branch does not close the proposal. The stage
keeps waiting on it rather than opening `-2` and `-3` on every run while a person still owes the
answer.

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
derived artifact that should be stable. Two runs on the same day therefore leave two dated files,
not one.

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
  condition that was not applied, and the ruling is still recorded as applied. One dead line must not
  block every other line in the same ruling.
- **A domain file does not parse**: that file is not written, the conditions naming criteria in it
  are reported unapplied, and the ruling carrying them is not recorded as applied — so fixing the
  file and running again applies them. Conditions in the same ruling aimed at other domains still
  land.
- **A ruling carries `unparsed_conditions`**: those lines are reported the same way, since the
  persona was already asked to restate them once and the ruling's verdict still stands.
- **The target could not be reset or reached** for more rows than
  `policy.calibrate.environment_faults` allows: the run halts after the suite, as described in step
  4 of "What `execute` does". Nothing is recorded against a criterion and nothing is asked. Rulings
  applied in step 2 are already committed. The halt's run-record line is committed with the
  pipeline's identity, so the tree is clean for the run that follows the fix.
- **A criterion fails and nothing rules on it**: the run succeeds, the proposal opens, and the same
  failure is reported again on every run until it is answered. Nothing in the pipeline treats an
  unanswered failure as a pass.

# Stage: `next`

## Purpose

Name the next command to run, and the rule of the record that chose it, by reading the project's
recorded state on `main`. It also lists what else is ready and what is waiting on a person. The
operator types the command, or `sdlc drive` runs it and reads `next` again until it stops at a
person, a failure or a dead end (`docs/stages/drive.md`); either way `next` decides which one.

## Inputs

`sdlc next [dir] [--json]`, where `dir` defaults to the current directory.

Everything is read from `main` through git objects (`git show`, `git cat-file`, `git ls-tree`,
`git grep` against the `main` commit), never from the working tree. The answer is the same
whichever branch is checked out and whatever is uncommitted.

| Read from `main` | What it contributes |
|---|---|
| `.sdlc/config.yaml` | the profile's stages, the domains in order, the oracle target, the gate seats, `policy.next.order`, `policy.next.calibrate_after`, `policy.calibrate.scope` and `full_every` |
| first-parent history of `main` since the oracle's suite last ran | with `policy.next.calibrate_after` set, the approved proposals merged since whose merge changes what calibration measures |
| `.sdlc/gates/*.yaml` | which proposals have been ruled, and which lines of work are approved |
| every `proposal/*` and `returned/*` branch, with its proposal page and gate file | open proposals, escalations and returns, and which proposal in a line of work is the newest |
| the owed-work lists (`src/spec/owed.mjs`) | open conditions, requests, redos, rebinds, recoveries and any other kind; every rebind entry, closed ones too, counts a binding's sends |
| `spec/criteria-index.json`, `spec/domains/<d>.md` | whether a domain is ratified, and each criterion's current version |
| `tests/acceptance/<d>/*.spec.ts` headers | stale tests: a header version below the index's |
| `tests/results/<t>/latest.json`, `applied.yaml`, `tests/adapters/<t>` | whether calibration is clean, whether any row was carried from an earlier run, how many scoped calibrations have followed the last full one, the unbound rows, and whether an adapter has changed since a rebind was filed or an unbound row was found |
| `spec/contract/personas.yaml` | the personas the contract marks unavailable on each target's identity, whose unbound rows are owed to no binding run |
| `spec/contract/surface.yaml`, `tests/adapters/<t>/bindings.yaml` | stale adapters: members the contract declares that a target's bindings do not name, or names they carry that it no longer declares |
| `plan/tasks.md` | the slices, in build order |

## What it decides

Ready work comes in three kinds. The record orders the work inside each kind; which kind is taken
first when more than one is ready is `policy.next.order` (`docs/config.md`), `proposals`, `owed`,
`sequence` by default.

| Kind | What is ready | Order within the kind |
|---|---|---|
| `proposals` | an open proposal whose holder is an agent (`sdlc rule <name> --by agent:<persona>`); an escalation to a role an agent plays, raised by someone else (`--by agent:<target>`); a build proposal with no verify result for the application it carries (`sdlc run verify --slice <n>`) | oldest proposal branch first |
| `owed` | a returned proposal (`--revise` for a stage that has it, otherwise the stage run again), unless it is held (below); open requests (`--revise` for a stage that has it, otherwise the stage run again: `sdlc run contract`); redo entries and stale tests (`derive-tests --domain <d> --stale`, not offered while that domain's test proposal is returned, since its `--revise` takes up the entries its own line's rulings filed); rebind entries and unbound rows (`bind-adapter --target <t>`, or `calibrate --target <t>` once the adapter has changed since the entry was filed or the row was found); stale adapters (`bind-adapter --target <t>`, one run with that target's rebinds); recovery entries (`archaeology --domain <d> --revise`); missing tests (`derive-tests --domain <d> --stale` when the writer owes one, `calibrate --target <t>` when one is owed a run, otherwise the owing stage, with `--domain` where it takes one); any other kind, by its owing stage | upstream stage first, then the configured domain order, then target (the oracle's first), then slice; a contract run for owed work waits for the test writer (below) |
| `sequence` | the next stage the phases call for | the first phase whose exit criterion is not met; within it, the sequence's order |

A condition is owed and listed, and is never a reason to start a run
(`docs/decisions/0032-an-instruction-nobody-had-to-account-for.md`). A missing test owed a run by
`verify` is counted and not offered either: its slice is verified by the build sequence. A missing
test its owner was handed and kept at an approval, or owed by a stage with no agent turn to be
handed it (`ratify`), has no run that answers it: it is listed under `waiting on a person` as
waiting on a ruler, grouped by owing stage, with the withdrawal line and, for a kept item, the
deviation that runs the owner again.

**Held.** A returned proposal whose own ruling also filed a request addressed to another stage
(`addressed-to <stage>: <why>`) is not offered while that request is open, nor once it is taken
while the proposal that took it up has no approval on `main` — an approval of that proposal, or
of a later one in its line of work (`contract-v3` answers for `contract-v2`), releases it. The
revision would otherwise be built on the artifact the ruling said has to change. The request
itself is offered as owed work, so `next` names the addressed stage's run first, then that
proposal's ruling, then the revision. Held revisions are listed under `held:` with the reason. A
request addressed to the returned proposal's own stage holds nothing: the revision answers it. A
request taken before the proposal that took it was recorded (`taken_by`) names none, and is read
as answered (`docs/decisions/0050-a-request-reaches-a-stage-that-takes-it-up.md`).

**Contract waits for the test writer.** What `contract` owes in the Tests phase is mostly filed by
the rulings of `derive-tests` proposals, one domain at a time. The contract run that answers owed
work (not a return of contract's own proposal) is held while the test writer has ready work that
does not rest on contract: a `derive-tests` run, owed or in the sequence, in a domain contract owes
nothing, or a ruling of a `derive-tests` proposal an agent can make now. A domain contract owes is
one with an open missing test contract owes and has not kept, or a request to contract from that
domain's line of work. While contract is held, the test writer's runs in the domains it owes are
held behind it, since each would be run again once contract answers. Both are listed under `held:`
with the reason. When no such work is left, `next` names the contract run, and that one run is
handed every domain's needs. Work that rests on contract never holds it, so contract is held only
while something else can run, whatever `policy.next.order` says
(`docs/decisions/0069-contract-waits-for-the-test-writer.md`).

**An adapter is ruled before it is measured with.** A verify runs a slice's tests against the new
target through the adapter on `main`, and a calibration runs the suite against its target through
that target's adapter on `main`. While a `bind-adapter-<t>-*` proposal is open, every ready item
that measures with `t`'s adapter — `sdlc run verify --slice <n>` for the new target, and `sdlc run
calibrate --target <t>` however it came to be offered — comes after that proposal's ruling. Where
an agent can rule it now, the ruling is moved to just ahead of the first such item, whatever kind
either is, and its `rule` names the step it goes before; everything else keeps its place. Where
it waits on a person, each such item is listed under `held:` with the proposal it waits for, and
is offered again once that proposal is ruled. An open adapter proposal for one target holds
nothing that measures with another
(`docs/decisions/0079-an-adapter-is-ruled-before-it-is-measured-with.md`).

**A calibration cadence.** With `policy.next.calibrate_after: <n>` set (`docs/config.md`), a
calibration of the oracle's target falls due once `n` approved proposals that change what it
measures have merged into `main` since its suite last ran. A proposal counts when the merge that
approved it changes `tests/acceptance/`, `tests/adapters/<oracle>/`, `spec/contract/`, the oracle's
`seed` or its Compose override; the suite last ran at the newest first-parent commit that added a
dated result file under `tests/results/<oracle>/`, which a `--skip-suite` run does not write. A due
calibration is offered as `sdlc run calibrate --target <oracle>`, of kind `calibration`, before
every owed and sequence item, and replaces any other offer of the same calibration; proposals keep
the place `policy.next.order` gives them, so with the default order an open proposal an agent can
rule still comes first. Its `why` names the proposals that made it due. Nothing is due before the
first calibration, which the sequence brings, or while a calibration or triage proposal for the
oracle is open. Unset, nothing changes (`docs/decisions/0070-a-calibration-cadence.md`).

**A full calibration.** Under `policy.calibrate.scope: changed` a calibration carries the rows
none of whose inputs changed, marked `carried` in `latest.json`. Two things make `next` name
`sdlc run calibrate --target <t> --full` instead. Every row passing or ruled with some of them
carried does not close the Tests phase, because only a run that measured every row says a
passing test still passes under the adapter the target has now; the sequence step is offered
with `--full` and a `why` naming the runs the carried rows came from. And with
`policy.calibrate.full_every: <n>` set, once `n - 1` scoped calibrations have followed the last
full one, every offer of that target's calibration that runs the suite carries `--full`, its
`why` ending `a full run is due: …`. The same happens, once, when no row on file records the
inputs it ran with: the first calibration after a project chooses `scope: changed` is full
(`docs/decisions/0072-a-calibration-re-runs-what-changed.md`).

**Missing tests.** An untestable record on `main` is owed a test whether or not an entry has been
written for it yet (`docs/operating-model.md` §7): `next` reads the entries in `.sdlc/owed.yaml`
and, beside them, an item for each record nothing accounts for, owed by the stage the record names
or by `contract`. The `owed:` line counts them by owing stage (`69 missing-test (contract)`). One
owed a run by calibration, for a criterion whose row needs a persona the approved contract marks
unavailable on the target, is not offered to `calibrate`, since no run there can pass or fail it:
it is listed under `waiting on a person` as waiting on a ruler, one line per target naming the
criteria, and `condition-withdrawn missing-test/<id>: <why>` on any ruling closes it.

**Unbound rows.** A calibration row the adapter reported unbound is owed to `bind-adapter` for
its target, whether or not an entry has been written for it yet: `next` reads the rebind entries
and, beside them, an item for each open unbound row nothing accounts for, and counts both on the
`owed:` line as `rebind (bind-adapter)`. A row found under an adapter other than the target's
current one is offered to `calibrate --target <t>` to be looked at again. A row whose every
failing test stopped at signing in as a persona the contract on `main` marks unavailable on the
target is owed to nobody: calibration closes it as `persona-unavailable`. A row whose binding has
been sent to `bind-adapter` as often as `policy.loops.rebind` allows, counting the reviewer's
rebind entries for the same criterion, is not offered to `bind-adapter` again. On the oracle's
target it goes to the reviewer's calibration triage, where `oracle-cannot`, `adapter-wrong` or
`product-question` answers it. When such rows, and rows needing an unavailable persona, are all
that keep the oracle's calibration open, the sequence offers `calibrate --target <oracle>
--skip-suite`, since the suite would only report them unbound again, and says which rows and why;
that run opens the triage or closes the rows, and while the triage proposal is open they are its
question. On any other target a spent row is listed under `waiting on a person` as waiting on a
ruler, one line per target naming the criteria
(`docs/decisions/0067-an-unbound-row-is-owed-to-its-binding.md`,
`docs/decisions/0068-an-unbound-row-the-binding-cannot-close.md`).

**Stale adapters.** A target's adapter is stale when its `bindings.yaml` on `main` disagrees with
the surface on `main` by name, the comparison the bind-adapter post-check makes. The oracle's is
offered as owed work at once; any other target's is offered once the phases before Build are
closed, because its application exists only on a build proposal until then, and until that point
it is listed on the `stale adapters` line with the phase it waits for. A target that already has
a run for its rebinds is offered one run for both. Nothing is stored: the approval that brings
the adapter up to date clears it
(`docs/decisions/0049-an-adapter-the-contract-has-outgrown.md`).

**Proposals.** A proposal is open when nobody has ruled it, on its branch or on `main` — the same
test `rule --pending` and the revise pre-checks use. A proposal is left out when a later proposal
in the same line of work exists (`build-slice-1-3` replaces `build-slice-1-2`; `contract-v3`
replaces `contract-v2`), since what it asked has been asked again.

**The sequence.** Each step is closed by what the record says, not by a run having happened:

| Phase | Step | Closed when |
|---|---|---|
| 1 Spec | `intent` | an `intent-*` proposal is approved |
| | `archaeology --domain <d>` | the `archaeology-<d>` line of work has an approval |
| | `ratify --domain <d>` | the index has accepted criteria for the domain, none of its rows is still provisional, and every criterion in `spec/domains/<d>.md` is in the index |
| 2 Tests | `contract` | a `contract-v<n>` proposal is approved |
| | `bind-adapter --target <oracle>` | the `bind-adapter-<oracle>` line of work has an approval |
| | `derive-tests --domain <d>` | the `derive-tests-<d>` line of work has an approval |
| | `calibrate --target <oracle>` | every row of `tests/results/<oracle>/latest.json` is `pass`, `not-testable` or `attested`, or carries a ruling, and no row is `carried` from an earlier run; an `unbound` row stays open until a binding reaches its test, calibration closes it as `persona-unavailable`, or the reviewer's triage rules it. Offered with `--skip-suite` when only such unbound rows keep it open, and with `--full` when only carried rows do |
| 3 Design | `design --domain <d>` | the `design-<d>` line of work has an approval |
| 4 Build | `plan` | the `plan` line of work has an approval |
| | `build --slice <n>` | the `build-slice-<n>` line of work has an approval at G3 |
| 5 Operate | `deploy`, `operate` | not implemented |

A step is offered only when every step of an earlier phase is closed, and when the steps it
depends on inside its phase are closed: archaeology after intent, ratify after that domain's
archaeology, everything in phase 2 after the contract, calibration after the binding and every
domain's tests, the first slice after the plan and each slice after the one before it. A step
whose stage and subject already have a proposal in flight is not offered; the proposal is. Steps
are filtered by the profile: `bind-adapter` and `calibrate` for the oracle appear only where the
profile runs `calibrate` and the config names `oracle.target`, and `ratify` only where it runs
`archaeology`.

**Waiting on a person.** Never offered as something to run: a proposal at a seat a person holds;
an escalation to a role a person holds; an escalation that reached the role that raised it, or
that carries `stalled` (`docs/decisions/0039-an-escalation-that-reaches-nobody.md`); a returned
proposal no stage produces, which whoever opened it proposes again; missing tests no run can
answer, and unbound rows on a target other than the oracle's whose binding has been sent as often
as `policy.loops.rebind` allows, each waiting on a ruler. Each is listed with who it waits on and the command that person types, or
for unbound rows what is needed.

## Outputs

Nothing is written. The text output leads with the one command and why:

```
next: sdlc run derive-tests --domain <d> --stale
  why: 2 tests to derive again (redo) in <d> owed by derive-tests
  rule: owed before sequence (policy.next.order: proposals, owed, sequence); within it, upstream stage first, then the project's domain order
  phase: 2 Tests — exit: the contract approved, every domain's tests approved, and every calibration row pass or ruled, all measured by the last run
also ready:
  sdlc run contract — phase 2 Tests is not complete (...), and contract is next in it
held:
  sdlc run derive-tests --domain <d> --revise — derive-tests-<d>-stale-2 asked contract for work this revision rests on, not yet answered (sdlc run contract)
waiting on a person:
  <role>: <proposal> — <why> — sdlc rule <proposal> approve|return --by <role>
owed: 1 condition (contract), 2 redo (derive-tests)
stale tests: none
stale adapters: 12 members in old, 12 members in new (bound in phase 4 Build)
```

The `held` block appears only when something is held, and the `stale adapters` line only when
an adapter is stale.

`--json` prints the same as one object: `state` (`run`, `waiting` or `idle`), `next` (the chosen
item, with `kind` — `proposals`, `owed`, `sequence`, or `calibration` for a calibration the cadence made due — `stage`, `args`, `command`, `why` and `rule`), `ready` (every ready item in
order, `next` first), `held` (each held revision, a contract run held for the test writer with the runs held behind it, and each verify or calibration held for an adapter proposal a person holds, each with `command`, `why` and, for a revision or a verify, `name`), `waiting`, `owed` (open entries counted by kind and stage), `stale` (by
domain), `staleAdapters` (by target: the `missing` and `extra` names, whether it is `offered`,
and what it `waits` for when it is not), `phase`, `complete`, `blocked` and `order`.

Every `sdlc run` and every `sdlc rule` ends with the short form: the `next:` and `why:` lines, and
a count of what else is ready, held and waiting — proposals waiting on a person, and missing tests
and unbound bindings waiting on a ruler, each counted apart.

## Running something else

`sdlc run <stage>` compares itself with what `next` names: the stage, and each of `--domain`,
`--target` and `--slice` that `next` names, plus `--stale` and `--revise`. `--skip-suite` is not
compared: a calibration that runs the suite does what one that skips it does, and more. `--full`
is compared one way only: a full calibration where `next` names a scoped one measures everything
the scoped one would and is not a deviation, and a scoped one where `next` names `--full` is. A run that differs is
refused unless `--reason "<why>"` is given, with a message naming what `next` names. With a
reason, a line is appended to `.sdlc/runs/<day>.md` before the run starts and committed on its own
as `run(<stage>): ran instead of what next named`:

```
- <time> deviation: next named `<command>`; ran `<command>`; reason: <reason>
```

The line goes through the same redaction as every run-record line, so a local home path in the
reason is written as `~`. A `--dry-run` writes nothing and needs no reason. Where the record
cannot be read at all, the run goes ahead with a warning rather than being refused.

## Workspace the agent sees

No agent.

## Checks that block

None. `next` changes nothing, so it has nothing to protect. The `hand-edits` check
(`docs/stages/checks.md`) is what flags a record file changed outside a pipeline commit.

## Exit criterion

| Exit | Meaning |
|---|---|
| 0 | something can run; `next` names it |
| 3 | nothing can run until a person acts; the waiting list says who |
| 4 | nothing is left that this pipeline runs: every phase is complete, or the next stage is not implemented |

## Re-run behaviour

A pure read. Two calls against the same `main` and the same branches give the same answer, and
neither changes a file, a ref or the index.

## Failure modes

- No `main` branch, or no `.sdlc/config.yaml` on it, or a config that does not parse: exits 1 with
  the reason. The config is read even where it fails schema validation, so a project with a
  warning-level config problem still gets an answer.
- A proposal page with no `gate:` front matter is reported as waiting, since no seat can be found
  for it.
- A request that records no domain, target or slice is offered with a placeholder
  (`--domain <domain>`), and any value given for it matches.

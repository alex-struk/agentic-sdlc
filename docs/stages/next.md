# Stage: `next`

## Purpose

Name the next command to run, and the rule of the record that chose it, by reading the project's
recorded state on `main`. It also lists what else is ready and what is waiting on a person. The
operator still types the command; `next` decides which one.

## Inputs

`sdlc next [dir] [--json]`, where `dir` defaults to the current directory.

Everything is read from `main` through git objects (`git show`, `git cat-file`, `git ls-tree`,
`git grep` against the `main` commit), never from the working tree. The answer is the same
whichever branch is checked out and whatever is uncommitted.

| Read from `main` | What it contributes |
|---|---|
| `.sdlc/config.yaml` | the profile's stages, the domains in order, the oracle target, the gate seats, `policy.next.order` |
| `.sdlc/gates/*.yaml` | which proposals have been ruled, and which lines of work are approved |
| every `proposal/*` and `returned/*` branch, with its proposal page and gate file | open proposals, escalations and returns, and which proposal in a line of work is the newest |
| the owed-work lists (`src/spec/owed.mjs`) | open conditions, requests, redos, rebinds, recoveries and any other kind |
| `spec/criteria-index.json`, `spec/domains/<d>.md` | whether a domain is ratified, and each criterion's current version |
| `tests/acceptance/<d>/*.spec.ts` headers | stale tests: a header version below the index's |
| `tests/results/<t>/latest.json`, `applied.yaml`, `tests/adapters/<t>` | whether calibration is clean, and whether an adapter has changed since a rebind was filed |
| `spec/contract/surface.yaml`, `tests/adapters/<t>/bindings.yaml` | stale adapters: members the contract declares that a target's bindings do not name, or names they carry that it no longer declares |
| `plan/tasks.md` | the slices, in build order |

## What it decides

Ready work comes in three kinds. The record orders the work inside each kind; which kind is taken
first when more than one is ready is `policy.next.order` (`docs/config.md`), `proposals`, `owed`,
`sequence` by default.

| Kind | What is ready | Order within the kind |
|---|---|---|
| `proposals` | an open proposal whose holder is an agent (`sdlc rule <name> --by agent:<persona>`); an escalation to a role an agent plays, raised by someone else (`--by agent:<target>`); a build proposal with no verify result for the application it carries (`sdlc run verify --slice <n>`) | oldest proposal branch first |
| `owed` | a returned proposal (`--revise` for a stage that has it, otherwise the stage run again), unless it is held (below); open requests (`--revise` for a stage that has it, otherwise the stage run again: `sdlc run contract`); redo entries and stale tests (`derive-tests --domain <d> --stale`); rebind entries (`bind-adapter --target <t>`, or `calibrate --target <t>` once the adapter has changed since the entry was filed); stale adapters (`bind-adapter --target <t>`, one run with that target's rebinds); recovery entries (`archaeology --domain <d> --revise`); missing tests (`derive-tests --domain <d> --stale` when the writer owes one, `calibrate --target <t>` when one is owed a run, otherwise the owing stage, with `--domain` where it takes one); any other kind, by its owing stage | upstream stage first, then the configured domain order, then target (the oracle's first), then slice |
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

**Missing tests.** An untestable record on `main` is owed a test whether or not an entry has been
written for it yet (`docs/operating-model.md` §7): `next` reads the entries in `.sdlc/owed.yaml`
and, beside them, an item for each record nothing accounts for, owed by the stage the record names
or by `contract`. The `owed:` line counts them by owing stage (`69 missing-test (contract)`).

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
| | `calibrate --target <oracle>` | every row of `tests/results/<oracle>/latest.json` is `pass`, `not-testable` or `attested`, or carries a ruling |
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
proposal no stage produces, which whoever opened it proposes again. Each is listed with who it
waits on and the command that person types.

## Outputs

Nothing is written. The text output leads with the one command and why:

```
next: sdlc run derive-tests --domain <d> --stale
  why: 2 tests to derive again (redo) in <d> owed by derive-tests
  rule: owed before sequence (policy.next.order: proposals, owed, sequence); within it, upstream stage first, then the project's domain order
  phase: 2 Tests — exit: the contract approved, every domain's tests approved, and every calibration row pass or ruled
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

The `held` block appears only when a revision is held, and the `stale adapters` line only when
an adapter is stale.

`--json` prints the same as one object: `state` (`run`, `waiting` or `idle`), `next` (the chosen
item, with `kind`, `stage`, `args`, `command`, `why` and `rule`), `ready` (every ready item in
order, `next` first), `held` (each held revision, with `command`, `name` and `why`), `waiting`, `owed` (open entries counted by kind and stage), `stale` (by
domain), `staleAdapters` (by target: the `missing` and `extra` names, whether it is `offered`,
and what it `waits` for when it is not), `phase`, `complete`, `blocked` and `order`.

Every `sdlc run` and every `sdlc rule` ends with the short form: the `next:` and `why:` lines, and
a count of what else is ready, held and waiting.

## Running something else

`sdlc run <stage>` compares itself with what `next` names: the stage, and each of `--domain`,
`--target` and `--slice` that `next` names, plus `--stale` and `--revise`. A run that differs is
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

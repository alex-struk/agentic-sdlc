# Stage: `ratify`

## Purpose

Turn a ruled archaeology proposal into the permanent contract. Archaeology only ever writes
provisional `D-<domain>-<n>` IDs — nothing recovered is trusted until a human or the persona bound
to G1 rules on it — and `ratify` is the one place a `D-` id is promoted to a permanent `R-<domain
ordinal>.<n>` id. It does this mechanically: read the conditions the ruling attached to the
archaeology proposal, apply each one to the domain file, mint permanent IDs for whatever the
ruling actually confirmed, and regenerate the two generated files (`spec/criteria-index.json`,
`spec/spec.md`) every later stage reads instead of a domain file directly. There is no agent turn —
`ratify` is the first stage in the registry with `agent: false` — because once the ruling is on
disk, what to do with it is a deterministic reading of that ruling's own conditions, not a
judgement call.

## Inputs

`sdlc run ratify --domain <d>`, run from inside the project's working tree, once
`proposal/archaeology-<d>` has been ruled `approve` and merged into `main`. `<d>` is one of the
names in `.sdlc/config.yaml`'s `project.domains` — the same domain archaeology just recovered.
`ratify` reads every approved ruling on the domain for the `conditions` it attached (see
`docs/stages/rule.md`, "Ratification conditions") and `spec/domains/<d>.md` for the criteria those
conditions apply to. That is `.sdlc/gates/archaeology-<d>.yaml` plus every follow-up the closing
loop opened and the persona approved — `ratify-<d>-1.yaml`, `ratify-<d>-2.yaml`, and so on — read in
that order, so a later ruling's condition on a criterion is applied after (and therefore over) an
earlier one's. A follow-up that was returned or escalated decided nothing and is skipped.

## Outputs

- `spec/domains/<d>.md`, rewritten in place from its parsed criteria, with everything above the
  first `### ` block — the file's title and whatever prose or tables were written under it —
  carried across byte for byte (`docs/spec-format.md`, "Above the first criterion"). Every
  criterion the ruling's conditions named has been changed as that condition says
  (`applyConditions`, `src/spec/criteria.mjs`) — `contract` alone changes nothing at all, being the
  marker for a criterion the persona looked at and left as it stands, while `confirm`, `edit` and
  `defect` all raise confidence to `confirmed` and so are the ones that make an `inferred` or `open`
  criterion eligible to mint — and every criterion
  left `confirmed` and not `obsolete` — whether a condition named it or not — has been minted a
  permanent `R-<k>.<n>` id (`mintIds`), `k` the domain's 1-based position in `project.domains` and
  `n` continuing from the highest `n` already minted under that ordinal *anywhere in the project*,
  not only in this domain's own file — a domain reorder in `project.domains` after some ids were
  already minted could otherwise strand an old `R-<k>.<n>` in a file this run never looks at, and a
  fresh id minted from this domain's own count alone could collide with it.
  A `defect` condition keeps the row it corrects, marking it `reconciliation: defect`, raising its
  confidence to `confirmed` (it is a confirmed record of what the old system does, merely marked as
  a defect), and adding a `superseded-by` and a note naming the new criterion, and appends that new,
  `authored` criterion with the corrected statement and `replaces: <the corrected row's id>`.
  `replaces` and `superseded-by` point at whatever id their target had at the moment they were
  written (`applyConditions`, which runs before minting); `mintIds`, right after, rewrites each one
  — and any mention of the same id inside a note — to the permanent id its target actually ends up
  with, but only when that target is minted in the *same* pass. Because both the row being
  corrected and its replacement are `confirmed` the moment `defect` is applied, they always mint
  together in the same pass, so `superseded-by`, `replaces` and both notes end up naming each
  other's permanent ids, not a provisional one that no longer exists anywhere in the file once the
  pass is done.
- Applying the same gate-file conditions again, on a domain that still has some other `D-`
  criterion left in it (see "Re-run behaviour"), changes nothing further: every verb `applyConditions`
  applies checks the row it targets before acting — a note is pushed only if the row does not
  already carry it, `edit` bumps the version only when the statement actually differs, and `defect`
  appends a replacement only when no criterion already carries `replaces` naming that target with
  that exact corrected text.
- `spec/criteria-index.json` and `spec/spec.md`, regenerated from every domain file in the project
  (`writeIndex`, `renderSpecIndex`), not only the one this run touched — and regenerated on every
  run, including one that finds this domain already ratified, since both are derived from files
  this run does not otherwise look at and go stale for reasons it had nothing to do with.
  `generated_from` in the index is the commit its criteria were read at and is rewritten only when
  those criteria change: refreshing it on unchanged content would leave the index dirty after
  every run, which would be committed, which would move `HEAD` again.
- A journal entry and a run-record line, as every stage produces. The journal states how many
  criteria were accepted, how many are still open (naming each one and, where a note explains it,
  why), how many were made obsolete, how many replacements a `defect` condition added, and lists
  any condition whose ID this domain file does not actually have.
- No gate of its own: the ruling `ratify` acts on already happened, at G1, so a successful run
  commits directly to `main` as `stage(ratify): ratify <d>`.
- A follow-up proposal, `proposal/ratify-<d>-<n>`, when anything is still short of the contract —
  see "The closing loop" below.

## Workspace the agent sees

None. `ratify`'s registry entry carries `agent: false`, which tells `runStage` to skip
materialising a workspace and spawning an agent turn entirely and call `stage.execute(projectDir,
ctx)` in-process instead, in the project's own working tree — the same tree every other command
operates on. `execute`'s return (`{ text, changed }`) stands in for an agent's own result the same
way `runStage` synthesises the rest of one (`cost: 0`, `turns: 0`, `sessionId: "deterministic"`)
before handing it to the same `finishStage` every agent-run stage finishes through.

## Checks that block

- **Pre-checks.**
  - `--domain <d>` must be given, and `<d>` must be one of `project.domains`.
  - `.sdlc/gates/archaeology-<d>.yaml` must exist and record `verdict: approve` — a `return` or an
    `escalated` gate file, or no gate file at all, fails this before anything is read or written.
  - That approval must actually be on `main`: either `proposal/archaeology-<d>` shows up in `git
    branch --merged main`, or the gate file itself is reachable from `HEAD` (the ordinary case,
    since `sdlc rule` checks `main` out immediately after merging an approval).
  - `gate-conditions-parse` — no ruling this run reads carries `unparsed_conditions`. Those are
    condition lines the ratification grammar could not read even after the persona was asked to
    restate them (`docs/stages/rule.md`), so acting on that gate file would mean executing a ruling
    only partly read. Both this and the ruling's approval are already on disk in the gate files
    before `execute` ever runs, so this is checked here rather than after — the run fails naming
    each line and the gate file it is on, for a person to rewrite in place, before `execute` mints
    or regenerates anything.
  - `spec/domains/<d>.md` must exist, parse with no errors, and hold at least one criterion —
    the same check `archaeology` runs on its own output, run here *before* `execute`. `execute`
    rewrites the file from what the parser understood, so a block the parser could not read would
    be dropped on the way back out; failing first, naming the file and line of every parse error,
    is what keeps a malformed block from being deleted instead of reported.
- **Post-checks**, run against the working tree after `execute` returns:
  - `checkCriteria` — the same structural check every stage that touches `spec/domains` runs:
    every domain file parses, IDs are unique across domains, and no criterion is `accepted` while
    its confidence is still `inferred` or `open`. This is `ratify`'s own promise that it never
    mints an id for something it should not have.
  - `criteria-index` — `spec/criteria-index.json` matches `spec/domains/*.md` on every
    criterion's id, domain, version, confidence, state and statement. This is ratify's promise
    that the index it just regenerated is the one a later stage can build against; a project with
    no index yet passes, having nothing to be stale.
  - `spec/criteria-index.json` exists and parses as JSON; `spec/spec.md` exists.

## Exit criterion

Exits 0 and prints `run ratify: ok` once `execute` has written the domain file and regenerated
both generated artifacts, or once it has determined there is nothing left to do (see "Re-run
behaviour"). Any pre-check or post-check failure exits 1 and prints the failing check's messages.

## Re-run behaviour

Running `ratify --domain <d>` again writes no journal entry whenever it would leave the domain
file byte-identical to what is already on disk: `execute` re-derives the file from the same
gate-file conditions and compares the result to what is there before writing anything, and if the
two match it returns `{ changed: [] }`. A journal entry is the account of a turn, and no turn
happened, so `runStage` finishes through `finishDeterministicNoOp` instead — which still runs the
post-checks, and still commits whatever regenerating the index, the spec page and the state site
left dirty, under `stage(ratify): ratify <d> (regenerated)` with a run-record line and no journal
entry. When regenerating changed nothing either, the run commits nothing at all and the working
tree is left exactly as it was (it still prints `execute`'s text, so a re-run is not silent — see
"Outputs"). This covers two cases: the domain has nothing
provisional left in it (every `D-<d>-<n>` id has already been minted to an `R-` id), and — just as
common — some criterion is still `D-` on purpose (a `spike`d or still-`inferred` row the ruling
never confirmed) and stays that way indefinitely, with every condition that already touched it a
no-op the second time (see "Outputs"). Neither case is different from every agent-run stage's
re-run behaviour (`docs/stages/run.md`) because `ratify` is a no-op *more* readily, not less — an
agent-run stage always produces a fresh, separately numbered journal entry even when the agent's
output is byte-identical to what is already on `main`; `ratify` never does, because nothing spawned
an agent turn to journal in the first place, and there is a real, cheap way to tell whether anything
actually changed.

Running `archaeology --domain <d>` again after ratifying it, then ruling and ratifying the newly
recovered criteria, is ordinary: each pass mints only what that pass's own conditions and
confirmations cover, continuing the domain's `R-<k>.<n>` numbering from wherever the last pass left
it.

## The closing loop

`ratify` mints only what the ruling actually confirmed, so a domain routinely comes out of a pass
with criteria still `inferred` or `open`. Those have no permanent id, which means no later stage can
build against them — and nothing used to ask about them again: they sat in the domain file
indefinitely and closing them out depended on somebody noticing.

So once the ratify commit has landed on `main`, `ratify` opens a G1 proposal named
`ratify-<d>-<n>` (`n` = 1, 2, …, continuing past any follow-up already ruled) whenever the domain
still holds a criterion that is `inferred` or `open` and not `obsolete`. Its page lists exactly
those criteria — id, version, confidence, origin, statement, reconciliation, given/when/then,
citations and notes — restates the ratification grammar the answer has to be written in, and marks
every criterion an earlier ruling already answered with `contract` or `spike`, since neither verb
ever raises a criterion's confidence and answering the same way again would leave it exactly where
it is. The persona rules it like any other G1 proposal, and the next `sdlc run ratify --domain <d>`
reads its conditions alongside the archaeology ruling's. Each pass therefore either resolves
criteria or asks about fewer of them.

At most one follow-up is open at a time: while `ratify-<d>-<n>` is unruled it is the thing the loop
is waiting on, and a second would ask the same question twice. A criterion marked `obsolete` is a
decision, not an open question, so it is not asked about again even though it keeps whatever
confidence it was recovered with. When nothing is left, no proposal is opened and the loop is
closed.

**The loop bound.** `contract` and `spike` both answer a follow-up without ever resolving it —
`contract` changes nothing at all, and `spike` only records a question — so a persona that keeps
choosing one of them (or a follow-up nobody rules on the way the grammar means it to be ruled)
would otherwise never close the loop. `confirm`, `edit` and `defect` are the three verbs that
actually resolve a criterion (`applyConditions` raises confidence to `confirmed` for all three),
so a criterion ruled on with any of them is already out of `inferred`/`open` — and therefore out of
this sweep's reach — before this bound is even checked. `execute` counts how many of a domain's
approved follow-up rulings (`ratify-<d>-<n>`, not the archaeology ruling itself) have been read so
far; once a criterion still `inferred` or `open` has been through two of them with nothing
resolving it, `execute` marks it `state: obsolete` itself, with the note `unresolved after two
rulings`, before minting anything else in that pass. The sweep only ever considers a `D-` id — an
`R-` criterion was already minted, which only happens once it was already `confirmed`, so it can
never legitimately be looked at here; the guard exists in case a condition line names an
already-minted `R-` id (a stray `spike` re-run, say) and leaves it with a stale `inferred`/`open`
confidence that must never cost it its permanent-id status. The journal lists a swept criterion
under "Obsolete" the same way any other obsoleted criterion is listed. Once it is `obsolete` it is
no longer an open question, so the next `followUp` call does not list it and, once every criterion
in the domain has resolved this way or another, opens no further proposal — the loop always
terminates, whether or not the persona ever rules a criterion out of `inferred`/`open` directly.

## Failure modes

- `--domain` is missing, or names a domain not in `project.domains`: the pre-check fails before
  anything else runs.
- The archaeology proposal for this domain has not been ruled, was returned or escalated rather
  than approved, or is approved but not yet merged into `main`: the matching pre-check fails,
  naming which of the three is missing.
- `spec/domains/<d>.md` does not exist, does not parse, or holds no criteria: the pre-check
  fails, naming each parse error by line, and nothing is written.
- A condition names an ID this domain's criteria do not actually have: `applyConditions` reports it
  in `unknown` rather than throwing, and `execute`'s journal text lists it — the run still succeeds,
  since one bad condition line should not block every other one that parsed fine.
- A ruling carries `unparsed_conditions`: the `gate-conditions-parse` pre-check fails, naming each
  line and its gate file, before anything is read from the domain file or written back to it.
  Unlike an unknown ID, this is a ruling that was never fully read, so the run does not proceed at
  all — the domain file, the index and the spec page are all left exactly as they were.
- The rewritten domain file, or the regenerated index or spec page, fails `checkCriteria` or the
  artifacts check: `finishStage` commits `stage(ratify): post-checks failed` with only the journal
  and run record staged, and the domain file `execute` actually wrote is left in the working tree,
  untracked, for a person to inspect.

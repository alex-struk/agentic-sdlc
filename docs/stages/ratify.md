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
`ratify` reads `.sdlc/gates/archaeology-<d>.yaml` for the `conditions` the ruling attached (see
`docs/stages/rule.md`, "Ratification conditions") and `spec/domains/<d>.md` for the criteria those
conditions apply to.

## Outputs

- `spec/domains/<d>.md`, rewritten in place from its parsed criteria, with everything above the
  first `### ` block — the file's title and whatever prose or tables were written under it —
  carried across byte for byte (`docs/spec-format.md`, "Above the first criterion"). Every
  criterion the ruling's conditions named has been changed as that condition says
  (`applyConditions`, `src/spec/criteria.mjs`), and every criterion
  left `confirmed` and not `obsolete` — whether a condition named it or not — has been minted a
  permanent `R-<k>.<n>` id (`mintIds`), `k` the domain's 1-based position in `project.domains` and
  `n` continuing from the highest `n` already minted under that ordinal *anywhere in the project*,
  not only in this domain's own file — a domain reorder in `project.domains` after some ids were
  already minted could otherwise strand an old `R-<k>.<n>` in a file this run never looks at, and a
  fresh id minted from this domain's own count alone could collide with it.
  A `defect` condition keeps the row it corrects, marking it `reconciliation: defect` and adding a
  `superseded-by` and a note naming the new criterion, and appends that new, `authored` criterion
  with the corrected statement and `replaces: <the corrected row's id>`. `replaces` and
  `superseded-by` point at whatever id their target had at the moment they were written
  (`applyConditions`, which runs before minting); `mintIds`, right after, rewrites each one — and
  any mention of the same id inside a note — to the permanent id its target actually ends up with,
  but only when that target is minted in the *same* pass. The replacement (always authored
  `confirmed`) almost always mints immediately, so in the ordinary case both the row's
  `superseded-by` and its note end up naming a permanent id, not the provisional one that no longer
  exists anywhere in the file once the pass is done. The row being corrected does not necessarily
  mint alongside it — if the ruling left it `inferred` or `open` rather than confirming it, it keeps
  its own provisional `D-` id regardless of what happens to its replacement.
- Applying the same gate-file conditions again, on a domain that still has some other `D-`
  criterion left in it (see "Re-run behaviour"), changes nothing further: every verb `applyConditions`
  applies checks the row it targets before acting — a note is pushed only if the row does not
  already carry it, `edit` bumps the version only when the statement actually differs, and `defect`
  appends a replacement only when no criterion already carries `replaces` naming that target with
  that exact corrected text.
- `spec/criteria-index.json` and `spec/spec.md`, regenerated from every domain file in the project
  (`writeIndex`, `renderSpecIndex`), not only the one this run touched.
- A journal entry and a run-record line, as every stage produces. The journal states how many
  criteria were accepted, how many are still open (naming each one and, where a note explains it,
  why), how many were made obsolete, how many replacements a `defect` condition added, and lists
  any condition whose ID this domain file does not actually have.
- No proposal and no gate: `ratify` holds no gate of its own (the ruling it acts on already
  happened, at G1, on the archaeology proposal), so a successful run commits directly to `main` as
  `stage(ratify): ratify <d>`.

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
  - `spec/criteria-index.json` exists and parses as JSON; `spec/spec.md` exists.

## Exit criterion

Exits 0 and prints `run ratify: ok` once `execute` has written the domain file and regenerated
both generated artifacts, or once it has determined there is nothing left to do (see "Re-run
behaviour"). Any pre-check or post-check failure exits 1 and prints the failing check's messages.

## Re-run behaviour

Running `ratify --domain <d>` again is a true no-op whenever it would leave the domain file
byte-identical to what is already on disk: `execute` re-derives the file from the same gate-file
conditions and compares the result to what is there before writing anything, and if the two match,
returns `{ changed: [] }`, which `runStage` reads as "nothing happened" and returns without writing
a journal entry, appending a run record, or committing anything (it still prints `execute`'s text,
so a re-run is not silent — see "Outputs"). This covers two cases: the domain has nothing
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

## Failure modes

- `--domain` is missing, or names a domain not in `project.domains`: the pre-check fails before
  anything else runs.
- The archaeology proposal for this domain has not been ruled, was returned or escalated rather
  than approved, or is approved but not yet merged into `main`: the matching pre-check fails,
  naming which of the three is missing.
- `spec/domains/<d>.md` does not exist, does not parse, or holds no criteria: the pre-check
  fails, naming each parse error by line, and nothing is written.
- A condition names an ID this domain's criteria do not actually have, or is not one of the seven
  recognised verbs: `applyConditions` reports it in `unknown` rather than throwing, and `execute`'s
  journal text lists it — the run still succeeds, since one bad condition line should not block
  every other one that parsed fine.
- The rewritten domain file, or the regenerated index or spec page, fails `checkCriteria` or the
  artifacts check: `finishStage` commits `stage(ratify): post-checks failed` with only the journal
  and run record staged, and the domain file `execute` actually wrote is left in the working tree,
  untracked, for a person to inspect.

# Stage: `archaeology`

## Purpose

Recover what an existing, unfamiliar application actually does for one business domain, from its
own code and docs rather than from anyone's memory of it, and record that as criteria in the
spec's own format — provisional, cited, and graded by how well the evidence actually supports
each one. This is the stage that turns "an old system exists" into something ratify can later
mint permanent IDs from. It holds gate G1: nothing recovered here is trusted as the contract until
a human or the persona bound to G1 rules on it.

## Inputs

`sdlc run archaeology --domain <d>`, run from inside the project's working tree, where `<d>` is
one of the names in `.sdlc/config.yaml`'s `project.domains`. The stage reads `sources/old` — a
read-only checkout of the old application, cloned and pinned to the commit `config.sources.old`
names, with every path in its `exclude` list already removed from the working tree before the
agent session starts — plus `constitution.md`, `spec/`, and `intent/` for context. It never reads
`sources/old/tests`, and never reads anything else outside `sources/old`.

## Outputs

- `spec/domains/<d>.md` in the criterion format (`spec/README.md`): one block per recovered
  behaviour, provisional `D-<d>-<n>` IDs, origin `recovered`, a confidence of `confirmed`,
  `inferred`, or `open` graded by the evidence, at least one `cites` per criterion, a
  reconciliation class, and given/when/then.
- Recovered pages appended to `spec/contract/surface.yaml`, each carrying a `domain: <d>` field,
  and any new roles appended to `spec/contract/personas.yaml`.
- A journal entry and a run-record line, as every stage produces. The journal leads with three
  sentences on what the domain does, then what conflicted between sources, then what could not be
  determined.
- A proposal at gate G1: `.sdlc/proposals/archaeology-<d>.md` on a new `proposal/archaeology-<d>`
  branch, holding the question "Is this what the `<d>` domain does, and which of it is the
  contract?" and a recommendation that is the first sentence of the agent's own journal text.

## Workspace the agent sees

`with-sources` mode: the agent works directly in the project's own working tree, the same as
`project` mode, except the workspace is materialised by first calling `ensureSources` — cloning
`config.sources.old.repo` into `sources/old` if it is not there yet, checking it out at
`config.sources.old.commit`, and removing every excluded path from the working tree. `sources/` is
untracked (`.gitignore` carries it, so cloning it never touches the project's own history) and the
`implement-guard` hook (`docs/stages/init.md`) restricts an `archaeology` run to `spec/` —
`app/`, `tests/`, `intent/`, `.github/`, `.sdlc/`, and `sources/` itself are all blocked, so the
old application archaeology reads stays exactly as read-only in practice as it is in name.

## Checks that block

- **Pre-checks.**
  - `--domain <d>` must be given, and `<d>` must be one of `project.domains` in
    `.sdlc/config.yaml`. Either failure fails the run before a workspace is materialised, so
    nothing is cloned for a run that was never going to write anywhere valid.
  - `config.sources.old` must be configured. Missing, the run fails with a message naming what to
    add, before any clone is attempted.
- **Post-checks**, run against the working tree after the agent session ends:
  - `checkCriteria` — every domain file in `spec/domains/` parses, IDs are unique across domains,
    every `recovered` criterion has a `cites`, every citation resolves under `sources/old`, and no
    criterion is `accepted` while still `inferred` or `open`.
  - `spec/domains/<d>.md` exists, parses with no errors, and holds at least one criterion.
  - `spec/domains/<d>.md` mints no `R-` ID — a permanent ID is ratify's to write, once a human has
    ruled on what this run recovered, never archaeology's own to assign.
  - Nothing changed outside `spec/`, checked against `git status --porcelain`.

## Exit criterion

Exits 0 and prints `run archaeology: ok (opened proposal/archaeology-<d>)` once the proposal
branch is open. Any pre-check or post-check failure exits 1 and prints the failing check's
messages; whatever the agent wrote, if anything, stays in the working tree, untracked, for
inspection.

## Re-run behaviour

Re-running `archaeology --domain <d>` after its own proposal has already been opened is not
blocked by this stage itself — `sdlc run` starts from `main`, which the still-open proposal branch
has not yet merged into, so `spec/domains/<d>.md` is exactly as it was (or absent, on a first
attempt that failed) and a second run recovers the domain again, most likely producing the same
file and opening a second, separately-branched proposal for the same domain. Rule the open
proposal first rather than relying on anything here to stop that. Running the stage against a
different `--domain` on the same project is ordinary and expected — one run, one domain, one
proposal.

## Failure modes

- `--domain` is missing, or names a domain not in `project.domains`: the pre-check fails before
  anything else runs (see above).
- `config.sources.old` is not configured: the pre-check fails the same way, before any clone is
  attempted.
- The agent session itself fails to run, or reports failure (turn limit, an error result): handled
  the same way every stage's agent-turn failure is (`docs/stages/run.md`) — no post-checks run,
  the turn's own text becomes the journal entry, and `run` returns `{ ok: false }`.
- The agent writes no domain file, a domain file with a parse error or zero criteria, a domain
  file that mints an `R-` ID, or touches a path outside `spec/`: the matching post-check fails,
  `finishStage` commits `stage(archaeology): post-checks failed` with only the journal and run
  record staged, and whatever the agent actually wrote is left untracked in the working tree for a
  person to look at.

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
  and any new roles appended to `spec/contract/personas.yaml`. `--revise` writes neither: a
  revision changes `spec/domains/<d>.md` only (see "Revising after a return" below).
- A journal entry and a run-record line, as every stage produces. The journal leads with three
  sentences on what the domain does, then what conflicted between sources, then what could not be
  determined.
- A proposal at gate G1: `.sdlc/proposals/archaeology-<d>.md` on a new `proposal/archaeology-<d>`
  branch, holding the question "Is this what the `<d>` domain does, and which of it is the
  contract?" and a recommendation that is one sentence taken from the agent's own journal text — not a
  re-derivation of it. When the text carries a `## Journal` heading the sentence is taken from
  after it, since anything above the heading is preamble rather than the entry; an opening
  sentence that only announces the work happened ("Done.", "I've written the domain file.") or
  is too short to carry a claim is skipped for the next one; and the result is capped at 200
  characters.

## Workspace the agent sees

`with-sources` mode: the agent works directly in the project's own working tree, the same as
`project` mode, except the workspace is materialised by first calling `ensureSources` — cloning
`config.sources.old.repo` into `sources/old` if it is not there yet, checking it out at
`config.sources.old.commit`, and removing every excluded path from the working tree. `sources/` is
untracked (`.gitignore` carries it, so cloning it never touches the project's own history) and the
`implement-guard` hook (`docs/stages/init.md`) allows an `archaeology` run to write only under
`spec/` — every other path, including `sources/` itself, is blocked, so the old application
archaeology reads stays exactly as read-only in practice as it is in name.

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
  - No domain file this run actually changed mints an `R-` ID — a permanent ID is ratify's to
    write, once a human has ruled on what this run recovered, never archaeology's own to assign.
    Checked across every `spec/domains/*.md` this run touched, not only `spec/domains/<d>.md`,
    since the scope check below allows a run to change any path under `spec/`.
  - In `--revise` mode only (`archaeology-revise-keeps-minted`): every `R-` criterion in
    `spec/domains/<d>.md` still matches the one `HEAD` had, compared field by field with each
    criterion's own `line` left out of the comparison. A revision may correct the criterion the
    returning ruling named; it may never alter or remove one already minted permanent.
  - Nothing changed outside `spec/`, checked against `git status --porcelain`.
  - In `--revise` mode only (`archaeology-revise-scope`): nothing changed outside
    `spec/domains/<d>.md` itself — narrower than the scope check above, which still allows a first
    recovery to touch any path under `spec/` (see "Revising after a return" below).

## Exit criterion

Exits 0 and prints `run archaeology: ok (opened proposal/archaeology-<d>)` once the proposal
branch is open. Any pre-check or post-check failure exits 1 and prints the failing check's
messages; whatever the agent wrote, if anything, stays in the working tree, untracked, for
inspection.

## Re-run behaviour

Re-running `archaeology --domain <d>` while its own proposal (`proposal/archaeology-<d>`) is still
open — opened, but not yet ruled — is refused before a workspace is materialised or an agent
session starts: `run` returns `{ ok: false }` with the message `proposal archaeology-<d> is still
open; rule it (or delete the branch) before running archaeology again`, and commits that outcome
to the run record the same way a pre-check failure is. Rule the open proposal (`sdlc rule
archaeology-<d> approve --by tech-lead`, or `return`) or delete its branch first. Once ruled, the
same domain can be run again — `spec/domains/<d>.md` on `main` reflects whatever the ruling
decided, and a fresh run recovers the domain again from there. An approved proposal's now-merged
branch is deleted as part of that next run's own pre-flight check, so opening a fresh
`proposal/archaeology-<d>` under the same name does not collide with the old one; a returned or
escalated proposal's branch, never merged, is left for a person to clean up. Running the stage
against a different `--domain` on the same project is ordinary and expected — one run, one domain, one
proposal, and only a domain whose own proposal is currently open is refused.

## Revising after a return

A ruling at G1 can find that one criterion's evidence — its citations, or its given/when/then — is
wrong in a way no ratification condition can repair, and return the proposal instead of approving
it. Neither `sdlc rule` nor `sdlc run archaeology --domain <d>` on its own does anything with that:
the ruling's rationale says what archaeology has to go back and redo, and `--revise` is what acts
on it. Why a return leaves the ratification loop entirely rather than becoming another condition
verb: `docs/decisions/0006-contract-stage-and-oracle.md`.

`archaeology.preChecks` runs `--domain` and `sources.old` first; only once both pass does it look
for a returned ruling — its own side effect (below) never fires as a side channel of a batch that
failed for some unrelated reason, and a misconfigured run leaves any real returned ruling exactly
where it was for a corrected re-run to find.

Once those two pass, `sdlc run archaeology --domain <d> --revise` looks for a returned ruling to
revise from: among `proposal/archaeology-<d>` and every `proposal/ratify-<d>-<n>` follow-up, the
one whose gate file records `verdict: return` and has not already landed on `main` — the
highest-numbered follow-up if more than one qualifies, otherwise the archaeology proposal itself.
None found fails the pre-check with `archaeology --revise: no returned ruling for <d> to revise
from`.

On a real run, once found, that branch's gate file and proposal page are copied onto `main`,
committed as `record(G1): <name> returned`, and the branch — never merged, since a return merges
nothing — is deleted. This is what makes the return visible everywhere a ruling normally is: the
state site, and `followUpState`'s own count of what has been ruled on, so the next
follow-up a further ratify pass opens continues the numbering past it rather than reusing its
number. It does not make the return visible to `readRulings` (`registry.mjs` ~1131-1161), which
only reads a gate file whose `verdict` is `approve` and skips every other gate — a return
contributes nothing to `ratify`'s own conditions no matter where its gate file lives. The working
tree is clean again once this commit lands, so the rest of the run — and `propose`, later — works
exactly as an ordinary run's does. A branch whose proposal page is missing (a ruling made straight
from the CLI, with no page ever opened) still has its gate file recorded; the commit says there
was no page to carry over rather than failing outright.

On `--dry-run`, nothing is recorded: the rationale is found and quoted in the printed prompt, the
same way a real run's would be, but the branch, its gate file and `main` are all left exactly as
found — a dry run writes nothing at all, the same promise `docs/stages/run.md` makes for every
stage.

The prompt is different from a first recovery: it quotes the returning ruling's rationale verbatim
and asks for a revision, not a fresh recovery — rewrite the statement, citations, given/when/then,
note and confidence of exactly the criteria the rationale names, leave every other criterion alone
unless the rationale's own evidence contradicts it, never renumber anything, and touch
`spec/domains/<d>.md` only — unlike a first recovery, a revision never appends to
`spec/contract/surface.yaml` or `spec/contract/personas.yaml`. Three post-checks enforce the
boundaries this implies: `archaeology-no-minted-ids` only fails on an `R-` id that is new relative
to `HEAD` (an id the domain file already carried, from an earlier ratify pass, is not this run's
doing, in `--revise` mode or not); `archaeology-revise-keeps-minted` fails if any `R-` criterion in
the changed domain file no longer matches `HEAD`'s — the permanent record a revision must never
touch; and `archaeology-revise-scope` fails if the run changed any path other than
`spec/domains/<d>.md`, naming whichever other path it touched.

The proposal it opens reuses the name `archaeology-<d>` — its earlier branch, if any, was already
deleted by the pre-flight above or by the ordinary re-run cleanup — with the question "Is the
revised `<d>` domain right where the return said it was wrong?" and a recommendation taken from the
journal, the same way any other archaeology proposal's is.

## Failure modes

- The domain's own proposal (`proposal/archaeology-<d>`) is still open: refused before a workspace
  is materialised (see "Re-run behaviour" above).
- `--domain` is missing, or names a domain not in `project.domains`: the pre-check fails before
  anything else runs (see above).
- `config.sources.old` is not configured: the pre-check fails the same way, before any clone is
  attempted.
- `--revise` with no returned ruling to revise from: the pre-check fails with `archaeology
  --revise: no returned ruling for <d> to revise from` (see "Revising after a return" above).
- The agent session itself fails to run, or reports failure (turn limit, an error result): handled
  the same way every stage's agent-turn failure is (`docs/stages/run.md`) — no post-checks run,
  the turn's own text becomes the journal entry, and `run` returns `{ ok: false }`.
- The agent writes no domain file, a domain file with a parse error or zero criteria, a domain
  file that mints an `R-` ID that is new relative to `HEAD`, touches a path outside `spec/`, or —
  in `--revise` mode — alters or removes an already-minted `R-` criterion, or touches any path
  other than `spec/domains/<d>.md`: the matching post-check fails, `finishStage` commits
  `stage(archaeology): post-checks failed` with only the journal and run record staged, and
  whatever the agent actually wrote is left untracked in the working tree for a person to look at.

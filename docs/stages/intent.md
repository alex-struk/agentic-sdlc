# Stage: `intent`

## Purpose

Turn a written stakeholder brief into the project's first spec artifact: why the work matters,
for whom, and what a measurable outcome looks like — with every gap the brief leaves open
recorded as an open question instead of guessed at. This is the first stage that holds a gate
(G0): its output is not trusted until a human or the persona bound to G0 rules on it.

## Inputs

`sdlc run intent`, run from inside the project's working tree. The stage reads `intent/brief.md`
— the tech lead's own written brief — and nothing else outside the project's already-committed
state. There is no `--slice` or `--domain` use here; `intent` runs once per project, against the
one brief.

## Outputs

- Exactly one new file, `intent/<slug>.md`, built from `intent/.template.md` and filled in from
  the brief: `Problem`, `Proposed outcome`, `Affected users and systems`, `Constraints`,
  `Evidence`, and `## Open questions` listing everything the brief left unanswered. `<slug>` is
  the brief's title, lowercased, with spaces and punctuation turned into hyphens.
  `intent/brief.md` itself is read, never rewritten.
- Optionally, new rows in `constitution.md`'s J4 domain-language table for terms the brief
  defines that the table doesn't already carry.
- A journal entry and a run-record line, as every stage produces.
- A proposal at gate G0: `.sdlc/proposals/intent-<slug>.md` on a new `proposal/intent-<slug>`
  branch, holding the question "Is this the right problem and outcome?" and a recommendation
  that is the first sentence of the agent's own journal text — not a re-derivation of it.

## Workspace the agent sees

`project` mode: the agent works directly in the project's own working tree, with the
`implement-guard` hook (`docs/stages/init.md`) restricting an `intent` run to `intent/` and
`constitution.md` — `app/`, `tests/`, `spec/`, `.github/`, `.sdlc/config.yaml` and `sources/` are
all blocked, the same isolation every stage gets, scoped to what `intent`'s own contract allows
it to touch.

## Checks that block

- **Pre-check.** `intent/brief.md` must exist. Missing, the run fails before a workspace is
  materialised or an agent session starts, with the message `intent/brief.md is missing: the
  tech lead writes the brief` — the brief is not something an agent should write on the tech
  lead's behalf.
- **Post-checks**, run against `git status --porcelain -- intent` after the agent session ends:
  - Exactly one file under `intent/` other than `brief.md` was added or changed. Zero means
    nothing was written; more than one means the interview produced more than the one intent
    document the gate is meant to judge.
  - That file has no `{{` left in it — an unfilled template placeholder.
  - That file has an `## Open questions` heading, present whether or not any question is
    currently open under it.
  - Nothing changed outside `intent/` and `constitution.md`.

## Exit criterion

Exits 0 and prints `run intent: ok (opened proposal/intent-<slug>)` once the proposal branch is
open. Any pre-check or post-check failure exits 1 and prints the failing check's messages; the
intent document, if the agent wrote one, stays in the working tree, untracked, for inspection.

## Re-run behaviour

Re-running `intent` after its own proposal has already been opened is not blocked by this stage
itself — `sdlc run` starts from `main`, which the still-open proposal branch has not yet merged
into, so `intent/brief.md` is exactly as it was and a second run interviews it again, most likely
producing the same `intent/<slug>.md` and opening a second, separately-branched proposal for the
same slug. Nothing in `intent`'s own checks stops that; avoiding it is a process matter (rule the
open proposal first) rather than something the stage enforces.

## Failure modes

- `intent/brief.md` is missing: the pre-check fails before anything else runs (see above).
- The agent session itself fails to run, or reports failure (turn limit, an error result): handled
  the same way every stage's agent-turn failure is (`docs/stages/run.md`) — no post-checks run,
  the turn's own text becomes the journal entry, and `run` returns `{ ok: false }`.
- The agent writes zero intent files, more than one, an unfilled placeholder, a document missing
  its `## Open questions` heading, or touches a file outside `intent/`/`constitution.md`: the
  matching post-check fails, `finishStage` commits `stage(intent): post-checks failed` with only
  the journal and run record staged, and whatever the agent actually wrote is left untracked in
  the working tree for a person to look at.

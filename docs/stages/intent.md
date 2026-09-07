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
  that is one sentence taken from the agent's own journal text — not a
  re-derivation of it. When the text carries a `## Journal` heading the sentence is taken from
  after it, since anything above the heading is preamble rather than the entry; an opening
  sentence that only announces the work happened ("Done.", "I've written the domain file.") or
  is too short to carry a claim is skipped for the next one; and the result is capped at 200
  characters.

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

Re-running `intent` while its own proposal is still open — opened, but not yet ruled — is refused
up front by `run`'s own pre-flight check, the same as any other gated stage (`docs/stages/run.md`):
before the agent turn starts, `intent.proposal` derives a candidate slug straight from
`intent/brief.md`'s own first `# ` heading — the same rule the skill gives the agent for naming the
file it writes (lowercased, every run of non-alphanumeric characters turned into one hyphen) — and
the pre-flight checks whether `proposal/intent-<that-slug>` is already open and unruled. Since
`sdlc run` starts from `main`, which the still-open proposal branch has not yet merged into,
`intent/brief.md` is exactly as it was, so a second run against the same unrevised brief is caught
here every time.

If the brief has no `# ` heading at all, `intent.proposal` has nothing to derive and returns
`null`, so the pre-flight is skipped and the run proceeds to the agent turn to find out. And
because the pre-flight's derived slug is only a guess at what the agent will actually title its
document — an agent that names the file differently than the brief's own heading suggests can still
collide with an open proposal the pre-flight didn't know to check — `finishStage` checks again once
the agent has run and the real `intent/<slug>.md` exists. A collision found there is reported the
same way any other post-check failure is: a journal entry and run record are committed, and the
agent's own files (the intent document it wrote included) are left in the working tree, untracked,
for inspection — rather than letting `propose`'s own `git checkout -q main` fail messily partway
through. Either way, rule the open proposal first (`sdlc rule intent-<slug> approve --by
agent:product-owner`, or `return`) before running `intent` again.

## Failure modes

- `intent/brief.md` is missing: the pre-check fails before anything else runs (see above).
- The brief's own proposal (`proposal/intent-<slug>`) is still open: refused before a workspace is
  materialised, the same as any other gated stage's pre-flight (see "Re-run behaviour" above) — or,
  if the pre-flight couldn't know because the agent titled its document differently than the brief's
  heading suggested, caught instead by `finishStage` right after the agent's document passes its
  other post-checks, reported the same way a post-check failure is.
- The agent session itself fails to run, or reports failure (turn limit, an error result): handled
  the same way every stage's agent-turn failure is (`docs/stages/run.md`) — no post-checks run,
  the turn's own text becomes the journal entry, and `run` returns `{ ok: false }`.
- The agent writes zero intent files, more than one, an unfilled placeholder, a document missing
  its `## Open questions` heading, or touches a file outside `intent/`/`constitution.md`: the
  matching post-check fails, `finishStage` commits `stage(intent): post-checks failed` with only
  the journal and run record staged, and whatever the agent actually wrote is left untracked in
  the working tree for a person to look at.

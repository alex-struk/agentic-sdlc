# Stage: `propose`

## Purpose

Open a named proposal — a decision at a policy gate — as its own git branch with a decision page,
for a gate holder to rule on later. A stage that holds a gate also ends here: instead of
committing its work to `main`, it hands that work to `propose` so the files and the decision page
land in one commit on a branch nobody has approved yet.

## Inputs

By hand:

```
sdlc propose <name> --gate G<n> --question "..." --recommendation "..." [--page "..."] [--tier T]
```

run from inside the project's working tree.

| Input | What it is |
| --- | --- |
| `<name>` | The proposal's name, `^[a-z0-9][a-z0-9-]*$`. It names the branch (`proposal/<name>`), the page (`.sdlc/proposals/<name>.md`) and, later, the gate file. |
| `--gate` | The policy gate this decision belongs to. Must be a key in the project's `policy.gates`. |
| `--question` | The decision, as a question. It becomes the page's heading. |
| `--recommendation` | What the proposer thinks the answer is. |
| `--page` | Optional extra body text below the recommendation. A stage passes its agent's own account of the work here. |
| `--tier` | Optional risk tier for this proposal (`STANDARD`, `HIGH`, `CRITICAL`, …). Written into the page's front matter as `tier:`, where `sdlc rule` reads it: `HIGH` and `CRITICAL` escalate to a human without the gate's persona agent ever being asked. Left out, the ruling falls back to `policy.default_tier`. |

From a stage: `propose(projectDir, name, { gate, question, recommendation, page, tier, paths })`.
`paths` is the one argument with no CLI flag — a list of project-relative paths the caller has
already changed and wants in this proposal's commit. `finishStage` passes everything the stage's
agent turn touched (from `changedPaths()`, so deletions and renames are named too, plus the
journal entry, the run record and the regenerated site).

## Outputs

- A new branch `proposal/<name>`, created from `main`.
- `.sdlc/proposals/<name>.md`: YAML front matter (`gate`, `question`, `recommendation`, `opened`,
  and `tier` when one was given) followed by the question as a heading, the recommendation, and
  any `page` content.
- An appended `.sdlc/runs/<date>.md` entry: `propose <name> at <gate>`.
- **One commit on the proposal branch**, `propose(<gate>): <name>`, containing exactly: the
  proposal page, the run-record file, and every path in `paths` — nothing else that happened to be
  in the working tree. Staging goes through `stageAll`, so a path the caller deleted or renamed is
  committed as gone rather than silently left behind.

The command leaves the working tree checked out on the new proposal branch. Nothing is merged;
`main` is untouched until someone rules on the proposal (`docs/stages/rule.md`).

## Workspace the agent sees

No agent. `propose` writes the decision page and commits it; whatever produced the question, the
recommendation and the page body — a person, or a stage's agent turn — ran before this command was
invoked.

## Checks that block

- `name` must match `^[a-z0-9][a-z0-9-]*$`.
- `--gate`, `--question` and `--recommendation` are all required.
- `--gate` must name a gate in the project's `policy.gates`, checked before any git command runs:
  a proposal opened at a gate nobody holds could never be ruled, and there is no reason to leave a
  branch behind saying otherwise.
- **The dirty-tree rule depends on whether `paths` was given**, because the two callers are in
  opposite situations:

  | Caller | Rule |
  | --- | --- |
  | A person, no `paths` | The working tree must be clean (`assertCleanTree`). `propose` checks out `main` to branch from it, which would carry uncommitted work across, so it refuses to start and lists the dirty paths. |
  | A stage, with `paths` | The tree is dirty *on purpose* — those files are what the proposal is for. Only a changed path the caller did **not** list fails the call, with `propose: files outside paths are dirty:` and the offending paths. |

  The second rule is the same "name what's wrong" contract as the first, narrowed to what this
  proposal was not told about: a stage's own output is expected, an unrelated edit sitting in the
  tree is not.

## Exit criterion

Exits 0 and prints `opened proposal/<name>`.

## Re-run behaviour

Not idempotent under the same name: `git checkout -b` fails if `proposal/<name>` already exists,
so re-running `propose` with a name already in use errors out. A different name opens a new,
independent branch.

## Failure modes

- Invalid name format, a missing required flag, or a gate not in `policy.gates`: throws before any
  git command runs, so no branch is left behind.
- The working tree is dirty and no `paths` were given: throws listing the dirty paths, leaving the
  current branch checked out.
- A path outside `paths` is dirty: throws `propose: files outside paths are dirty:` and names
  them; again before any branch is created.
- A branch of that name already exists: the underlying `git checkout -b` fails and its error
  surfaces as-is. The page and the run record are written only after the branch exists, so nothing
  has been left in the tree — but the `git checkout main` before it did succeed, so the working
  tree is on `main` rather than wherever it started.

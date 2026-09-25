# Command: `policy set`

## Purpose

Propose a change to the `policy` block of `.sdlc/config.yaml` — who holds a gate, which agent
backend runs which stage, a loop limit, a turn ceiling — as a proposal at G-POL. The change is made
to `main`'s copy of the file and carried on the proposal branch, so the configuration on `main`
changes only when a G-POL seat approves it.

No stage may change the configuration, and `sdlc propose` by hand commits its decision page alone,
so this is the command that puts a changed configuration in front of a ruling. A change to policy
is ruled at G-POL and nowhere else, by the seat `main`'s policy names
(`docs/decisions/0043-a-policy-change-is-ruled-under-the-policy-it-changes.md`).

## Inputs

```
sdlc policy set <key>=<value> [--set <key>=<value> …] [--unset <key> …]
  --question "..." --recommendation "..." [--name <proposal-name>] [--dry-run]
```

run from inside the project's working tree.

| Input | What it is |
| --- | --- |
| `<key>=<value>`, `--set <key>=<value>` | One change each: the key as a dotted path under `policy`, with or without the `policy.` prefix (`agents.backend`, `policy.gates.G3.holder`), and the value as YAML, read as the file would read it — `codex`, `5`, `true`, `[HIGH, CRITICAL]`, `{ backend: claude, egress: model }`. A map on the way to the key that does not exist yet is created. `--set` may be given any number of times. |
| `--unset <key>` | Removes a key that is set on `main`. A map the removal leaves empty is removed with it. |
| `--question`, `--recommendation` | The decision and what the proposer thinks the answer is, as for `sdlc propose`. |
| `--name` | The proposal's name, `^[a-z0-9][a-z0-9-]*$`. Left out, it is `policy-` and the first key's path joined by hyphens (`policy-agents-backend`), with `-2`, `-3`, … added while that name is taken. |
| `--dry-run` | Prints the page the proposal would open with, including the diff, and writes nothing. |

Only keys under `policy` are accepted. A key whose first part is not one of the block's own keys is
refused with the list of the ones that are, so `targets.<name>.base_url` or `project.name` cannot be
changed this way.

## Outputs

- The same as `sdlc propose` at G-POL (`docs/stages/propose.md`): a branch `proposal/<name>` from
  `main`, its page under `.sdlc/proposals/`, a run-record line, and one commit that also carries the
  changed `.sdlc/config.yaml`. The checkout is back on `main` afterwards and `main` is unchanged.
- The page opens with the question and the recommendation, then a table of each changed key with its
  value on `main` and the value proposed (*not set* where there is none), then a unified diff of
  `.sdlc/config.yaml` from `main` to the branch.
- On the terminal: `opened proposal/<name> at G-POL` and the diff; for `--dry-run`,
  `dry run: would open proposal/<name> at G-POL; nothing was written` and the page.
- A warning for each thing the `config` check warns about in the changed configuration that it did
  not already warn about on `main`.

**The rest of the file is kept as it was written.** The edit goes through the `yaml` library's
Document, which keeps comments, key order, quoting and flow maps, and a replaced value keeps the
comment beside it. The library writes a whole document in one style, and one setting pads flow maps
and flow sequences alike, so `[a, b]` would come back as `[ a, b ]`. So only the lines in which the
edited document differs from `main`'s document as the library writes it are taken from the library;
every other line is `main`'s own. Where the library's rendering of `main` does not match the file
line for line, or the result would not read as the edited document does, the library's rendering is
used whole, and the diff shows every line it rewrote.

## After it is opened

The proposal is ruled like any other G-POL proposal, from either seat: `sdlc rule <name>
approve|return --by <role>`, or `sdlc rule <name> --by agent:<persona>` / `rule --pending` where
G-POL is held by an agent. The seat is the one `main`'s policy names, not the one the proposal would
set. Approval merges the branch, and `main`'s configuration then carries the new values. A proposal
whose branch changes `policy` and was opened at any other gate is refused there
(`docs/stages/rule.md`); this command always opens at G-POL.

## Checks that block

Every one of these refuses before anything is written, so no branch or commit is left behind:

- `--question` and `--recommendation` are both required, and at least one change.
- Each `--set` is `<key>=<value>` with a non-empty value; to remove a key, `--unset` it.
- Each key is under `policy`. No key is named twice, and no key is inside another the same call
  changes (`agents` and `agents.model`).
- A `--set` that gives a key the value it already has on `main`, or an `--unset` of a key `main` does
  not set, is refused: the proposal would change nothing there.
- A key below something that holds a value rather than a map cannot be set.
- The changed configuration must pass the schema and the `config` check (`docs/stages/checks.md`) —
  an `agents.stages` entry for a stage with no agent turn, a ruling nobody makes, an `egress` naming
  no allowlist, a turn budget the runner would ignore. Every message is printed.
- The name is refused when a branch (local or on a remote) carries it or `main` holds its page or
  its gate file.
- Without `--dry-run`: the working tree is clean and on `main`.

## Exit criterion

Exits 0 having opened the proposal, or having printed it under `--dry-run`. Any refusal exits 1 with
its message.

## Re-run behaviour

Each run opens a new proposal. Running the same change again while the first is open opens a second,
under the next free default name; `--name` with a name in use is refused.

## Failure modes

- A refusal above: nothing written.
- `--dry-run` compares `HEAD`, the tree's status and every local branch before and after, and fails
  if any moved.
- `propose` failing after the configuration is written (a branch created by someone else between the
  name check and the commit): the file is put back to `main`'s and the error surfaces.

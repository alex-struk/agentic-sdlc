# Stage: `rule`

## Purpose

Record a verdict — `approve` or `return` — on an open proposal, checked against who is allowed to
hold that gate, and merge the proposal into `main` on approval. A gate whose `holder` in
`.sdlc/config.yaml` is `agent:<persona>` can also be ruled by that persona directly: a short
agent turn reads the proposal, the diff and the checks, and answers with a verdict the same way a
human's `--by` is trusted — phase 0 has no authentication either way (see
`docs/decisions/0003-caller-workflow-and-unauthenticated-roles.md`).

## Inputs

Human: `sdlc rule <name> approve|return --by <role> [--note "..."]`, run from inside the
project's working tree.

Agent: `sdlc rule <name> --by agent:<persona>` — no verdict is typed; the persona decides it.
`sdlc rule --pending` rules every open proposal (a `proposal/*` branch with no gate file yet)
whose gate is held by an agent, oldest branch first, and prints one line per ruling.

Typing a verdict together with `--by agent:<persona>` throws `an agent holder rules through its
own turn; omit the verdict, or rule as a human role` rather than running the agent's turn with the
typed verdict silently discarded: `sdlc rule <name> approve --by agent:<persona>` is rejected, not
dispatched.

## Outputs

On the proposal branch:

- `.sdlc/gates/<name>.yaml`: `gate`, `verdict`, `by`, `held_by` (`agent` or `human`, derived from
  whether `by` starts with `agent:`), `note`, `at`. An agent-held ruling replaces `note` with the
  persona's `rationale` and `conditions`, and adds `cost`, `turns` and `session` — what that
  ruling turn itself cost, the same three numbers a stage's journal entry records, which
  `site/index.md` totals as `Rulings cost`. A mandatory escalation records zeros, since it never
  asks the persona anything; a human ruling has no turn and carries none of the three.
- An appended `.sdlc/runs/<date>.md` entry.
- One commit, staging those two paths by name and nothing else.

On `verdict: approve` only: the working tree is checked out onto `main` and the proposal branch is
merged in with `--no-ff`, so `main` gains the gate file, the run-record entry, and a merge commit.
Two proposals opened on the same day both append to the same `.sdlc/runs/<date>.md`, which
`.gitattributes` marks `merge=union` so both sets of lines survive. If the merge fails anyway it
is aborted, the working tree is returned to the proposal branch, and the error names the
conflicted files — `main` is never left mid-merge.
On `return`, the proposal branch is left exactly as it is — not merged — so it stays open for
another round.

`sdlc status` (`buildSite`) runs after every ruling, human or agent, so the state site's gate log
and coverage numbers are never more than one ruling stale. The site is a tracked artifact:
`site/index.md`, `site/gates.md` and `site/runs.md` are folded into the same commit the ruling
made — the merge commit on `main` for an approval, the plain ruling commit otherwise — rather than
left as an uncommitted diff.

## The agent path

When `--by agent:<persona>` names the gate's own `holder`, `sdlc rule` builds a prompt out of:

- the persona brief, `.sdlc/personas/<persona>.md`;
- the proposal page;
- the tier — the proposal's own `tier:` front matter if it set one, else
  `policy.default_tier`;
- `git diff main...proposal/<name> --stat`;
- the diff of everything outside `app/` (`git diff main...proposal/<name> -- . ':!app'`), capped
  at 20,000 characters with a `[truncated]` marker so a large or generated diff cannot blow the
  prompt budget;
- the four structural checks, run on the proposal branch's current checkout.

The agent turn runs with `maxTurns: 12` and a tool list of `Read`, `Grep`, `Glob`, `Bash(git
diff*)`, `Bash(git log*)` and `Bash(git status*)` — enough to look further into the branch than
the diff in the prompt, and nothing that writes. `SDLC_STAGE=rule` also blocks every path in the
implement guard (`docs/stages/init.md`), so a ruling that tries to edit is stopped twice before
the clean-tree check below ever sees it. It must end its reply with one fenced JSON block and
nothing after it:

```json
{"verdict": "approve"|"return"|"escalate", "rationale": "...", "conditions": [...]}
```

Only the *last* such block in the reply is read, so anything the agent explored earlier in the
turn cannot be mistaken for its answer. A reply with no fenced JSON block throws `no verdict block
in persona reply`; a block that isn't valid JSON throws `bad verdict block: <parse error>`; a
`verdict` outside the three named values throws `bad verdict: <value>`; a verdict with no
non-empty `rationale` throws `verdict has no rationale`.

A turn that comes back reporting failure (an error result, the turn ceiling) has no verdict to
read, so it is rejected first of all with `ruling agent turn failed: <the turn's own text>`:
`parseVerdict`'s `no verdict block in persona reply` would otherwise be the error a person sees
for what is actually a failed session. Nothing has been written at that point — no gate file, no
commit — so the proposal branch and the working tree are exactly as they were.

Right after the agent turn returns and before its verdict is even parsed, the working tree is
checked for edits the turn left behind (`assertCleanTree`): a ruling is a read-only turn, and a
persona that edited files is rejected with `rule: the ruling agent modified the working tree`
rather than having its verdict trusted. The edit is left in place, not discarded, so it stays
visible in `git status` for a person to look at.

An `approve` or `return` verdict reuses the same gate-file-and-commit path a human ruling takes,
with `by: agent:<persona>` (so `held_by: agent`) and the persona's `rationale` and `conditions`
written into the gate file in place of a human's free-text `note`. The rationale and verdict are
also appended to the proposal page itself, under a `## Ruling` heading, *before* that page is
committed — so the ruling is part of the same commit the gate file is, not a follow-up.

## Mandatory escalation

Some proposals never reach the persona at all. Before asking, `sdlc rule` escalates on its own
when either is true:

- the proposal's tier is `HIGH` or `CRITICAL`;
- the persona's brief contains the phrase "always escalate", in any capitalisation (a persona can
  hold a gate and still always defer on it — see `templates/project/.sdlc/personas/tech-lead.md`,
  which always escalates a platform-article change). The match is against the whole brief, so the
  phrase appearing anywhere in it escalates **every** proposal at that gate, not only the ones the
  sentence it appears in describes: a brief that should defer on one kind of change and rule on
  the rest must say so in some other wording.

The gate file records `verdict: escalated`, `escalate_to: <the gate's escalate_to>`, and a
rationale beginning `mandatory escalation: <reason>`. The proposal branch is left open — nothing
is merged — and a run-record line is appended the same as for any other ruling.

An agent-decided `escalate` verdict (as opposed to a mandatory one) is recorded the same way, with
the persona's own rationale instead of the mandatory-escalation wording.

## Workspace the agent sees

The full project checkout, on the proposal branch — the same `cwd` the human commands operate on.
Nothing is materialised into a separate workspace for a ruling.

## Checks that block

- `verdict` must be `approve` or `return`.
- `--by` is required. It asserts a role and is not authenticated in phase 0: the check is that the
  role named holds the gate, not that the person running the command is that role (see
  `docs/decisions/0003-caller-workflow-and-unauthenticated-roles.md`).
- The working tree must be clean. A gate commit that swept in unrelated edits would make the
  record of a ruling untrustworthy, so `rule` refuses to start and lists the dirty paths.
- The branch `proposal/<name>` must exist.
- `.sdlc/proposals/<name>.md` must exist and its `gate:` front-matter line must be present.
- The project's configuration must load and validate.
- The named gate must exist in `policy.gates`.
- `by` must equal that gate's `holder` or `escalate_to`; anyone else is rejected, and the error
  names who is allowed.

For the agent path (`--by agent:<persona>` or `--pending`), the policy check is narrower: `by`
must equal the gate's `holder` exactly. A persona agent is never allowed to act as the
`escalate_to` target the way a human can — escalation targets are human roles by schema, so this
only ever rejects a persona ruling a gate it does not hold. An agent-held gate with no
`escalate_to` at all is rejected next, before the persona brief is read or any agent turn runs:
`gate <name> has an agent holder but no escalate_to`.

`--pending` rules each open, agent-held proposal in its own try/catch: one proposal's failure (a
bad verdict block, an escalation with no target) is printed and written to the run record, and the
loop moves on to the next branch rather than aborting the whole batch.

A failure that leaves the working tree dirty (an agent's turn tampering with a file) is different
and stops the batch instead of continuing. `git checkout -q main` succeeds even with uncommitted
changes present whenever the file is identical on both branches, so switching back to `main` to
carry on would carry the tampering onto `main` silently, and every later proposal in the batch
would then fail its own clean-tree check with a message pointing at the wrong ruling — and `main`
would be left dirty besides. So `--pending` checks the tree after any failure: if it is dirty, it
does not check out `main`, does not attempt the run-record commit (there is nothing clean to
commit it onto), and stops — no further proposals are ruled. The failure is still pushed into the
returned results, and the summary carries a `stopped: "<name>: working tree dirty after the ruling
agent's turn; inspect and clean before continuing"` entry. The checkout is left on the offending
`proposal/<name>` branch with the tampered file visible, for a person to inspect and clean up
before running `--pending` again.

## Exit criterion

Exits 0. Human path prints `<name>: <verdict> at <gate>`. Agent path prints `<name>: <verdict>` on
approve/return, or `<name>: escalated (<rationale>)` on escalation; `--pending` prints one such
line per proposal it rules.

## Re-run behaviour

Ruling the same name again overwrites `.sdlc/gates/<name>.yaml` and commits it on the proposal
branch, so a second `approve` does have something to merge: the fresh gate file, followed by
another merge commit on `main`. That is a second ruling on the same proposal, not a no-op, and
the gate log will show both. Treat a proposal as ruled once its verdict is recorded.

## Failure modes

- Bad verdict string, missing `--by`, or no such proposal branch: throws immediately.
- The proposal file is missing its `gate:` line: throws naming the proposal.
- The named gate is not in the project's policy: throws.
- `by` is not a listed holder or escalation target for that gate: throws, naming who is allowed.
- The working tree is dirty: throws before anything is checked out, listing the dirty paths.
- The approval merge conflicts: the merge is aborted, `main` is left as it was, the working tree
  returns to the proposal branch, and the error names the conflicted files.
- Agent path: the ruling turn reports failure: throws `ruling agent turn failed: <text>`, having
  written nothing. No persona brief at `.sdlc/personas/<persona>.md`: throws `no persona brief for
  <persona>`. The persona is not the gate's `holder`: throws naming who is (`is not a holder of
  <gate>`). The gate has no `escalate_to`: throws `gate <name> has an agent holder but no
  escalate_to`. The agent turn edited the working tree: throws `rule: the ruling agent modified
  the working tree` and leaves the edit in place. The reply has no fenced JSON block: throws `no
  verdict block in persona reply`. The block is not valid JSON: throws `bad verdict block: <parse
  error>`. The reply's `verdict` is not `approve`, `return` or `escalate`: throws `bad verdict:
  <value>`. The verdict has no non-empty `rationale`: throws `verdict has no rationale`.
- CLI: a verdict typed together with `--by agent:<persona>` throws `an agent holder rules through
  its own turn; omit the verdict, or rule as a human role` instead of running the agent's turn.

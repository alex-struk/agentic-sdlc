# 0037 · A check that was not read-only could not be used to check

Status: accepted · 2026-09-21

## Context

`sdlc run <stage> --dry-run` promises to write nothing — the module's own comments say so
— but two of the checks that ran ahead of the dry-run return committed to the repository
regardless of the flag. A failing pre-check appended a run record and committed it. An
already-open proposal at the stage's own gate did the same. Both are exactly the situation
a dry run exists to surface before a real run is spent, and both recorded themselves onto
`main` every time, dry run or not.

The effect: three stray commits landed on a real project's `main` from pre-flight checks
that were meant to be read-only. A dry run is what an operator runs to inspect what a
stage would do before spending a long turn on it — a pre-flight that mutates the branch it
is inspecting cannot be trusted as one, and the practice of pre-flighting before expensive
runs depends on it being trustworthy every time, not on average.

Why it went unnoticed: the dry-run early return sat, in source order, after both of these
checks. Whoever wrote each one had no signal that anything downstream depended on where it
sat — a pre-check failure and an open-proposal refusal are both ordinary early returns, and
nothing about either read as "this one has to stay behind the dry-run gate."

The same audit turned up two more instances of the same shape, neither yet observed in the
wild but reachable the same way:

- **A `with-sources` stage's workspace materialises before the dry-run return.**
  `ensureSources` clones another repository into the project directory the first time a
  `with-sources` stage runs. That is not a git write — it lands under a gitignored
  directory — but it is real, uninvited disk and network I/O that a preview has no
  business paying for, and it ran on every dry run of such a stage regardless.
- **`checkProposalNotOpen`'s own housekeeping ran unconditionally.** Finding an already-
  ruled proposal whose branch is still lying around, it prunes the spent branch with the
  safe `git branch -d` — a mutation, run whether or not the caller only wanted to look.

All four share one root: a write that assumed it would only ever be reached by a real run,
because at the time it was written that was the only way to reach it. Each was individually
reasonable. None of the four checked.

## Decision

### 1 — Every write ahead of the dry-run return is conditioned on the flag

The pre-check-failure commit and the open-proposal commit each now branch on `dryRun`
before touching disk or git: the identical finding is returned either way, and only the
non-dry-run branch appends a run record and commits it. `checkProposalNotOpen`'s branch
pruning is skipped the same way, reporting the same "not open" a real run would find
without deleting anything.

### 2 — Workspace materialisation moves to after the dry-run return

Nothing a dry run prints — the prompt, the skill path, the workspace mode, the MCP server
names, the env var names — depends on the workspace actually existing. Materialising it
(an archive of the committed tree for an ephemeral mode, a clone of another repository for
`with-sources`) is real work with no printed output to justify it on a dry run, so it now
runs only once the dry-run return and the sign-in pre-flight are both behind it — after,
not before, since a session that cannot sign in should not first pay for a workspace a
failed turn would throw away either.

### 3 — A structural guard, not just a returned position

Ordering fixes the four writes found today. It does nothing for the next one a future
change adds above the dry-run return, because a return statement carries no signal that
anything depends on its position. `assertDryRunUntouched` closes that gap the way a check
can: at function entry, when `dryRun` is set, it records `main`'s current commit; at every
point the function can return while a dry run is in effect, it re-reads the commit and the
tree's status and throws if either moved.

It does not *prevent* a write — nothing short of intercepting every git call generically
could, and that would hide the real invariant behind plumbing broad enough to also catch
every legitimate mutation a real run makes. What it buys is detection: a write introduced
ahead of a dry-run return by some later change fails a test immediately, inside the
function that owns the contract, naming what moved — rather than landing silently on a
real project's `main` for someone to find afterward, which is how the original defect was
found.

**What it does not cover.** A mutation outside the working tree and the currently checked
out branch — a ref created or deleted elsewhere in the repository, a file written outside
the project directory — passes the guard unseen, because neither `git status` nor
`rev-parse HEAD` would show it. `checkProposalNotOpen`'s branch pruning is exactly that
shape, which is why it is fixed at its source (§1) rather than left for the guard to catch.

## Consequences

- `sdlc run <stage> --dry-run` writes nothing and commits nothing on every path, including
  every failure path, and still reports what it found — a failed pre-check prints its
  failure, an open proposal names itself, both without being recorded.
- A `with-sources` stage's dry run no longer clones another repository; only a real run
  does.
- A regression of this shape — a write reintroduced ahead of a dry-run return — fails
  loudly in the function it belongs to, rather than shipping silently.
- The guard is scoped to `sdlc run`; a command that gains its own read-only mode later
  needs its own instance of the same idea, not a shared one — the invariant ("nothing
  observable changed") is general, but what counts as "observable" is specific to what the
  command touches.

## What was considered instead

**Only reordering the writes below the return, with no guard.** This is the shape that
produced the defect in the first place: a write that happens to sit in the right place
today, with nothing stopping a later change from adding a fifth one above it. Fixing the
four found writes without also closing the class they belong to would leave the next one
to be found the same way this one was — from stray commits on a real project.

**Intercepting every mutating git call generically, gated on a module-level dry-run flag.**
Rejected as too broad. Most of what `sdlc run` and the commands around it do is legitimate
mutation — proposing, ruling, merging — and a flag a real run has to remember to clear
before every one of those calls is the same fragile shape this record exists to move away
from, just relocated one layer down. The checks that misbehaved are a small, nameable set;
fixing them by name is more legible than threading a flag through the git layer.

**Checking cleanliness once, at the very end of `runStage`, instead of at each return.**
Considered, but `runStage` has more than one place a dry run can exit, each guarding a
different check. Asserting once at the end would report "something wrote" without saying
which check regressed; asserting at each return keeps the failure attributed to the code
path that caused it.

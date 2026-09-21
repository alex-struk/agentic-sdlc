# 0025 · A ruling gives the branch back

Status: accepted · 2026-09-20

## Context

`sdlc rule` borrows a branch. `openGate` checks the proposal's branch out, because everything
the ruling reads belongs to it — the proposal page, the config's gate block, the verify result,
the diff — and every path that finishes hands the branch back to the place its own verdict
belongs. An approval ends on `main`, where the merge put it. A return and an escalation end on
the proposal branch, checked out for whoever has to act on it.

A ruling that throws handed it back nowhere. A ruling turn failing twice on a transient
authentication error was how it was found, and the shape is not specific to that: a verdict
block the parser cannot read, a persona that is not a holder of the gate, a proposal with no
gate line, an approval refused for want of a passing verify result. Every one of those is
raised after the checkout, and every one of them left the caller standing on the proposal
branch.

**The cost lands on the next command, not on this one.** Every `sdlc run` asserts it starts on
`main` (`assertOnMain`), for the reasons `0012` sets out: a run started on a leftover proposal
branch branches off that branch, diffs against the wrong base, and carries the previous
proposal's changes into a new one as if they were its own. So the next command refuses, with an
accurate message about a branch, for a reason that has nothing to do with its own input — and
the operator diagnoses the command that reported the problem rather than the ruling that caused
it. `0012` recorded exactly this reading of a stranded tree, on a different route into it: a
batch that stopped where it stood reported a ruling agent that had not yet run as the cause.

This was an omission rather than a design choice. `fileOverreachRequests`, `fileAddressedRequests`
and `regenerateSiteOnMain` in the same file each step onto `main` and back through `finally`,
and say in their own comments that the caller is left where it was either way. `sandbox --from`
and `verify` borrow a branch through `enterBranch`/`leaveBranch` and unwind through `finally`
too. The one borrow that wrapped all of those had no unwind of its own.

## Decision

**A ruling that throws puts HEAD back where it found it.** `openGate` takes the branch through
`enterBranch`, which records what HEAD was pointing at — a branch name normally, a commit when
HEAD was already detached — and both seats, the human `rule` and the agent `ruleByAgent`, wrap
everything after it so that any throw unwinds through `leaveBranch` before it leaves. The
refusals `openGate` raises itself unwind the same way: they are about the proposal, not about
the branch, and a proposal with no gate line is no reason for the caller to lose its place.

**A successful ruling is untouched.** An approval still ends on `main` with the merge folded
into it; a return and an escalation still end on the proposal branch. The unwind is reached only
by a throw, so there is no path on which it decides where a verdict leaves the caller.

**A tree the ruling dirtied keeps HEAD on the branch that dirtied it.** `git checkout` succeeds
with uncommitted changes present whenever the file is identical on both sides and carries them
across, so a ruling turn that wrote to the tree — which `assertCleanTree` refuses, and which is
exactly when a ruling fails — would have its residue ride onto `main` and block every later
command on files nobody there touched. `leaveBranch` goes back only from a clean tree and hands
the residue to the caller instead, which is what `0012`'s stop depends on and what keeps the
tampering visible where it was made.

**A cleanup failure is a second fact, never a replacement for the first.** The failure that
reached the unwind is always what is thrown. A checkout that fails outright — a crashed git's
lock file is the ordinary cause — is reported on stderr, naming where HEAD actually is and what
the checkout said, and the ruling's own failure goes out untouched. A tree left dirty is
reported the same way. An operator who reads only the thrown error learns why the ruling failed;
one who reads the whole output also learns where the repository is standing.

**A failed merge no longer claims a branch.** `mergeApproved` unwinds a conflicted merge and
names the files to reconcile, as before, and no longer asserts which branch the caller is on:
where the caller is left is the unwind's to decide, and a message naming one of two places would
be wrong half the time.

## Consequences

- A ruling that fails costs the ruling and nothing else. The next `sdlc run` starts where the
  operator left it, and the first failure anybody reads is the one that happened.
- `rule --pending` is unchanged in the case it was built for. A ruling turn that dirtied the
  tree still leaves the batch standing on the offending branch with the residue visible, still
  stops rather than carrying it onto `main`, and still exits non-zero.
- Where a ruling fails on a repository that is standing somewhere other than `main` — the batch
  loop, mid-run — HEAD goes back to exactly that, not to `main`. Putting the caller somewhere it
  never was is the same defect from the other side.

## What was considered instead

**Restoring to `main` unconditionally.** It is what most callers want and it is a guess. A
command that borrows a branch owes the caller the tree it was given, and `rule --pending` is a
caller that is legitimately standing on a proposal branch when the next ruling starts.

**Putting the unwind in `rulePending` alone.** That is where the stranding was first noticed,
and it is not where it happens. A single `sdlc rule <name>` strands the operator exactly as
readily, and a fix in the batch would have left the seat a person actually uses unprotected.

**Appending the cleanup facts to the thrown error.** It puts them where a caller that records
the message — the batch's run record — would carry them, and it rewrites a failure somebody
else raised. The two facts have different owners: the ruling's failure belongs to the ruling,
and where HEAD is belongs to the command. `sandbox` and `verify` already separate them this way.

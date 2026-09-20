# 0012 · A batch never adopts a working tree it did not dirty

Status: accepted · 2026-09-20

## Context

`rule --pending` walks every open proposal branch, checking each one out to rule it. One
ruling turn misbehaving must not take the rest of the batch down, so a failure is recorded
and the loop moves on — except when the turn left the working tree dirty. Switching branches
with uncommitted changes present succeeds whenever the file is identical on both sides, so
the batch would carry those changes onto `main` silently. It therefore stops where it is,
holding the proposal branch open so the changes stay visible.

That reasoning is sound and it stands. What it did not account for is dirt the batch never
caused. The batch adopted whatever the caller left in the tree, failed the first ruling's own
clean-tree check on it, and stopped — now standing on a proposal branch it had no business
opening, reporting a ruling agent that had not yet run as the cause.

The consequence is not confined to that command. Every command that follows reads the tree it
was left on: `init` rewrote a stale branch's files and reported them as the project's, `git log`
showed that branch's history, and an approved plan appeared to have been reverted to a template.
Nothing was lost, because the proposal branch's ruling commits are its own and `main` never
moved, but the state a person reads to check that is the state the stranding corrupted.

## Decision

Three changes, all to `rule --pending`.

**The batch asserts a clean tree before it opens any branch.** Dirt found later in the loop can
then only have come from a ruling turn, which is the case the stop exists for. A caller who has
generated output lying around — a stale branch's `.gitignore` not covering a build directory is
enough — is told so on `main`, having lost nothing and moved nowhere.

**The stop names the branch it leaves the caller on**, and says how to get back. A message about
a dirty tree is not a message about where you are standing, and the second is what the next
command depends on.

**A batch that stopped exits non-zero.** It is holding a branch open and has not ruled the
proposals behind it. A zero exit reports that as a finished batch, and a caller that checks
exit codes — a script, a run under CI, a person reading the last line — cannot tell the two apart.

## Consequences

A batch has exactly one way to end off `main`, it is always the batch's own doing, and it says
so. The guard is deliberately at the batch rather than at every command that reads a tree: the
alternative, teaching each command to check which branch it is on, spreads one command's
invariant across all of them.

`rule --pending` now refuses to run on a dirty tree where before it would start and fail at the
first ruling. That is the intended change: refusing costs a `git status` the caller can act on,
where the old behaviour cost a stranded repository.

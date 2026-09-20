# 0014 · A build ruling is shown the build

Status: accepted · 2026-09-20

## Context

A persona's prompt has a fixed budget, so what fills it decides what can be ruled on. Paths
that are derived from the very work being ruled — the state site, the run record, the journal
— are excluded so they cannot consume it. `app/` was excluded alongside them, for a different
reason: the personas that hold the spec-side gates rule on the spec, and an implementation in
their diff is noise they should not be spending the budget on.

G3 holds both the spec-side derivations and, since the build stage exists, the build. A build
proposal is `app/` and almost nothing else. Its reviewer was therefore being handed the
proposal page, a file summary, the checks, and a diff containing only the decision records —
and returning an ordinary-looking ruling on an implementation it had never seen.

Nothing failed. That is the whole problem: a gate that rules on a summary of work nobody read
looks exactly like a gate that works.

The build's compiled output made it worse in the same direction. A first slice committed
4.1 MB of generated JavaScript and source maps against 449 KB of source; ordered by path,
`dist/` precedes `src/`, so even with `app/` included the budget would have been spent
entirely on output the reviewer has no reason to read.

## Decision

**`app/` is evidence exactly when the proposal is about it.** A proposal whose branch changes
anything under `app/` has it in the ruling diff, first; one that does not keeps the old
exclusion. Nothing needs to know which stage produced a proposal: a spec-side proposal never
touches the application, so the rule reads off the diff itself.

**A stack profile declares its own generated directories**, in an `ignore:` list in its front
matter, and `init` adds them to the project's `.gitignore`. The stack is what knows where its
toolchain writes; the pipeline's own required-ignore list stays about the pipeline's own
artifacts. Compiled output then never reaches a proposal at all, where it is not evidence and
is large enough to push the code out of the diff.

## Consequences

A build ruling is made on the build. The spec-side gates are unchanged.

A project on a stack whose profile declares nothing keeps whatever its team put in
`.gitignore`; the pipeline adds no guesses of its own about directory names.

The ordering rule — `app/` first for G3 — decides what survives the cap, not what is shown at
all. A build large enough to overflow the budget still gets cut, marked, with the application
ahead of the decision records rather than behind them.

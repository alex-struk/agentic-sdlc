# 0066 · A contract proposal carries its derived files

Status: accepted · 2026-09-27

## Context

`tests/generated/*` — the page, persona and seed types every acceptance test imports — is derived
from the contract (`spec/contract/*.yaml`) and the seed manifest by `writeGenerated`
(`src/spec/surface.mjs`). The `generated` check (`src/checks/generated.mjs`) recomputes it and
fails wherever the files on disk disagree, in any project that has generated them.

Only `derive-tests` wrote those files, in its own workspace before its turn. A `contract` proposal
that adds a page or a seed record changes what they should say and carried none of it, so its
approval put a contract on `main` that `main`'s own derived files disagreed with. `sdlc checks`
then failed on `main`, and the next contract proposal — which had touched none of it — was the
one a G1 ruler saw failing and returned.

## Decision

**The contract stage regenerates `tests/generated/*` from its own contract after the agent's
turn, and its proposal carries the result.** A stage hook, `beforePostChecks`, runs in
`finishStage` after the turn and before the post-checks, and again after every repair turn, so
the files the checks judge and the proposal commits are always derived from the contract as the
run leaves it. Only in a project that already has `tests/generated/`: before `derive-tests` has
run there is nothing for the check to judge, and a contract that does not load is left for
`contract-loads` to report rather than regenerated from.

**The agent does not write them.** The guard's row for `contract` stays as it is; the runner
writes the files, and `contract-scope` allows `tests/generated/` because the runner changed it.

**Contract's post-checks include `generated`.** Regeneration makes a mismatch impossible, so the
check fails only on something regeneration cannot fix — a file under `tests/generated/` the
generator never writes, or a contract that does not load — and it fails the run rather than
opening a proposal G1 would find failing.

**A returned contract's draft does not import its derived files.** The run answering a return
applies the returned branch's changes to the contract, the seed and the oracle override
(`0064`), and regenerates `tests/generated/*` afterwards like any other contract run. Carried over,
the branch's derived files could only conflict with `main`'s, which may have moved since, and
refuse a draft whose contract applies cleanly.

`derive-tests` keeps regenerating in its workspace before its turn, from the committed contract.
On a project whose contract proposals carry their derived files, that regeneration changes
nothing; it remains what gives a blind session its types.

## Alternatives

**Regenerate on `main` when a contract proposal is approved.** It puts a change on `main` that no
gate saw, and a person approving by hand would need the same step. A proposal that carries the
files is ruled on as it will land.

**Regenerate on every contract run, whether or not the project has generated anything.** Every
first contract proposal would then carry test types before any test exists, for a check that does
not yet apply.

**Let the agent write them.** The agent would be asked to reproduce, by hand, output a function
produces exactly.

## What would reverse it

`tests/generated/*` ceasing to be committed — generated at the point of use instead — would remove
the files this keeps in step, and the hook with them.

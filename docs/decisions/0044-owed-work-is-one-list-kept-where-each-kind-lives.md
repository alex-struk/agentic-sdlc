# 0044 · Owed work is one list, kept where each kind already lives

Status: accepted · 2026-09-24

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

`0042` decided that everything the pipeline owes itself across runs — conditions, cross-stage
requests, re-derivations, rebinds, recoveries, and later missing tests — is one mechanism with one
entry shape and a kind. Five kinds were in use, each with a module and a file of its own:

| Kind | File |
|---|---|
| condition | `.sdlc/conditions.yaml` |
| request | `.sdlc/revision-requests.yaml` |
| redo | `tests/acceptance/redo.yaml` |
| rebind | `tests/adapters/rebind.yaml` |
| recovery | `spec/recovery.yaml` |

They shared a shape and no code, and they closed an entry four different ways: a condition gained
`closed`, a request gained `taken`, a recovery gained `answered`, and a redo or rebind entry was
deleted. Deleting is the one that matters here, because it throws away how many times an item was
sent, and four of these kinds are loops the design bounds (`docs/specs/` §7.1: "2 attempts, then
human") that the engine did not bound at all.

Existing projects hold real entries in four of these files, and a project's files are changed only
by the pipeline's own commits. Whatever the storage became, those entries had to go on reading
exactly as they did.

## Decision

**One module, `src/spec/owed.mjs`.** Every entry of every kind is read into one shape: `kind`,
`item` (what is owed), `stage` (who owes it), `why`, `from`/`gate`/`by`/`at` (who opened it at which
ruling, where the kind records it), and `closed` (`{ outcome: met | withdrawn, why, by, at }`, where
`why` is the evidence for `met` and the reason for `withdrawn`). A kind's own fields — a redo's
criterion version, a rebind's target, a recovery's domain — sit beside those. The module opens
entries, reads them from the working tree or from `main`, lists what is open for a stage or for a
line of work, closes them, settles a round whole, and counts how many times an item has been sent.
Every reader and writer goes through it; the five per-kind modules are gone.

**Each kind keeps its file.** The module maps between the one shape and each kind's stored shape,
and writes back exactly the fields the kind has always stored. A kind with no file of its own is
stored in `.sdlc/owed.yaml` in the entry shape itself, so a new kind — a missing test (`0042`) —
needs no code in the module.

**What each kind keeps of its own is kept.** A condition is never a reason to start a run (`0032`);
only a request opens a `--revise` run with no returned ruling behind it. A request is marked taken
and cannot be withdrawn. A redo entry carries the criterion's version and the ruler's words
verbatim. Closing anything needs evidence or a reason, and each kind accepts only the outcomes it
had: conditions may be met or withdrawn, the others only met — except that any kind bound to a
criterion is also withdrawn, by the runner, once that criterion is retired (`0052`).

**Nothing is removed.** A redo entry is closed by the `derive-tests` run that answers it and a rebind
entry by the `calibrate` run that finds its adapter changed, and both stay on file. An item sent
again is a new entry. The count of sends is every entry ever filed for the item, with the requests
one ruling files together counted once, since they are halves of one observation. A request's item
is the stage asked and the line of work asking, so one line of work sending a stage back again and
again is one item sent several times.

**The four loops are bounded in policy.** `policy.loops.rebind`, `.redo`, `.recovery` and `.request`,
two by default, each optional. A run handed an item sent more times than its limit still runs, and
the proposal it opens is escalated by the runner (`runner:<stage>`) to its gate's escalation target
through `escalateOnBranch`, with every reason the item was sent for. A pre-check refuses the run
when that gate names no escalation target. Conditions are not bounded: each rides on a return, and a
line of work returned too often is a ruler's to escalate.

A project's lists hold the sends that were still on file when this was built; a send whose entry
had already been deleted is not counted.

## Alternatives

**One file, migrated by the pipeline.** A single `.sdlc/owed.yaml` with every kind in it is the
literal reading of "one list". It needs a migration commit in every project, made by the pipeline
the first time it touches the project, and a reader for the old files until every project has
had one. It also moves five paths that other rules name: archaeology refuses a run that writes to
`spec/recovery.yaml` anything but the runner's stamp, the tests check allows `redo.yaml` among
`tests/acceptance/`'s own files, `derive-tests` reads the shared `redo.yaml` into its workspace, and
the stage hook allows or refuses each path per stage. Each would be reworked for a gain callers
already have from the module: one way to read and write owed work.

**Read both, write one.** Leave the old files readable and write new entries to one file. Every
kind then has two sources, a precedence rule between them, and a state — a closure written to the
new file for an entry opened in the old — that neither file reads correctly on its own.

**Escalate where the item is sent back.** Verify escalates the return that reaches its limit. Here
the sender is usually an approved ruling that a stage applies later (a triage, a `test-wrong`, a
`recovery-wrong`), which has no verdict left to change, or a ruler's return, whose verdict the
runner would be overriding. The owing stage's proposal is where the next attempt is judged, and it
is where ratify's follow-up limit escalates too.

**Do not run the stage past the limit.** Hold the item back and open a question for the escalation
target instead. The item is still owed and only that stage can do it, so the question's only useful
answer is "try once more", which would need a ruling meaning of its own. Escalating the attempt puts
the work and its history in front of the escalation target together.

## What would reverse it

A kind whose storage the module cannot map without changing what the kind stores would argue for
moving that kind into `.sdlc/owed.yaml`, through a migration the pipeline commits. A project in
which the escalation target routinely approves attempts past the limit is evidence the default is
too low for that project, which is what the key is for.

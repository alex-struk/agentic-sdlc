# Stage: `build`

## Purpose

Build one slice of `plan/tasks.md` — the application code that answers its listed criteria, and
nothing else — and open the result at gate G3 as a build proposal. A build proposal is not ruled on
its own: `verify` has to run the acceptance suite for the slice's criteria against a sandboxed
instance of the application first, and the reviewer's ruling is refused without that result
(`docs/decisions/0011-build-verify-review.md`).

The workspace carries no acceptance suite and no adapter, so a build cannot see the tests it will
be judged by, only the criteria they were derived from. What it is checked against is decided once,
by `verify`, after the turn ends — the same blindness argument `design`'s workspace rests on.

It holds gate G3, ruled by the reviewer persona — the same gate `bind-adapter` and `derive-tests`
hold.

## Inputs

`sdlc run build --slice <n> [--revise] [--dry-run]`, run from inside the project's working tree, on
`main`. `<n>` has to name a slice `plan/tasks.md` actually defines; a slice number the plan does
not have fails before any workspace is built.

`--revise` rebuilds from a returned ruling instead of starting fresh: across every build proposal
already opened for this slice (`build-slice-<n>`, `build-slice-<n>-2`, ...), newest first, it looks
for one whose own branch carries a `return` gate file — written either by a reviewer's ruling or by
`verify` itself (0011 §2) — and revises from that one. No returned ruling for the slice fails the
pre-check with `build --revise: no returned ruling for slice <n> to revise from`.

Once found, the returned gate file (and proposal page, if there is one) is copied onto `main` and
the spent branch is kept, renamed to `returned/<name>` — the revision's workspace overlays `app/`
and `docs/decisions/` from that branch's own commit on top of the ordinary archive, so the agent
finds the application exactly as the returned proposal left it, plus the ruling that returned it
and its conditions, quoted into the prompt: "This is a revision. The application as the returned
proposal left it is already under app/; change what the ruling below names and leave the rest."

## Workspace

`build`: a temporary directory, `git archive HEAD` over `app`, `plan`, `spec`, `design`,
`docs/decisions`, `tests/seed`, `constitution.md` and `.claude/skills` — committed content only, so
an uncommitted edit never leaks in and never appears there. No `tests/acceptance` and no
`tests/adapters`: a build that could read the tests it will be judged by would be a build written
to satisfy them rather than the criteria. This is the one ephemeral workspace mode allowed to see
`app/` at all — every other mode is refused it, on pain of `blindness violated: app/ present in
<mode> workspace`.

Only `app` and `docs/decisions` are collected back into the project once the turn ends, and they
are the only paths a build may write at all. The rest of the workspace — `plan/`, `spec/`,
`design/`, `tests/seed/`, `constitution.md`, `.claude/skills/` — is sealed: it is there to be read,
and a change to any of it ends the run with the paths named rather than being dropped when the
workspace is torn down (`docs/decisions/0027-a-run-that-fabricated-success.md`). A condition asking
a build to move a criterion between slices is asking it to write `plan/`, which is the plan stage's
to deliver; `sdlc rule` refuses such a condition when the ruling is made.

## Outputs

- Application code under `app/`, and any `docs/decisions/` record the slice's build needed for a
  choice a later reader would otherwise have to reverse-engineer.
- A proposal at gate G3: `build-slice-<n>` the first time, or the next free number in that family
  after a prior ruling — holding the question "Does slice `<n>` (`<title>`) do what its criteria
  say?" and a recommendation taken from the agent's own journal text.
- A journal entry and a run-record line, as every stage produces.

## Checks

**Pre-checks.**

- `build-slice` — `--slice <n>` is given and `plan/tasks.md` defines it.
- `build-revise-source` — on `--revise`, a returned ruling exists for the slice to revise from;
  skipped on an ordinary run.

**Post-checks**, run against the project's working tree after `app` and `docs/decisions` are
collected back:

- `separation` (`checkSeparation`) — the project's `tests/adapters` and `tests/acceptance` still
  keep their blindness rules. A build changes neither, but the check runs the same way it does for
  every gated stage that could have.
- `build-scope` (`checkBuildScope`) — every path the run actually changed is under `app/`,
  `docs/decisions/`, or the pipeline's own `.sdlc/journal|runs|proposals`; anything else fails,
  naming the path (`<path>: a build changes only app/ and docs/decisions/`).
- `app-check` (`appCheck`) — `app/package.json` exists and names a `check` script, `npm --prefix
  app install` succeeds, and `npm --prefix app run check` (the stack's own typecheck and unit
  tests) passes. The runner runs this itself rather than trusting what the builder reported: a
  proposal is answerable for what the runner saw, not what the builder said it saw.

## What this stage does not do yet

It does not run the acceptance suite against what it built. That is `verify`'s job, against a
sandboxed instance of the application, once the proposal is open (`docs/stages/verify.md`). A build
proposal with a clean `app-check` and correct scope can still fail verify, and that is the ordinary
way a slice comes back for `--revise`.

# Stage: `verify`

## Purpose

Run the acceptance suite for one slice's criteria against a real, running instance of the rebuilt
application, and record what happened on the build proposal's own branch. A slice's build proposal
is not answerable to the reviewer until this has run: ruling a `build-slice-<n>` proposal — outside
an escalation — is refused until `tests/results/new/slice-<n>.json` says `pass` against the exact
application the proposal branch carries (`buildVerified`, `src/commands/rule.mjs`).

There is no agent turn: `verify` carries `agent: false`, the same as `calibrate`. Running a suite
and writing its own verdict onto a branch needs no judgement; the judgement a failing row still
asks for happens at the gate it is returned to, not here.

## Inputs

`sdlc run verify --slice <n>`, run from inside the project's working tree. It reads:

- The open build proposal for the slice — the newest `build-slice-<n>[-k]` branch with no gate file
  on it yet. None fails the pre-check, naming `sdlc run build --slice <n> first` as the next step.
- `SDLC_SANDBOX_PASSWORD` in the environment, where the `new` target's identity is `sandbox-idp`.
  The pre-check reads only whether the variable is set — never its value, which is passed to compose
  by environment alone and never printed, logged or written to a file.
- The slice's own text and claimed criteria, from `plan/tasks.md`.
- `tests/acceptance/<domain>/<id>.spec.ts` for each criterion the slice claims.

## What `execute` does, in order

1. **Check out the build proposal's branch** (`proposal/<name>`) — verify runs against exactly the
   code that branch carries, not against `main`.
2. **Bring the sandbox up** against target `new` (`sandboxUp`, `docs/stages/sandbox.md`): the
   project's own compose file, built, started, health-checked and reseeded. A sandbox that will not
   start ends the run there, reporting why, with nothing recorded.
3. **Run the acceptance suite** for the slice's spec files against the running sandbox, then keep
   only the rows for criteria the slice actually claims. A slice with no spec files at all runs
   nothing: an empty file list means "nothing to run", not "no filter", so a slice whose criteria
   are all not-testable — or whose tests have not been derived yet — never costs a full suite run.
4. **Classify the result** (`verifyVerdict`): every claimed criterion is looked up by id.
   - `unbound` — every criterion whose adapter binding does not exist on `new` is set aside
     separately.
   - Anything else that is not `pass`, `not-testable` or `attested` — a `fail`, a `stale` test, or
     a criterion missing from the run altogether — counts as failing.
   - The verdict is `fail` if anything failed, `unbound` if nothing failed but something is
     unbound, otherwise `pass`.
5. **Write the result file**, `tests/results/new/slice-<n>.json` —
   `{ slice, proposal, app_tree, at, verdict, rows }`. `app_tree` is the commit the branch's `app/`
   tree hashes to, which is what `buildVerified` compares against later, so a ruling cannot be given
   on the strength of verify evidence about a version of the application the proposal no longer
   carries.
6. **On `fail`, return the build proposal.** `.sdlc/gates/<name>.yaml` is written with
   `verdict: return`, `by: runner:verify`, `held_by: runner`, and one condition per failing
   criterion (`<id>: <its first error>`) — the same gate-file shape a reviewer's own return would
   leave, so `build --slice <n> --revise` reads either one the same way
   (`docs/decisions/0011-build-verify-review.md`). The third such return for this slice
   (`MAX_VERIFY_RETURNS`) escalates instead: `verdict: escalated`, `escalate_to` set to whoever
   `policy.gates.G3.escalate_to` names (the tech lead, in the default policy), naming that the
   failures below may not even be the application's to fix. Only verify's own returns
   (`by: runner:verify`) count toward that third strike; a reviewer's return of the same proposal
   does not.
7. **On `unbound`, report and stop.** Nothing is written to a gate file; the next step is
   `sdlc run bind-adapter --target new`, then verifying again.
8. **On `pass`, report ready for G3.** Nothing else is written; the reviewer can now rule the build
   proposal.
9. **Commit the result** — and the gate file, on a `fail` — onto the proposal branch, then tear the
   sandbox down and check back out to the branch verify started from.

Teardown happens whatever the outcome, and it is teardown only: an exception on its way out of the
stage is never swallowed. A verify run that throws part-way through fails the whole `sdlc run`
rather than reporting a no-op the runner would finish by committing the half-written residue onto
the proposal branch.

## Outputs

- `tests/results/new/slice-<n>.json`, on the proposal's own branch, committed as
  `verify(slice <n>): <verdict>`.
- `.sdlc/gates/<name>.yaml`, only on a `fail` verdict — `return`, or on the third such return for
  the slice, `escalated` naming G3's `escalate_to`.
- A run-record line, on every attempt — including one that failed part-way and one that left the
  branch dirty.
- No gate of its own on `pass` or `unbound`: nothing is asked of a person until either the reviewer
  rules the proposal, or the third failure's escalation reaches G3's `escalate_to`.

## The verdict table

| Result | Route | Gate file written |
| --- | --- | --- |
| `pass` | Ready for G3 — the reviewer can now rule the build proposal. | None. |
| `fail` (1st or 2nd time for the slice) | Returned to `build`: `sdlc run build --slice <n> --revise`. | `verdict: return`, `by: runner:verify`. |
| `fail` (3rd time running) | Escalated — a fourth build is unlikely to find what three did not. | `verdict: escalated`, `escalate_to` from `policy.gates.G3`. |
| `unbound` | `sdlc run bind-adapter --target new`, then verify again. | None. |

## Checks

None beyond the classification above: `postChecks` returns nothing and `verify` opens no proposal
of its own — it writes onto one that already exists.

## Failure modes

- **No open build proposal for the slice**: the pre-check fails, naming `build --slice <n>` as the
  step to run first.
- **`SDLC_SANDBOX_PASSWORD` unset for a `sandbox-idp` target**: the pre-check fails before anything
  is started. Without it every test in the slice fails at the sign-in form, and verify would read a
  suite of sign-in failures as the application's fault and return the slice to a builder that
  cannot fix an environment defect.
- **The sandbox does not start**: reported in the run's own text; nothing is written and the branch
  is left exactly as it was.
- **A throw leaves the branch dirty** — between the result write and the commit landing: verify
  does not check back out to the branch it started from, writes its run-record line where it
  stands, and the run fails with a message naming the branch HEAD was left on. The dirty branch is
  left exactly where the failure happened, visible in `git status`, rather than being carried onto
  `main`, where a dirty tree would block every later `sdlc run` until a person cleaned it up by
  hand — the same hazard `rule --pending` guards against for the same reason.
- **The sandbox will not stop**: reported as the run's failure — containers left running
  is a real problem — but it never replaces a failure already on its way out of the run,
  and never skips the rest of the teardown, which is what decides where HEAD is left.
- **A throw that leaves the tree clean**: the sandbox is still torn down, HEAD still returns to the
  branch verify started from, and the run record's line for the attempt is committed there before
  the error is re-raised — so the failure is loud and the next `sdlc run` is not blocked by an
  uncommitted record.

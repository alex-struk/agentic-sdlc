# Stage: `verify`

## Purpose

Run the acceptance suite for one slice's criteria against a real, running instance of the rebuilt
application, and record what happened on the build proposal's own branch. A slice's build proposal
cannot be *approved* until this has run: an approval on a `build-slice-<n>` proposal is refused
until `tests/results/new/slice-<n>.json` says `pass` against the exact application the proposal
branch carries (`buildVerified`, `src/commands/rule.mjs`). Returning or escalating it is held to
nothing — neither asserts anything about the application — and the target of a standing escalation
may approve without a passing result, which the escalation on the branch is the record of
(`docs/decisions/0022-a-guard-that-stopped-the-failure-being-recorded.md`).

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
- `policy.gates.G3.escalate_to`, the role a slice goes to once it reaches the return limit. A G3
  with none fails the pre-check: verify has nowhere else to send a slice, and a role it chose
  itself may not exist in the project.
- `policy.loops.verify_returns`, the return limit, three when the key is absent.
- The slice's own text and claimed criteria, from `plan/tasks.md`.
- `tests/acceptance/<domain>/<id>.spec.ts` for each criterion the slice claims.
- `targets.new.mail_api`, the address the new target's mail catcher answers its API on. It is
  handed to the suite as `SDLC_MAIL_API`, the way `calibrate` hands on the oracle's. A target
  that declares none gives the suite none.
- `spec/contract/observables.yaml`'s `configurations:`, for the tags of tests written for a
  configuration the target reads at start-up
  (`docs/decisions/0071-a-configuration-gets-its-own-oracle.md`).
- `tests/adapters/rebind.yaml` on `main`, and `policy.loops.rebind`, for the unbound rows a binding
  run is owed for (`src/spec/unbound.mjs`).

## What `execute` does, in order

1. **Check out the build proposal's branch** (`proposal/<name>`) — verify runs against exactly the
   code that branch carries, not against `main`. HEAD goes back where it was found afterwards
   (`enterBranch`/`leaveBranch`, `src/lib/git.mjs`).
2. **Merge `main` into that branch** (`merge(verify): main into proposal/<name> before slice <n>`).
   The branch was cut when the slice was built and `main` has moved since: an adapter ruled at G3
   in the meantime is on `main` and nowhere else, and so are the fixtures, the generated surface
   types, the seed and the ratified criteria index. Without this the suite runs against a test rig
   the project no longer has — and where the missing piece is the adapter, reports the same
   criteria `unbound` for ever, since the `unbound` route writes no gate file for `build --revise`
   to read and the open proposal blocks a fresh `build`
   (`docs/decisions/0016-binding-and-verifying-an-unmerged-proposal.md`). A merge that conflicts is
   undone, and ends the run: see "Checks" below.
3. **Bring the sandbox up** against target `new` (`sandboxUp`, `docs/stages/sandbox.md`): the
   project's own compose file, built, started, health-checked, checked service by service, and
   reseeded. A sandbox that will not start ends the run there. Which way it ends depends on the
   `cause` the result carries: `application` returns the build proposal, `environment` halts with
   nothing recorded — see "A sandbox that will not start" below.
4. **Run the acceptance suite** for the slice's spec files against the running sandbox, with the
   target's mail catcher as `SDLC_MAIL_API` and every configuration's tag left out
   (`--grep-invert`), then keep only the rows for criteria the slice actually claims. Nothing
   starts the sandbox in a configuration, so a test written for one would run against the default
   and fail there. A slice with no spec files at all runs
   nothing: an empty file list means "nothing to run", not "no filter", so a slice whose criteria
   are all not-testable — or whose tests have not been derived yet — never costs a full suite run.
5. **Classify the result** (`verifyVerdict`): every claimed criterion is looked up by id.
   - `unbound` — every criterion whose adapter binding does not exist on `new` is set aside
     separately.
   - An environment gap — a criterion this environment could not test — is set aside with its
     reason. That is a criterion whose every failing test stopped at the mail fixture for want of
     a mail catcher (`SDLC_MAIL_API is not set`), and a criterion whose test is written for a
     configuration, left out of the run in step 4.
   - `not-testable` and `attested` — the two results that settle a criterion without the
     application being asked anything (`src/testrun/results.mjs`) — are set aside as never
     asserted, with the reason each carries.
   - Anything else that is not `pass` — a `fail`, a `stale` test, or a criterion missing from the
     run altogether — counts as failing.
   - The verdict is `fail` if anything failed, `environment` if nothing failed but something
     could not be tested here, `unbound` if nothing else stands but something is unbound,
     `pass-unasserted` if nothing failed and something was never asserted, and `pass` only where
     every criterion the slice claims was put to the application and met.
6. **Write the result file**, `tests/results/new/slice-<n>.json` —
   `{ slice, proposal, app_tree, at, verdict, rows }`, plus `unasserted` — one
   `{ id, result, reason }` per criterion nobody asserted — whenever there is one, `environment`
   and `unbound` — one `{ id, reason }` per criterion of each — whenever there is one, and
   `adapter`, the tree of `tests/adapters/new` the suite drove with.
   `app_tree` is the commit the branch's `app/`
   tree hashes to, which is what `buildVerified` compares against later, so a ruling cannot be given
   on the strength of verify evidence about a version of the application the proposal no longer
   carries.
7. **On `fail`, return the build proposal.** `.sdlc/gates/<name>.yaml` is written with
   `verdict: return`, `by: runner:verify`, `held_by: runner`, and one condition per failing
   criterion (`<id>: <its first error>`) — the same gate-file shape a reviewer's own return would
   leave, so `build --slice <n> --revise` reads either one the same way
   (`docs/decisions/0011-build-verify-review.md`). The return that reaches the project's limit
   (`policy.loops.verify_returns`, three by default) escalates instead: `verdict: escalated`,
   `escalate_to` set to whoever `policy.gates.G3.escalate_to` names, naming that the failures
   below may not even be the application's to fix. Only verify's own returns
   (`by: runner:verify`) count toward the limit, across every cause verify returns a build for;
   a reviewer's return of the same proposal does not, and neither does a return whose every
   condition is an environment gap. The count starts again after a person returns the slice: the
   returns before that ruling are the ones the person answered, and only verify's returns on
   later proposals count. An agent seat's return does not reset it
   (`docs/decisions/0076-a-person-s-return-resets-the-verify-count.md`). The conditions are the failures alone: an environment gap or
   an unbound row beside them is named in what is printed and never made a condition.
8. **On `environment`, report and stop.** Nothing is written to a gate file and nothing counts
   toward the return limit: nothing the builder can change would test these criteria. What is
   printed names each criterion with its reason. A missing mail catcher is one line of
   configuration — `targets.new.mail_api`, the address the application's own compose file
   publishes its mail catcher's API on — after which the slice is verified again. A test written
   for a configuration waits on G3's ruler, since verify cannot start the new target in one.
9. **On `unbound`, report and stop.** Nothing is written to a gate file. What is printed depends
   on whether `tests/adapters/new/index.ts` exists and, where it does, on whether a binding run is
   still owed for the rows.

   With an adapter in place, every unbound row among the slice's criteria is settled on `main`,
   once the tree is back there, against the rebind entries in `tests/adapters/rebind.yaml`, by
   the same rules a calibration settles the oracle's (`src/spec/unbound.mjs`): a row is filed for
   `bind-adapter --target new`, stamped `by: runner:verify` and with the slice, while the binding
   has been sent for it fewer times than `policy.loops.rebind` allows; an entry for one of the
   slice's criteria found under an adapter that has since changed lapses, and one whose row the
   adapter now reaches is closed. Nothing about another slice's criteria is touched. The rows are
   filed whatever the verdict, so an unbound row beside a failure is owed to the binding as well.

   An adapter written before the slice built what its tests need — bound against the application
   it replaces, or an earlier cut of this one — names what it found then, so a row it reports
   unbound is the binding's gap and not the build's. Where the binding is owed, what is printed is
   the adapter's reasons and the whole sequence binding against this proposal takes (below),
   ending with the verify that closes each row the new binding reaches.

   Where the binding has been sent as often as `policy.loops.rebind` allows, or the row needs a
   persona the approved contract marks unavailable, binding again would drive the same application
   and write the same reasons. Each adapter's own reason is quoted — it is the only place in the
   pipeline that reason is written down — and three exits are offered, and all three are rulings: return the build proposal at G3 with those reasons
   as the conditions, so `build --slice <n> --revise` takes them on; return it with
   `addressed-to plan: <why>` among the conditions, if the surface belongs to a later slice, so
   `plan --revise` cuts what the slice claims again and the architect rules the result; or, where a
   criterion is right and the test derived from it reaches past it, return the proposal with
   `test-overreaches <ID>: <why>` among the conditions (`docs/stages/rule.md`, "A test that reaches
   past its criterion" and "A condition whose work belongs to another stage").

   With no adapter, or with a binding owed, what is printed is the whole sequence binding takes,
   with the proposal branch's name filled in:

   ```
   sdlc sandbox up --target new --from proposal/<name>
   sdlc run bind-adapter --target new
   # rule the bind-adapter proposal at G3 — the adapter lands on main
   sdlc sandbox down --target new --from proposal/<name>
   sdlc run verify --slice <n>
   ```

   The application exists on that branch alone until the build proposal is ruled, and
   `bind-adapter` refuses a target that is not answering, so `bind-adapter` named on its own is a
   step that cannot run. The last line picks the ruled adapter up because of step 2 above
   (`docs/decisions/0016-binding-and-verifying-an-unmerged-proposal.md`).
10. **On `pass`, report ready for G3.** Nothing else is written; the reviewer can now rule the build
   proposal. On `pass-unasserted` the same is true of the route, and what is printed says how many
   of the slice's claimed criteria were asserted and met, names the ones that were never asserted
   at all, and quotes the reason recorded for each. The sentence reserved for `pass` — every
   claimed criterion passes against the application — is printed only where that is true of every
   row.
11. **Commit the result** — and the gate file, on a `fail` — onto the proposal branch, then tear the
   sandbox down and check back out to the branch verify started from. The rebind entries of step
   9 are written there, on `main`, and committed with the run's own record.

Teardown happens whatever the outcome, and it is teardown only: an exception on its way out of the
stage is never swallowed. A verify run that throws part-way through fails the whole `sdlc run`
rather than reporting a no-op the runner would finish by committing the half-written residue onto
the proposal branch.

## Outputs

- `tests/results/new/slice-<n>.json`, on the proposal's own branch, committed as
  `verify(slice <n>): <verdict>`.
- `.sdlc/gates/<name>.yaml`, only on a `fail` verdict — `return`, or on the return that reaches
  the limit, `escalated` naming G3's `escalate_to`.
- A merge commit on the proposal's branch, whenever `main` has moved since the branch was cut.
- A run-record line, on every attempt — including one that failed part-way and one that left the
  branch dirty.
- On `main`, `tests/adapters/rebind.yaml` entries for the slice's unbound rows, filed, lapsed or
  closed as step 9 says.
- Nothing else on the owed list. A row showing a missing test's test ran is evidence the G3 approval of
  the slice reads: that approval closes the item, citing the row (`docs/stages/rule.md`, "A test a
  criterion is owed"). A criterion recorded untestable is a `not-testable` row here as it always
  is, and while its missing test is open G3 does not approve the slice unless the ruling withdraws
  it (`policy.gates.G3.block_on_missing_tests`). An `attested` row closes nothing.
- No gate of its own on `pass`, `pass-unasserted`, `environment` or `unbound`: nothing is asked of a person until
  either the reviewer rules the proposal, or the escalation at the return limit reaches G3's
  `escalate_to`.

## The verdict table

| Result | Route | Gate file written |
| --- | --- | --- |
| `pass` | Ready for G3 — the reviewer can now rule the build proposal. | None. |
| `pass-unasserted` | Ready for G3, saying which criteria were never asserted against the application and why. Whether the slice may be approved on that footing is the reviewer's, and the ruling prompt carries the same rows and reasons, unless the project's `policy.gates.G3.approve_unasserted` is false, in which case neither seat may approve it. | None. |
| `fail` (1st or 2nd time for the slice) | Returned to `build`: `sdlc run build --slice <n> --revise`. | `verdict: return`, `by: runner:verify`. |
| `fail` (3rd time running) | Escalated — a fourth build is unlikely to find what three did not. | `verdict: escalated`, `escalate_to` from `policy.gates.G3`. |
| `environment` | Nothing the builder can change. A missing mail catcher: set `targets.new.mail_api`, then verify again. A configuration's test: G3's ruler decides. Not counted toward the return limit. | None. |
| `unbound`, no adapter for `new` | The binding sequence: `sandbox up --from` the proposal branch, `bind-adapter`, its G3 ruling, `sandbox down --from`, then verify again. | None. |
| `unbound`, adapter in place, binding owed | The rows are filed for `bind-adapter --target new` on `main`, and the same binding sequence is printed. The verify after it closes what the binding reached. | None. |
| `unbound`, adapter in place, binding sent its limit | A person's choice of three: return at G3 with the adapter's reasons as conditions and `build --revise`; return with `addressed-to plan: <why>` and `plan --revise`; or return with `test-overreaches <ID>: <why>` and `derive-tests --domain <d> --stale`. | None. |
| the sandbox did not start, `cause: application` (1st or 2nd time for the slice) | Returned to `build`: `sdlc run build --slice <n> --revise`. | `verdict: return`, `by: runner:verify`. |
| the sandbox did not start, `cause: application` (3rd return running) | Escalated — the compose file, the stack profile or the machine can each be the cause, and a fourth build would not find out which. | `verdict: escalated`, `escalate_to` from `policy.gates.G3`. |
| the sandbox did not start, `cause: environment` | Nothing ran. The run fails; fix the machine and run verify again. | None. |
| the branch no longer merges with `main` | Nothing ran. Rule or close the proposal and rebuild the slice on top of `main`. | None. |

## Checks

`postChecks` returns nothing and `verify` opens no proposal of its own — it writes onto one that
already exists. Two things end a run before any classification happens, and neither records
anything against the build:

- **The branch no longer merges with `main`.** The merge is aborted, so the branch is exactly as it
  was and nothing is left half-merged, and the run fails naming the conflicted paths. No gate file
  is written and the builder is not returned anything: a conflict is a fact about two branches, not
  a verdict about the application, and the slice needs rebuilding on top of what `main` now has.
- **The sandbox will not start, and the cause is the machine.** Reported with the compose failure's
  own tail, with nothing recorded: a port already bound is not the builder's defect, and no build
  attempt is spent on it.

## A sandbox that will not start

A sandbox can fail to start for two quite different reasons and they need opposite answers.

A container that came up, died on a file this build wrote and has been restarting ever since is the
build's own defect, and no acceptance criterion can express it: the suite cannot fail on it, verify
cannot pass, `rule.mjs` refuses a ruling on a build proposal with no passing verify result, and
`build --revise` needs a returned ruling to start from. So `cause: application` is written to the
proposal's gate file exactly as a failing criterion is — the same file, `by: runner:verify`, one
condition per failed service naming the service, what became of it and the end of its own log — and
`build --slice <n> --revise` picks it up like any other return.

`tests/results/new/slice-<n>.json` is written alongside it, with no rows, `verdict: fail` and a
`not_verified` line. No test ran, and the file is written anyway because it is what `rule.mjs` reads
to decide whether the proposal may be ruled — and it judges an earlier result current by the
application tree, which a commit carrying only a gate file does not change. Left alone, a `pass` from
a verify before the sandbox broke would still read as current and the proposal this run just returned
would still be rulable as approved.

`cause: environment` halts the run, non-zero, with nothing recorded. A result that names no cause at
all is treated as the machine's: halting costs a re-run, and returning a build wrongly spends one of
the attempts the slice has before a person is asked.

A sandbox return counts toward the return limit alongside a criteria return, so the one that
reaches it escalates. An environment halt writes no gate file and cannot count.
`docs/decisions/0017-a-sandbox-that-is-not-up.md` has the reasoning.

## What `next` does with it

`sdlc next` reads the result off the proposal branch (`src/runner/next.mjs`). A build whose verdict
is `unbound`, while a rebind entry filed by its slice's verify is open, is not offered for ruling: the
binding is offered instead, as `sdlc run bind-adapter --target new`, with the `sandbox up --from`
step it needs named beside it. A build returned with failures beside its unbound rows leaves no
build proposal open, and the `--from` named is then that build's own branch, `proposal/<name>` or
`returned/<name>`, since its application is still the one the rows were found on
(`docs/decisions/0080-a-returned-adapter-is-revised-before-it-is-measured-with.md`). Once a binding is ruled onto `main`, the adapter has changed under
the entry and `sdlc run verify --slice <n>` is offered, not a calibration. A build whose verdict is
`environment` waits on G3's `escalate_to`, naming the criteria; where every gap was the mail catcher
and `targets.new.mail_api` is now set on `main`, verify is offered again. Past the rebind limit an
`unbound` build is ruled as any build that did not pass
(`docs/decisions/0075-what-a-verify-charges-to-the-build.md`). While a proposal for the new target's
adapter is open, a verify is not offered ahead of it: its ruling comes first, and where a person
holds it the verify is held until it is ruled
(`docs/decisions/0079-an-adapter-is-ruled-before-it-is-measured-with.md`).

## Failure modes

- **No open build proposal for the slice**: the pre-check fails, naming `build --slice <n>` as the
  step to run first.
- **G3 names no `escalate_to`**: the pre-check fails before anything is started, naming the key.
- **`SDLC_SANDBOX_PASSWORD` unset for a `sandbox-idp` target**: the pre-check fails before anything
  is started. Without it every test in the slice fails at the sign-in form, and verify would read a
  suite of sign-in failures as the application's fault and return the slice to a builder that
  cannot fix an environment defect.
- **The branch no longer merges with `main`**: the merge is aborted before the sandbox is touched,
  the conflicted paths are named, and the run fails. Nothing is written, and the branch is exactly
  as it was.
- **The sandbox does not start, `cause: environment`**: reported in the run's own text; nothing is
  written and the branch is left exactly as it was.
- **The sandbox does not start, `cause: application`**: the build proposal is returned (or
  escalated on the return that reaches the limit), with the failed service and the end of its own log as the
  conditions. The run itself succeeds, the way a failing slice's does — the verdict is the outcome,
  not an error.
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

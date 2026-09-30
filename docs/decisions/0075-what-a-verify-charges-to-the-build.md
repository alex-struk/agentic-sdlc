# 0075 · What a verify charges to the build

Status: accepted · 2026-09-30

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

`verify` runs the acceptance tests a build slice claims against the sandbox its build proposal
carries, returns the proposal to the builder when a criterion fails, and escalates the slice to
G3's `escalate_to` on the return that reaches `policy.loops.verify_returns`
(`docs/decisions/0011-build-verify-review.md`). A return is only useful when the builder can do
something about it, and two things verify met were not the builder's.

**The mail catcher.** `calibrate` hands the suite the oracle's mail catcher as `SDLC_MAIL_API`, from
the ports `oracle up` chose. Verify handed the suite none: the new target's configuration had no
place to say where its mail catcher answers, although the stack profile has the build publish one
in its own compose file. Every test that reads a message stopped at the harness's `mail` fixture
with `SDLC_MAIL_API is not set`, verify read each as a failed criterion, returned the build, and
counted the return. A build cannot change `.sdlc/config.yaml`, so every later build failed the same
way, and the slice reached a person as a build that had failed three times.

**Configurations.** A test written for a configuration the target reads at start-up runs only
against an instance started in it (`docs/decisions/0071-a-configuration-gets-its-own-oracle.md`).
Nothing starts the new target's sandbox in a configuration, so verify ran the test against the
default sandbox, where it fails correctly, and charged the failure to the builder.

**Unbound rows.** The new target's adapter is bound once the application answers, and a slice
builds screens after that: the adapter still names what it found then, which can be the
application the rebuild replaces. A test that needs a screen the slice has just built stops at the
adapter's own `unbound:` error. Verify reported the row `unbound` and told a person that binding
again would drive the same application and write the same reasons — true of an adapter bound
against this application, and not of one bound before it. The choices offered were all rulings on
the build proposal, the first of them a return to the builder. On the oracle's target an unbound row
is owed to `bind-adapter` (`docs/decisions/0067-an-unbound-row-is-owed-to-its-binding.md`), but
that mechanism is driven by calibration, and the new target has none.

## Decision

**A target the pipeline builds declares its mail catcher: `targets.<t>.mail_api`.** A URI, in the
schema and so in the config check. `verify` hands it to the suite as `SDLC_MAIL_API`, and so do
`calibrate --target <t>` and `bind-adapter --target <t>` for a target other than the oracle.
`sandbox up` waits for it after the base URL and every `depends_on` address, and refuses a target
whose mail catcher never answers the way it refuses one whose provider never does
(`docs/decisions/0018-a-sandbox-is-ready-when-what-it-serves-through-answers.md`).

**A criterion this environment could not test is an environment gap, not a failure.** A row whose
every failing test stopped at the mail fixture's own words, and a criterion whose test is written
for a configuration, are set aside with their reasons. Verify leaves every configuration's tag out
of its run (`--grep-invert`), as calibration's ordinary run does. The verdict is `environment`
when nothing failed and something could not be tested; no gate file is written and nothing counts
toward the return limit. Beside a real failure, the gaps are named in what is printed and are not
conditions of the return. `next` holds the proposal for G3's `escalate_to` and names what is
missing; where every gap was the mail catcher and `targets.new.mail_api` is now on `main`, it
offers the verify again. The mail fixture's message is matched because it is the harness's own
text (`templates/project/tests/fixtures/mail.ts`), the way calibration matches the harness's reset
failure (`src/testrun/results.mjs`).

**A return whose every condition is an environment gap does not count toward escalation.** Verify
no longer writes one, and a slice returned that way before is not one build closer to a person.

**On the new target, an unbound row is owed to `bind-adapter --target new`, and the verify of its
slice checks it again.** Once the tree is back on `main`, verify settles the unbound rows among the
slice's criteria against `tests/adapters/rebind.yaml` with the rules a calibration uses
(`src/spec/unbound.mjs`): a row is filed, `by: runner:verify` and carrying `slice: <n>`, while the
binding has been sent for it fewer times than `policy.loops.rebind` allows; an entry for one of the
slice's criteria found under an adapter that has since changed lapses, and one whose row the
adapter now reaches is closed. The settling is scoped to the slice's criteria, so one slice's
verify never lapses or closes another's. It runs whatever the verdict, so an unbound row beside a
failure is owed too. Nothing is written to a gate file for an unbound row.

What is printed is the sequence the binding needs, because the application it binds against is on
the proposal branch alone: `sandbox up --from` the branch, `bind-adapter --target new`, the G3
ruling, `sandbox down --from`, and `verify --slice <n>`. `next` does not offer the build for ruling
while such an entry is open; it offers the binding, naming the `sandbox up --from` step, and once
the adapter on `main` has changed under the entry, it offers `verify --slice <n>` rather than a
calibration. Past the rebind limit, or for a persona the contract marks unavailable, the row is no
longer owed, and verify offers the three rulings it offered before: return with the reasons as
conditions, return to plan, or return a test that reaches past its criterion.

## Alternatives

**Make the gaps conditions of the return and let the builder say it cannot act.** Rejected: each
such return spends one of the slice's attempts, and the builder's answer would be the same every
time.

**Escalate an environment gap to G3's `escalate_to` at once.** Rejected: an escalated proposal can
be approved without a passing verify, and a missing mail catcher is one line of configuration away
from a verify that tests the criterion. Holding the proposal names the line; escalation would
invite approving criteria nobody tested.

**Start the sandbox in each configuration, as calibration starts the oracle.** Deferred: the
builder's compose file has no contract saying which variable selects a configuration. Until the
stack profile or the build skill gives it one, verify reports those criteria as untested rather
than guessing.

**File the rebind entries on the proposal branch with the verify result.** Rejected: owed work is
read off `main`, by `next` and by the binding run, and the branch reaches `main` only when the build
is approved — which the open entries are there to hold up.

**Route every unbound row on the new target to the reviewer instead.** Rejected for the reason 0067
rejected it for the oracle: every one would come back as the adapter's, costing a ruling to learn
what the row already says.

## What would reverse it

A sandbox that can be started in a configuration would turn configuration gaps into rows verify
runs. A binding run that starts the application an open build proposal carries by itself would let
`next` offer it without the `sandbox up --from` step beside it. Rulings that keep returning builds
whose only open rows are unbound would show the binding is not what closes them, and that the limit
on sends is too high.

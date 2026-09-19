# 0011 — Build ships through the ordinary G3 ruling, verified before it is asked

**Status:** accepted · 2026-09-19

`build` writes one slice of the rebuilt application and opens it as a G3 proposal; `verify` runs
the acceptance suite for that slice's criteria against a sandboxed instance of it before the
proposal is ruled. This records how the two stages divide the work the design spec calls `build`,
`verify`, `review-and-ship` and `deploy`, and where the first increment's failure routing and
deploy story land.

## 1 — Review-and-ship is the reviewer's G3 ruling, not its own stage

**Decision.** There is no `review-and-ship` stage. The reviewer persona
(`.sdlc/personas/reviewer.md`) holds gate G3 on a build proposal the same way the UX reviewer holds
G-DESIGN and the tech lead holds G1: `sdlc rule <build-slice-name> --by agent:reviewer` (or
`--pending`) reads the proposal, the diff and the verify result, and rules approve or return. In a
simulated run the reviewer is an agent, escalated the same way any other agent-held gate is —
to the simulated tech lead when the config makes that role an agent too (0010).

**Why.** `sdlc rule` is already the machinery a review turns into: it reads the proposal page and
diff, runs an agent turn against a persona brief, and writes an approve/return/escalate verdict to
a gate file. A dedicated stage would rebuild that machinery to produce nothing `rule` doesn't
already produce — no new artifact, only a ruling. What review needs beyond an ordinary G3 ruling
is evidence that the acceptance suite has already passed against this code, and that evidence is
`verify`'s job, not a second agent turn's.

## 2 — A failing verify returns the build proposal through the ordinary gate file

**Decision.** When verify's suite run fails, `verify` itself writes
`.sdlc/gates/<build-proposal-name>.yaml` with `verdict: return`, `by: runner:verify`,
`held_by: runner`, and one condition per failing criterion — the same file, in the same place, a
human or a persona ruling would write. `build --slice N --revise` reads it exactly the way it would
read a reviewer's own return: it asks only whether the named proposal's gate file says `return`,
never who wrote it.

**Why.** A revision has one job regardless of who found the problem: rebuild what the ruling names
and leave the rest. Two different shapes of "returned" — one for a human or persona's ruling,
another for a failing test run — would need two revision paths, or a build stage that has to know
which one it is reading before it can act. Writing verify's own finding through the same gate file
`rule` writes means `build --revise` has exactly one thing to check, and one prompt to build from
either source.

## 3 — A stand-in for §7.1's five-class routing: two routes and a retry ceiling

**Decision.** Verify sorts a slice's claimed criteria into three outcomes. Every criterion the
adapter cannot bind (`unbound`) routes to `bind-adapter --target new` and nothing else is reported.
Anything else that is not `pass`, `not-testable` or `attested` — a `fail`, a `stale` test, or a
criterion missing from the run altogether — returns the build proposal for `build --revise`. A
slice returned this way three times running (`MAX_VERIFY_RETURNS`) escalates to the tech lead
instead of returning a fourth time.

**Why.** The design spec's §7.1 divides a failure into five classes — implementation defect, spec
ambiguity, test defect, adapter defect, environment defect — each with its own route and its own
retry ceiling, decided by a classifier this increment does not have. What the first increment
collapses that to is what a slice's own history can already tell without one: a criterion the
adapter cannot reach is a binding gap, not a question about the code, so it goes to
`bind-adapter`; everything else is a difference between what the criterion says and what the
running application does, and the only stage that can act on it without another turn of
classification is `build`. Counting returns stands in for the other four classes' retry ceilings —
a slice that has failed the same way three builds running is failing for a reason a fourth build is
unlikely to fix, whatever the reason turns out to be, and it is worth a person's attention rather
than a fourth automatic attempt.

## 4 — Deploy, for this phase, is `sdlc sandbox up` against the project's own compose file

**Decision.** `sdlc sandbox up|down|reset|status --target <t>` builds and starts the target's own
`app/compose/compose.yaml` with Docker Compose, waits for it to answer its health check, and runs
its seed service. `verify` calls the same functions to stand the application up for a slice's
acceptance run and tear it down after. No target reaches OpenShift, and no agent stage is handed a
deploy credential.

**Why.** The design spec's §5.13 deploy step is the stack profile's OpenShift workflow, which needs
a namespace and credentials only a person can supply, and says plainly that no agent stage may hold
one. That is out of scope for this phase. What `verify` needs is a real, running instance of the
application to test against, and a local compose stack the project already declares for its own
development is enough to provide one, without a namespace, a credential, or a network egress
`sdlc check` would have to account for.

## 5 — The rebuilt application seeds itself

**Decision.** The sandbox reseeds through the target's own compose service (`seed_service`,
defaulting to `seed`) rather than the SQL files `sdlc oracle up` loads for the old application.
That service loads the handles `tests/seed/manifest.yaml` names, into whatever schema the rebuild
actually has.

**Why.** The old application's seed SQL is written against its own schema, and the rebuild does not
carry that schema forward — a build slice is free to shape its own tables. A seed step shared
between the two targets would either seed the old schema, which means nothing against the new one,
or force the rebuild to keep a shape it was never asked to keep. The manifest's handles are the
contract both targets have to honour; how each one gets there is its own.

## What would reverse each

1 — review needing to look at something a proposal branch's diff and checks cannot give it, such
as a running instance the reviewer itself has to drive, at which point review-and-ship becomes a
stage with its own workspace rather than a ruling on `build`'s output.

2 — a reviewer's return and a verify return needing different revision paths — for example, a
reviewer's return naming a smaller change than "rebuild the slice" that a test failure's return
cannot.

3 — a failure classifier that can tell an implementation defect from a spec ambiguity from a test
defect without three failures in a row to guess from, at which point each of §7.1's five classes
gets its own route and its own ceiling.

4 — OpenShift deploy work starting, with a person, not an agent stage, holding the sandbox
namespace's credentials to run it.

5 — the rebuild adopting the old application's schema outright, which nothing about the rebuild
currently plans to do.

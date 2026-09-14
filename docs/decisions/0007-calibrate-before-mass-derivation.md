# 0007 — Binding precedes derivation, and calibration is the contract's measurement

**Status:** accepted · 2026-09-13

Phase 1c turns a ratified spec into an executable suite. It has four stages: `contract` recovers
the surface a test may name, `derive-tests` writes one blind test per criterion, `bind-adapter`
binds that surface to a running application, and `calibrate` runs the suite against it. Until now
they ran in that written order, with derivation covering every domain before anything executed.
This records why the middle two swap, and what calibration is allowed to feed back into.

## 1 — `bind-adapter` runs before `derive-tests`

**Decision.** The stage list becomes `contract`, `bind-adapter`, `derive-tests`, `calibrate`.

**Why it can.** An adapter binds the abstract `Surface` to what a running application renders.
Every input it takes comes from `spec/contract/`: its workspace regenerates
`tests/generated/surface.d.ts` from the committed contract, and it collects only `tests/adapters`.
It never reads a test. The old ordering implied a dependency that does not exist.

**Why it should.** Until an adapter exists nothing can be executed, so a contract defect is
invisible. `derive-tests` is blind by construction and cannot tell the difference between a
criterion that is genuinely unobservable and a surface that is merely unable to express it — both
present to the agent as "I have no way to reach this". Only a run against the oracle separates
them. Deriving every domain first means one contract defect is paid for once per domain.

**What it cost to learn.** On the first project run through this phase, six domains were derived
before anything executed. The first calibration returned 13 passing rows out of 265, and the
dominant cause was a single contract-stage defect: the generated surface declared `open()` with no
parameters, so no test could address a specific record. Correcting one line of the contract stage
invalidated every derivation that preceded it.

**What would reverse it.** A contract that is declared by a person rather than recovered from a
running application has no recovery defect to find, and the ordering stops mattering. So does an
adapter that needs the test suite to exist — a binding derived from test usage rather than from the
contract — which would restore the dependency this decision removes.

## 2 — A calibration failure is evidence about the contract or the criterion, never a note to the test

**Decision.** Calibration rows route to G1, where the product owner rules which of three things is
wrong: the old application, the criterion, or the test. A ruling that the contract is inadequate is
carried out by `contract --revise` and a fresh derivation. Calibration output is never given to a
`derive-tests` session as material to correct its own work against.

**Why the loop must stay open.** A stage that can see why its test failed and rewrite it will
converge on a test that passes. That is not the same as a test that is right, and it is precisely
the failure the blindness rule exists to prevent: the cheapest way to make an assertion pass is to
assert less. The same argument already forbids `bind-adapter` from executing the suite it writes
(`docs/decisions/0006-contract-stage-and-oracle.md`). Derivation reads the criterion and the
contract, and nothing that reports on its own success.

**Why routing to the contract is not the same loop wearing a disguise.** The contract is ruled at
G1 before any test is derived against it, and what it gains from a calibration finding is a
capability — a typed parameter, an observation, a seeded precondition — not an outcome. A surface
that can address a record does not decide what the test asserts about it. The reviewer at G1 can
see the difference, because a contract revision that encodes an expected result rather than a way
to reach one is visible in the diff.

**What would reverse it.** Nothing about the cost. A measurement showing that derivations which had
seen their own calibration results were no weaker than blind ones would reverse it, and that
measurement requires the blind baseline this decision protects.

## 3 — A compiler is not a test runner, so a blind stage may be failed by one

**Decision.** `derive-tests` and `bind-adapter` each gain a post-check that compiles the
acceptance suite and fails the stage on any diagnostic under the directory that stage wrote.
A failure earns the stage its one repair turn, run in its own workspace rather than in the
project directory, with the diagnostics as its instructions.

**Why this is not the loop section 2 forbids.** A compiler reports that code is ill-typed. It
cannot report that an assertion passed, that an expectation matched, or that the application
behaved. There is nothing in a diagnostic to converge on except correctness of form, so the
cheapest way to satisfy it is to name the parameter the surface actually declares — not to
assert less. Calibration is withheld from a derivation for the opposite reason: its rows say
which criteria passed, and a writer who sees those will write tests that pass.

**Why the stage cannot do this for itself.** A blind stage is given no shell, deliberately:
the workspace is what makes its blindness structural rather than promised, and a shell inside
it would reach the network. So a session writes TypeScript against a generated declaration
file with nothing able to contradict it until a reviewer reads a compiler report, by which
point a whole domain has been written to the wrong assumption.

**What it cost to learn.** A surface declared `open({ opportunityId })`. Three domains were
re-derived against it and every one wrote `open({ opportunity })`, taking the parameter's name
from the criterion's own wording. Nothing objected, the derivations were proposed, and the
suite could not compile.

**Why the repair turn runs in the workspace.** The project directory holds the application
source and the other domains' tests — everything the workspace exists to keep from a blind
session. The workspace is still on disk when a post-check fails, and is exactly as blind as it
was for the first turn, so the repair happens there and its output is collected back the same
way the first turn's was.

**What would reverse it.** A harness whose generated declarations are not the only statement
of the surface — one where the criterion text and the type are derived from a single source a
writer cannot disagree with — removes the class of error entirely. Short of that, only a
measurement that repaired derivations are weaker than unrepaired ones.

## 4 — The first derivation of a project is a pilot of one domain

**Decision.** A project's first `derive-tests` run covers one domain, and `calibrate` runs
immediately after it. The remaining domains are derived only once that calibration has been ruled.

**Why one domain and not a sample of each.** A domain is the unit a reviewer rules
(`docs/decisions/0005-criteria-in-domain-files.md`), and a partial domain has no gate. One whole
domain is the smallest thing that can be derived, ruled, executed and measured end to end.

**Why this is an operating instruction and not a stage.** `calibrate` takes no agent turn: it
starts the oracle, runs the suite and writes one row per criterion. Running it early costs oracle
time and a G1 ruling, not a derivation budget. Nothing in the stage machinery needs to change to
allow it, so nothing does — `sdlc run calibrate` is already available the moment an adapter and one
test exist.

**What would reverse it.** A project whose domains are so unalike that one says nothing about the
others gets no warning from a pilot, and pays a calibration cycle for it. That is a judgement the
person running the pipeline makes; the default is the pilot because the failure it prevents is
measured in whole derivations and the cost it adds is one oracle run.

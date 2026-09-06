# Agentic SDLC pipeline, proven by rebuilding the Digital Marketplace

**Design specification · 2026-09-05 · draft for Alex's review**

This document describes two things that are built together: a reusable agentic
software-delivery pipeline, and the first project it runs on, a rebuild of the
BC Digital Marketplace on a modern stack. The pipeline is the product. The
marketplace rebuild is the evidence that it works, and the first opinionated
stack it encodes.

Terms are defined the first time they are used. A glossary at the end collects
them.

---

## 1. Purpose and scope

### 1.1 What this is

A pipeline in which agents do the execution and human judgement is spent at a
few prepared decision points, called gates. Every piece of work traces to a
criterion: the smallest testable promise about behaviour, with a permanent ID.
Tests derive from criteria, code satisfies them, reviews check them, and the
state of every criterion is visible on one generated page.

The pipeline installs into a project repository by reference to a versioned
pipeline repository, so a team can adopt it, keep it current, and configure it
without forking it.

### 1.2 What the first run is

An experiment on a new repository, with no business owner. The existing
`bcgov/digital_marketplace` is a read-only input. Nothing ships to the live
product. The outputs are a working rebuild in a sandbox, a measured record of
how the pipeline behaved, and the pipeline itself, improved by that record.
The system will be rebuilt more than once as the pipeline improves. That is why
the spec and the test suite are the durable assets and every implementation is
disposable.

### 1.3 Goals

1. A pipeline another team can install, run end to end, and upgrade unaided.
2. A rebuilt marketplace that passes the same spec-derived test suite the old
   application passes, on the BC Gov OpenShift platform, using the BC Design
   System, with the existing Postgres schema.
3. Gates that are easy to digest: one page per decision, and a generated site
   showing the state of every criterion.
4. A measured record: review cycles per pull request, iterations to a green
   build, elapsed time per slice, and parity with the old application.
5. A rebuild that can be reproduced by pointing the configuration at the old
   repository and running the same commands again.

### 1.4 Non-goals

- Shipping to `marketplace.digital.gov.bc.ca`, or any change to the live
  application or its operations.
- A decisions database, an approval UI, a policy editor, user accounts, or an
  agent framework. Git, pull requests and static pages hold all of it.
- Cloud agents as the primary executor. Local Claude Code is the executor for
  this run. The stage contracts are written so a cloud agent can take a stage
  later without changing the pipeline.
- Discovery and user research. Those stay human-led and are out of scope.

---

## 2. Principles

These come from Alex's 2026-08-25 prototype and are not negotiable inside the
pipeline. A project may tighten them, never loosen them.

1. **Deterministic checks block. Agents advise. Humans judge risk.** Anything
   that must always happen is a script or a branch rule, never a request to an
   agent.
2. **Agents propose, humans ratify.** Nothing enters the spec, and nothing
   merges, without a named human at a gate, or a written and expiring policy
   that allows it.
3. **Tests never see code.** The session that derives acceptance tests sees the
   spec bundle and nothing else. This is enforced by what is on disk, and
   verified afterwards by a provenance check.
4. **One front door.** Every change, including an agent-drafted production fix,
   enters as a proposal through the same gates.
5. **Everything is derivable from git.** Coverage, gate history, evidence, and
   metrics are recomputed from files, pull requests and CI results. There is
   no second store to drift.
6. **Public by default, so egress is a control.** The repositories are public in
   the bcgov organisation. Live-environment detail, certificates, namespace
   values, internal ticket numbers, personal notes and per-person metrics never
   enter them.

---

## 3. Repositories and installation

### 3.1 Two repositories

| Repository | Holds | Visibility |
|---|---|---|
| Pipeline repo (`agentic-sdlc`) | Skills, scripts, reusable workflows, templates, config schema, runner CLI, docs, dependency register | bcgov, public |
| Project repo (marketplace rebuild) | Constitution, config, intent, spec, contract, tests, adapters, design catalogue, plan, application code, evidence, generated state site | bcgov, public |

Both are local git repositories until something requires a remote, and
nothing is pushed without Alex's explicit permission at that moment. The first
thing that requires a remote is a gate expressed as a GitHub pull request; until
then the runner expresses gates as local branches with a generated decision page,
and a ruling is recorded by a commit. The intended remote is the bcgov
organisation, public; `bcgov-c` is the private fallback.

### 3.2 Pipeline repo layout

```
agentic-sdlc/
  README.md
  docs/
    architecture.md          how the runner, stages, gates and site fit together
    stages/<stage>.md        one contract per stage (section 5)
    config.md                configuration reference (section 9)
    dependencies.md          the dependency register (section 11)
    decisions/NNNN-*.md      architecture decision records
    runs/<project>/<date>.md run records, one per pipeline run
  skills/<stage>/SKILL.md    agent instructions per stage, plus references/
  scripts/                   deterministic checks and generators (Node, no deps beyond gh and git)
  workflows/                 reusable GitHub Actions workflows, called by version
  templates/                 constitution, intent, spec, contract, design spec, plan, tasks, evidence
  profiles/                  greenfield, rebuild, remediation, feature
  stacks/<name>/             stack profiles: standards skill plus scaffold pointers
  schema/config.schema.json
  bin/sdlc                   the runner CLI
  evals/                     harness evals: regression tests for the pipeline's own rules
  fixture-project/           a tiny project the pipeline runs end to end in its own CI
```

### 3.3 Project repo layout

```
<project>/
  .sdlc/
    config.yaml              which profile, stack, sources, oracle, policy, skill packs
    lock.json                pinned pipeline version and skill pack versions
    personas/<role>.md       briefs for agent-held gate roles
  .github/workflows/         thin callers of the pipeline's reusable workflows
  constitution.md
  intent/                    one file per intent
  spec/
    spec.md                  domain sections, criteria with IDs
    features/*.feature       acceptance scenarios, one file per domain
    contract/                personas, routes, labels and test IDs, openapi.yaml, observables
    criteria-index.json      generated: every criterion, version, state, confidence
  tests/
    acceptance/              blind tests, provenance headers
    adapters/<target>/       surface bindings per target, locators only
    seed/                    persona and fixture data, loaded by SQL into any target
  design/
    DESIGN.md                design spec (tokens, components, states, forms, accessibility)
    catalogue/               Storybook stories: every screen in every state
  plan/plan.md  plan/tasks.md
  app/                       the implementation (layout per stack profile)
  evidence/pr-evidence.md    append-only review receipts
  site/                      generated state site, published to GitHub Pages
```

### 3.4 Installation and upgrade

`sdlc init` reads `.sdlc/config.yaml`, writes `lock.json`, generates the caller
workflows, copies templates that do not yet exist, and installs the listed skill
packs at their pinned versions into the agent's skill location. `sdlc upgrade`
bumps the pipeline version in the lockfile, regenerates callers, and opens a
pull request. Nothing in the pipeline repo is copied into the project except
templates the project is expected to fill in.

Reusable workflows are referenced the way `bcgov/quickstart-openshift` already
references its helpers:

```yaml
uses: bcgov/agentic-sdlc/workflows/checkpoint-gate.yml@v0.3.0
```

---

## 4. Artifacts

Every artifact below is a file in the project repo. Each has a template in the
pipeline repo, a stage that produces it, a gate that accepts it, and a check
that validates its shape.

### 4.1 Constitution

`constitution.md`. Platform articles that no project may loosen, and project
articles the team fills in. The platform articles for BC Gov, taken from
Kaegan's tier2-v3 pack and kept: accessibility to WCAG 2.1 AA; the BC Design
System for new services; no personal information before a privacy assessment;
OpenShift as deploy target unless an exception is recorded; spec in git as
source of truth; three human checkpoints with no agent self-merge; test
integrity, meaning the agent that wrote code does not solely write its
acceptance proof; approved tools only. Project articles: service purpose, in and
out of scope, forbidden patterns, domain language (a glossary table, which also
serves as the shared vocabulary the intent skill maintains), non-functional
baselines, recorded exceptions, development notes.

### 4.2 Intent

`intent/<slug>.md`. Why, for whom, and what outcome. Problem, measurable
outcome, affected users and systems, constraints, evidence, open questions.
Technology-free. Produced by an interview, the grilling skill, which asks
questions until the intent has no open questions the author can answer.

### 4.3 Spec and criteria

`spec/spec.md` in spec-kit's format: prioritised user stories, each
independently testable, with acceptance scenarios; numbered requirements;
measurable success criteria; assumptions. Each criterion is one line in a
domain section with this shape:

```
R-12.3 (v2) [confidence: confirmed] When an opportunity is published, its status
shall show "Published" to every signed-in user within one page load.
  cites: src/back-end/lib/resources/opportunity/code-with-us.ts:412 @b0f0c99c
  reconciliation: aligned
```

Fields: ID (permanent, minted at ratification, never reused), version (bumps on
any wording change), confidence (`confirmed`, `inferred`, `open`; nothing
ratifies while `inferred` or `open`), citations (for recovered criteria, file
and line at a commit), reconciliation (`aligned`, `implemented-only`,
`documented-only`, `conflicting`, for recovered criteria). The confidence field
unifies three existing conventions: Rog's confirmed/inferred/open ledger,
spec-kit's NEEDS CLARIFICATION marker, and Crow's reconciliation class.

`spec/features/*.feature` holds Given/When/Then scenarios tagged `@R-12.3`.
Gherkin is used as a writing format only. No Cucumber runner.

`spec/criteria-index.json` is generated from the two and is what the site and
the checks read.

### 4.4 Contract

`spec/contract/`. The part of the spec that tests need in order to act and
observe. It is spec content, not implementation, and it is what lets a blind
test and a blind implementation meet.

- `personas.yaml`: each role, what it can do, and how a test signs in as it.
  The old application exposes a development-only session route per role; the
  new application must provide an equivalent test identity mechanism, defined
  here, never enabled outside sandbox environments.
- `surface.yaml`: routes, page titles, the actions and observations each page
  offers, and for the new application the test ID of each. Example: page
  `opportunity`, action `publish`, observation `status`.
- `openapi.yaml`: the API contract. Recovered from the old application's
  OpenAPI description, then ratified and versioned like any criterion.
- `observables.yaml`: side effects a test may observe and how: outgoing
  email via a mail catcher, files via the file endpoint, notifications via a
  test subscriber.
- `tests/seed/` (referenced from the contract): personas and fixture data as SQL, loadable into any target because
  the schema is shared.

### 4.5 Tests and adapters

`tests/acceptance/`: Playwright flows and API contract tests. Each file starts
with a provenance header:

```ts
// criterion: @R-12.3 v2
// provenance: blind, spec@<commit>, derived <date>
```

Tests call an abstract surface, never a locator:

```ts
await surface.signIn(persona.publicSectorAdmin);
await surface.opportunity.open(seed.opportunity.draftCwu);
await surface.opportunity.publish();
await expect(await surface.opportunity.status()).toBe("Published");
```

`tests/adapters/<target>/`: one binding of the surface per target. The `old`
adapter binds by role, label, text and URL, recorded by walking the running old
application. The `new` adapter binds by the test IDs in `surface.yaml`.

Rules enforced by lint (`scripts/check-separation.mjs`):

- An adapter may contain navigation and locators only. No `expect`, no
  assertion helper, no data.
- A test may not import from `app/` or from any adapter directly; it receives
  the surface through a fixture selected by target.
- A test may not contain a CSS selector, test ID, or URL. Those live in
  adapters and in `surface.yaml`.

### 4.6 Design spec and catalogue

`design/DESIGN.md`: the machine-readable design specification, from Crow's
template: token references, components and their reachable states, layout and
reflow rules, forms and validation, accessibility requirements, motion, known
gaps. `design/catalogue/`: Storybook page stories, one per screen per state,
built with `@bcgov/design-system-react-components`. The stories are the design
gate artifact and later serve as visual regression fixtures. The component
layer built for the catalogue is kept in the implementation, so the prototype
is hardened rather than rebuilt.

### 4.7 Plan and tasks

`plan/plan.md` in spec-kit's format with a constitution check before design:
technical context, project structure, data model, contracts, research notes.
`plan/tasks.md`: vertical slices, each delivering one or more scenarios from
`spec/features/`, each with the criteria it satisfies and its done condition
(section 7.4).

### 4.8 Evidence

`evidence/pr-evidence.md`, append-only. One receipt per implementation pull
request: what was checked, what could not be checked, residual risk. A PR that
changes only evidence and no implementation fails the gate.

### 4.9 State site

`site/`, generated by `scripts/build-site.mjs` from `criteria-index.json`, the
latest acceptance results per target, PR labels read through the GitHub CLI,
and the run record. Pages: coverage board (criteria by lifecycle state:
proposed, accepted, implemented, verified, monitored), one trace page per
criterion (its versions, tests, PRs, gate decisions, and calibration result on
each target), ratify queue, gate log, run log. Published to GitHub Pages on
merge; `sdlc status` renders the same pages locally. Each gate PR links to the
page it should be judged against.

---

## 5. Stages

A stage is defined by six things: inputs, outputs, the skill the agent runs
with, the workspace the agent may see, the deterministic checks that block, and
its exit criterion. Every stage is re-runnable: it reads its inputs from git,
writes its outputs as a branch and a draft pull request, and never mutates
another stage's outputs. Re-running a stage on unchanged inputs produces a
no-op PR, which the runner closes.

The runner executes a stage as: materialise workspace, run pre-checks, launch
the agent non-interactively (`claude -p` with the stage skill loaded and the
workspace as its only directory), run post-checks, open or update the PR,
append to the run record.

### 5.1 `init`

Inputs: `.sdlc/config.yaml`. Outputs: `lock.json`, caller workflows, template
files not yet present, installed skill packs. Checks: config validates against
the schema; every referenced pack resolves at its pinned version. Exit: the
checkpoint workflow runs green on an empty PR. Re-run safe.

### 5.2 `intent`

Inputs: a conversation, or an issue, or a dropped document. Skill: grilling
(from mattpocock/skills) plus the pipeline's intent template. Workspace: the
project repo minus `app/` and `tests/`. Output: `intent/<slug>.md` and any
additions to the constitution's glossary and decision records. Check: no
template placeholder remains; every open question is listed, not silently
resolved. Exit: the intent PR merges (gate G0, section 6). For the rebuild
profile the intent is largely recovered by archaeology and confirmed by the
author; the interview then covers only what is new: same behaviour, modern
stack, database kept, sandbox only.

### 5.3 `archaeology` (rebuild and remediation profiles)

Inputs: the source repository at a pinned commit, its documentation, its
migrations, its OpenAPI description, its issue and PR history through the
GitHub CLI. Explicitly excluded: the source repository's own tests, which
encode current behaviour and would contaminate the spec; and any of Alex's
notes. Skill: the archaeology skill, which borrows Crow's business-rule
extraction guidance and its data shape (stable IDs, citations, reconciliation
class). Workspace: a read-only checkout of the source at `sources/old/` plus
`spec/` and `intent/`. Outputs, one PR per domain: draft criteria marked
`recovered` with citations, confidence and reconciliation; draft scenarios;
draft `contract/` files including the recovered OpenAPI; a domain summary page
that leads with what the domain does, what was found conflicting, and what the
agent could not determine. Checks: every criterion has at least one citation;
no criterion is marked `confirmed` by the agent (only a human can); IDs are
provisional (`D-` prefix) until ratified. Exit: all domain PRs open.

Domains for the marketplace: opportunities (Code With Us, Sprint With Us, Team
With Us), proposals, organisations and affiliations, users and authentication,
evaluation and scoring, notifications, content and administration, files.

### 5.4 `ratify` (gate G1)

Inputs: the archaeology PRs. This stage is human. For each domain Alex reads
the summary page and rules per criterion: contract, defect, edit, obsolete, or
spike. Bulk rulings are allowed where the agent's confidence is `confirmed` and
reconciliation is `aligned`; the agent's `conflicting` and `open` rows are
listed first. A `defect` ruling records the current behaviour as a known
defect and drafts a replacement criterion, so the rebuild does not reproduce
the bug. Merging the PR mints permanent `R-` IDs (`scripts/mint-ids.mjs`) and
sets state `accepted`. Checks: no `inferred` or `open` criterion merges; every
`defect` has a replacement or an explicit "no replacement" note. Exit: every
domain PR merged or closed with a reason.

### 5.5 `derive-tests`

Inputs: `spec/` only. Skill: the test derivation skill. Workspace: a
materialised directory containing `spec/` and `tests/seed/` and nothing else,
created by `git archive` of those paths at the accepted commit. Outputs, one
PR: acceptance tests with provenance headers and the abstract surface they
require (`tests/surface.d.ts`, generated from `surface.yaml`). Checks:
provenance header present and matching an accepted criterion at its current
version; separation lint passes; every accepted criterion has at least one
test or an explicit `not-testable` note with a reason. Exit: PR merges with a
named human approval, carrying `provenance: blind`. If a person edits a test outside the blind
workspace, the check marks it `provenance: unverified`, which at the default
tier requires a named attestation in the PR.

### 5.6 `bind-adapter`

Inputs: `surface.yaml`, a running target. Workspace: `tests/adapters/<target>/`
plus a browser against the target. The agent may read rendered pages, never
source. Output: the adapter. Checks: separation lint; every surface action and
observation is bound or marked `unbound` with a reason. Exit: adapter PR
merges. For the new target the adapter is mostly generated from `surface.yaml`
test IDs.

### 5.7 `calibrate` (rebuild profile)

Inputs: the old target running from its compose file with seed loaded, the
merged tests and old adapter. Output: `tests/results/old/<date>.json`, one
row per criterion: pass, fail, unbound, not-testable. Every fail opens a ratify
item with the test's expectation and the observed behaviour side by side.
Rulings: `defect-in-old` (keep the test; the rebuild must pass it), `spec-wrong`
(edit the criterion, which bumps its version and marks the test stale), or
`test-wrong` (back to `derive-tests` for that criterion, still blind). Exit: no
row is `fail` without a ruling. Deterministic. Re-run safe.

### 5.8 `design` (gate G-DESIGN)

Inputs: accepted criteria, `surface.yaml`, the constitution, the BC Design
System packages and their agent instructions. Skills: Crow's UX skill for
design-system and accessibility rules, the design spec template, and
mattpocock's prototype skill for producing radically different variants of a
screen when a direction is undecided. Workspace: `design/`, `spec/`,
`constitution.md`. Outputs: `DESIGN.md`, the catalogue, and the test IDs written
back into `surface.yaml`. Checks: every screen in `surface.yaml` has a story for
every state it declares; Storybook's accessibility addon reports no violations;
no hard-coded colour values. Exit: Inderdeep approves the catalogue PR. His
review is the gate; his findings are filed as design criteria where they change
behaviour.

### 5.9 `plan` (gate G2)

Inputs: accepted spec, contract, design, stack profile. Skill: the planning
skill using spec-kit's plan template and the stack profile's standards.
Outputs: `plan/plan.md`, `plan/tasks.md` cut into vertical slices, a data
model note stating which existing tables are kept as-is and which need change,
and any architecture decision records. Checks: constitution check section
completed; every task names its criteria; no criterion is unassigned. Exit:
plan PR merges.

### 5.10 `build` (one run per slice)

Inputs: one slice from `tasks.md`, the contract, the design catalogue's
components, the stack profile. Skills: the stack profile's standards skill,
TDD at seams and code review from mattpocock/skills, and optionally the
ponytail scope brake (a lens that makes the agent prefer the smallest change
that works), enabled per config and measured. Workspace: `app/`, `plan/`,
`spec/contract/`, `design/`. Not `tests/acceptance/`. Output: an
implementation PR with an evidence receipt. Checks: unit tests and type check
green; separation lint; evidence appended; PR touches implementation paths;
constitution forbidden-pattern scan. Exit: post-checks green, then `verify`.

### 5.11 `verify`

Inputs: the built application in a sandbox environment, the acceptance suite,
the new adapter. Output: `tests/results/new/<slice>-<attempt>.json`. Failure
classification and routing are in section 7. Exit: every criterion the slice
claims is `pass`, or ruled.

### 5.12 `review-and-ship` (gate G3)

Inputs: the implementation PR, verify results, evidence receipt. Skill: the
review contract: read the slice's criteria, the plan, the scenario, and the
running sandbox before writing; define every term; attach evidence to every
finding; report what could not be checked. Output: a review comment in the
contract format, and a draft of any spec delta the review surfaced. The human
decision is the PR approval and merge. A blocking finding returns the PR to
`build` with the finding as input. Exit: merged by a named human.

### 5.13 `deploy`

Inputs: the merged main branch. Mechanism: the stack profile's deploy workflow,
which for the OpenShift stack calls the `bcgov/quickstart-openshift-helpers`
workflows to build images and deploy to a sandbox namespace. Checks: the
GitHub Actions hardening rules from `bcgov/agent-skills` are applied to every
workflow; no deploy credential is available to any agent stage. Exit: the
sandbox answers its health check and the acceptance suite passes against it.

### 5.14 `operate`

Inputs: the deployed sandbox, its logs and metrics. Output: intents. A monitor
per criterion where the criterion makes a production promise; an anomaly
drafts a spec delta and a candidate fix, which enters at `intent` through the
front door. First increment: the weekly metrics collector and the statistical
band detector from Kaegan's pack, ported. Second increment: an SRE agent
reading OpenShift logs over an MCP server, which is the validation Justin asked
for. Not in the first pass beyond the metrics collector.

### 5.15 `status`

Deterministic. Regenerates the state site locally or in CI. No agent.

---

## 6. Gates and policy

### 6.1 The gates

| Gate | Decides | Artifact judged | Holder for this run |
|---|---|---|---|
| G0 intent | Is this the right problem and outcome? | `intent/<slug>.md` | Product-owner persona agent, Alex on escalation |
| G1 ratify | Is this criterion the contract, or a defect? | Domain summary page plus criteria list | Alex |
| G-DESIGN | Does the catalogue show the intended experience, accessibly? | Storybook catalogue plus `DESIGN.md` | Inderdeep |
| G2 plan | Is the architecture sound and every criterion assigned? | `plan.md` | Architect persona agent, Alex on escalation |
| G3 review and ship | Does the PR do what the slice said, with evidence? | PR with review comment and receipt | Reviewer persona agent, Alex on escalation and weekly sample |
| G-POL policy | May the policy change? | `.sdlc/config.yaml` policy section | Alex |

Every gate is a proposal branch with a generated decision page that leads with
the question, the recommendation, and a link to the page on the state site.
With a remote, the proposal is a pull request and approval is the PR approval.
Without one, approval is a signed commit on the branch made by the runner on
the holder's behalf. Return is "request changes" with a comment, which the
runner feeds back to the producing stage as input.

### 6.2 Gate holders can be agents

A gate holder is a role, and the config binds each role to a person or to a
persona agent. During pipeline testing most gates are agent-held so a full run
does not wait on a human at every step, which is what Kaegan did in his rematch
with simulated checkpoints. Rules that make this safe rather than a rubber stamp:

- A persona agent has a written brief (`personas/<role>.md`): what it cares
  about, what it must refuse, and when it must escalate. The product-owner
  persona refuses any criterion still marked `inferred` or `open`; the
  UX-reviewer persona refuses a catalogue with accessibility violations.
- An agent ruling carries a rationale and is recorded as `held-by: agent`, so
  the gate log and the state site show which decisions a person has not seen.
- Escalation is mandatory when the item is HIGH or CRITICAL tier, when the
  producing stage's confidence is below its threshold, or when the persona's
  brief says so. Escalated items wait for the human bound to the role.
- A human samples agent-held decisions: the config sets a sample size per gate
  per week, and the sample is listed on the state site for review.
- Switching a gate from agent to human, or back, is a G-POL change.

For the marketplace run: phase 1 ratify and phase 3 design are human-held from
the start, because those rulings are the experiment's evidence. G0, G2 and G3
begin agent-held with a weekly human sample, and Alex can take any gate back at
any time by editing the config.

### 6.3 Tiers and the short circuit

Risk tiers from the prototype (LOW, STANDARD, HIGH, CRITICAL) are supported in
the config schema and every criterion carries one, defaulting to STANDARD. For
this run every gate is held by a human regardless of tier, because the point
is to observe. The one automation kept is the short circuit: a change the
triage script classifies as `direct` (few files, additive, inside allowed
paths, no criterion change) skips G2 and gets a lighter G3. Anything else is
`pipeline`. The runner labels the PR with the mode.

Autonomy rungs (an agent earning the right to merge a class of change) are in
the schema and disabled. Enabling one is a G-POL change with evidence attached.

### 6.4 What "unverified provenance" costs

A test whose provenance is `unverified` (edited outside the blind workspace):
LOW and STANDARD, allowed with a named attestation in the PR; HIGH and
CRITICAL, blocked until re-derived blind.

---

## 7. Verification loop and internals

### 7.1 Failure routing after `verify`

Each failing criterion is classified once, by the verify skill, with the
evidence attached, and the runner routes it:

| Class | Meaning | Route | Bound |
|---|---|---|---|
| `impl-defect` | The test is right and the code is wrong | Back to `build` with the failure as input | 3 attempts per criterion per slice, then the slice stops and the PR is marked blocked for a human |
| `spec-ambiguity` | Test and code read the criterion differently | Ratify item; criterion edited, version bumped, test marked stale | Human |
| `test-defect` | The test does not follow from the criterion | Back to `derive-tests` for that criterion, blind | 2 attempts, then human |
| `adapter-defect` | The surface binding is wrong | Back to `bind-adapter` | 2 attempts, then human |
| `env-defect` | The sandbox, seed or observable is broken | Runner halts the slice, reports | Human |

Misclassification is itself measured: a criterion that bounces between classes
more than twice is escalated with the history.

### 7.2 Staleness and versions

A criterion's version bumps on any wording change. A test whose header names an
older version is `stale`: it still runs, its result is reported separately, and
it does not count toward verified. `derive-tests` re-derives stale tests only.
A slice that claims a stale criterion cannot pass verify.

### 7.3 Interrupted and partial runs

Every stage writes its progress as commits on its branch. The run record
(`docs/runs/`) notes the stage, slice, attempt and last commit. `sdlc resume`
continues from the run record. A stage that was interrupted before its
post-checks re-runs its post-checks first.

### 7.4 What "done" means for a slice

All of: every criterion the slice claims is `pass` on the new target and not
`stale`; unit tests and type check green; evidence receipt appended; no
constitution forbidden-pattern hit; G3 merged by a named human; sandbox
deployed and health check green. The runner records elapsed time from slice
start to merge, review cycles (count of "request changes"), and verify attempts.

### 7.5 Concurrency

Two slices may run in parallel only if `tasks.md` marks them independent (no
shared files declared). Otherwise the runner serialises. Merge conflicts are an
`impl-defect` routed to `build` with the conflict as input.

### 7.6 Secrets and personal data

Agent stages receive no deploy credential, no database credential for anything
but the local compose targets, and no production data. Seed data is synthetic.
The old application's SQL fixtures are reused only after a scan for real names
and addresses. The egress filter (section 10) runs before any agent output is
posted to GitHub.

### 7.7 Budgets

Each stage has a token budget in config. Exceeding it stops the stage with a
report; it never silently truncates. The run record carries tokens per stage,
which feeds the metrics.

---

## 8. Runner

`bin/sdlc`, a Node CLI with no dependencies beyond git and the GitHub CLI.

```
sdlc init                       install into the current project
sdlc run <stage> [--slice N] [--target old|new] [--domain X]
sdlc resume
sdlc status                     regenerate and open the state site locally
sdlc calibrate --target old     shorthand for run calibrate
sdlc upgrade                    bump the pinned pipeline version
sdlc doctor                     check tools, tokens, targets, and config
```

Locally, a stage's agent step is `claude -p` with the stage skill and the
materialised workspace. In CI, the same scripts run inside the reusable
workflow and the agent step is whichever cloud executor the config names. The
contract for an executor is: given a workspace directory, a skill, and a task
file, produce commits on a branch. Nothing else about the pipeline changes
between local and cloud.

State is git plus GitHub. The runner keeps no database. The run record is a
Markdown file per run, appended, and it is an input to the metrics script.

---

## 9. Configuration

`.sdlc/config.yaml`, validated against `schema/config.schema.json`.

```yaml
pipeline: bcgov/agentic-sdlc@v0.3.0
profile: rebuild                   # greenfield | rebuild | remediation | feature
stack: openshift-ts                # a stack profile in the pipeline repo
project:
  name: digital-marketplace-next
  domains: [opportunities, proposals, organizations, users, evaluation, notifications, content, files]
sources:
  old:
    repo: https://github.com/bcgov/digital_marketplace
    commit: b0f0c99c
    docs: [README.md, docs/]
    exclude: [cypress/, tests/]     # the old tests never reach the spec
oracle:
  target: old
  compose: sources/old/docker-compose.yml
  seed: tests/seed/
  base_url: http://localhost:3000
  identity: session-route           # how a test signs in on this target
targets:
  new:
    base_url: http://localhost:8080
    identity: test-idp
policy:
  gates:
    G0: {holder: agent:product-owner, escalate_to: alex}
    G1: {holder: alex}
    G-DESIGN: {holder: inderdeep}
    G2: {holder: agent:architect, escalate_to: alex}
    G3: {holder: agent:reviewer, escalate_to: alex, human_sample_per_week: 5}
    G-POL: {holder: alex}
  default_tier: STANDARD
  rungs: {}                         # none earned
  triage: {direct_max_files: 3, direct_allowed_paths: [app/]}
  budgets: {archaeology: 4M, derive-tests: 2M, build: 3M, review: 1M}
skills:
  packs:
    - mattpocock/skills@<sha>: [grilling, domain-modeling, prototype, tdd, code-review]
    - bcgov/crow@v0.6.0: [crow-bcgov-ux]
    - bcgov/agent-skills@<sha>: [github-actions, openshift-deployment]
    - DietrichGebert/ponytail@<sha>: {enabled: false}
  extra: []                         # project-local skills
egress:
  rules: [E-1, E-2, E-3, E-4]
```

Profiles select stages and defaults. A project may add or remove skill packs
and override any policy value within the constitution's floor. The schema
rejects unknown keys, so a typo is an error rather than a silent default.

---

## 10. Egress rules (public repositories)

From the prototype, applied because both repositories are public.

| Rule | Blocks or strips | Held by |
|---|---|---|
| E-1 | Live-environment observations: namespace values, logs, connection details | Filter job before any agent comment posts |
| E-2 | Internal references: ticket numbers, meeting references, personal notes | Same |
| E-3 | Per-person metrics leaving the private run record | Metrics script publishes aggregates only |
| E-4 | Participant names in evidence records | Intent skill anonymises before filing |

The agent never posts to GitHub directly. It writes to a buffer; a separate
step with its own token applies the filter, posts the filtered version, and
logs every strip in the run record. This is a process control and it is stated
as one: a filter catches patterns it knows about.

---

## 11. Dependency register

Every external thing the pipeline uses, with why. Versions are pinned in the
pipeline's own lockfile. A weekly workflow diffs each against upstream and
opens a PR with the changes and a summary. The full register is
`docs/dependencies.md`; this is the initial content.

| Dependency | Used for | Taken as | Why this one |
|---|---|---|---|
| github/spec-kit | Spec, plan, tasks, constitution, checklist templates | Copied templates with attribution | The most-used templates for this shape; the process and CLI are not used because the runner owns the process |
| Kaegan's tier2-v3 pack (from `bcgov/bcparks-ar-admin-agentic`) | Constitution platform articles, provenance header check, triage direct/pipeline, checkpoint gate, harness evals, metrics collector, band detector, evidence receipt | Ideas and ported scripts; source repo is not public | Already run on a real BC Gov repo; the BC platform articles are right |
| mattpocock/skills | grilling, domain-modeling, prototype, tdd, code-review | Editable copies via `npx skills add`, pinned | Small, composable, model-agnostic; grilling is the intent interview, tdd defines seams, prototype produces UI variants |
| bcgov/crow | crow-bcgov-ux and the `DESIGN.md` template; business-rules data shape as a reference | Skill copied; schema referenced | BC Design System and WCAG guidance written for BC Gov; the rule schema has stable IDs, citations and reconciliation |
| bcgov/design-system | React components, tokens, BC Sans, and the packages' own agent instructions | npm dependencies of the project | The design system, and it ships instructions for agents |
| bcgov/agent-skills | github-actions hardening, openshift-deployment | Installed via `npx skills add`, pinned | Org-maintained; the Actions hardening rules are specific and correct |
| bcgov/agent-guardrails | Shell wrappers blocking merge, hook bypass, live cluster access | Installed on every machine that runs the pipeline | Cheap enforcement of "agents propose, never merge" |
| bcgov/quickstart-openshift and -helpers | The `openshift-ts` stack profile's scaffold and deploy workflows | Referenced by version | Org-maintained, current, deploys to the platform the marketplace runs on, already uses central workflows |
| DietrichGebert/ponytail | Scope brake during build | Optional pack, disabled by default | Honest benchmarks; may hurt with reasoning models, so measured before kept |
| Playwright, Vitest, Storybook | Acceptance tests, unit tests, catalogue | Project dev dependencies | Standard; Storybook is what Inderdeep already uses |
| microsoft/AI-Engineering-Coach | Session-log review to find repeated prompts worth turning into skills | Phase 5 retrospective tool only | Not part of the pipeline |
| Rog's requirements materials | Confidence ledger, ID-at-ratification rule, four-facet requirement template, the oracle-independence argument | Rules adopted | Empirical basis for blindness |

Not adopted, with reasons recorded in the register: caveman (compresses prose
the gates need readable), rl-project-template (Emerald and .NET specific),
raven and rook (later, for Jira and monitoring), spec-kit's CLI.

---

## 12. Stack profile `openshift-ts` and standards

The first stack profile, and the one the marketplace uses.

- **Scaffold**: `bcgov/quickstart-openshift`. React, Vite, TanStack Router,
  BC Design System React components on the front end. NestJS with Prisma on
  the back end. Postgres. Playwright and Vitest. ESLint and Prettier as
  configured there.
- **Database**: the existing marketplace schema is kept. Prisma introspects
  it. Schema changes, if any, are proposed in the plan with a migration and a
  ratified criterion behind each.
- **Authentication**: Keycloak OpenID Connect as today, plus the test identity
  mechanism from the contract, enabled only in sandbox.
- **Standards skill** (`stacks/openshift-ts/SKILL.md`): folder layout, naming,
  error handling, structured logging, API conventions (OpenAPI first, the
  contract is the source), validation at the boundary, testing rules (unit at
  seams, acceptance only from spec), accessibility, plain language at Grade 8.
  Drawn from bcgov/agent-instructions, the design system's agent instructions,
  and Ryan Loiselle's coding standards, and recorded with sources.
- **Deploy**: per-PR sandbox and a persistent sandbox namespace through the
  quickstart helpers. No route to any production namespace exists in the
  project's workflows.

Why this stack: the org maintains it, it runs on the platform the marketplace
runs on today, it already references central workflows by version, it is
TypeScript end to end like the current application so shared domain types can
be carried over, and it has the design system built in.

---

## 13. Metrics

Collected by `scripts/collect-metrics.mjs` from the run record, git and the
GitHub CLI; published as aggregates on the state site.

| Metric | Why |
|---|---|
| Review cycles per PR | Isolates agent quality from reviewer availability |
| Verify attempts to green, per slice | Same |
| Elapsed time per slice, start to merge | The throughput claim |
| Parity: criteria verified on new target over criteria verified on old | The "recoded accurately" claim |
| Failure classes per slice | Where the pipeline loses time |
| Tokens per stage | Cost |
| Ratify rulings by kind, per domain | How much of the old system was defect |
| Gate decision time | The cost of judgement, which the prototype names |

Time-to-close a PR is deliberately not a headline metric. It measures reviewer
availability.

---

## 14. Testing the pipeline itself

- **Harness evals** (`evals/`): prompt-and-check tasks that assert the agent
  follows a rule: refuses to merge, refuses to read `app/` in derive-tests,
  queries the design system before UI, keeps constitution articles. Run when a
  skill, template or script changes.
- **Structural checks**: deterministic assertions on artifact shape, run on
  every PR in both repos.
- **Fixture project**: a two-screen application with a known old version and a
  planted defect. The pipeline's CI runs the rebuild profile on it end to end
  with a mock executor. A pipeline change that breaks a stage breaks this.
- **The marketplace run**: the real test. Its run record is the evidence.

---

## 15. The marketplace run, phase by phase

| Phase | Stages | Exit criterion | Gate holder |
|---|---|---|---|
| 0 Harness | Create both repos locally, `sdlc init`, constitution, config, guardrails, persona briefs | Checkpoint checks green on an empty proposal branch | Alex |
| 1 Spec | `intent`, `archaeology` per domain, `ratify` | Every domain ratified; `criteria-index.json` has no `inferred` or `open` accepted rows | Alex |
| 2 Tests | `derive-tests`, `bind-adapter old`, `calibrate` | Every calibrate row is pass or ruled | Alex |
| 3 Design | `design` | Catalogue approved | Inderdeep |
| 4 Build | `plan`, then per slice `build`, `verify`, `review-and-ship`, `deploy` | Every slice done per section 7.4; parity metric reported | Alex |
| 5 Rails | `operate` metrics, one feature through the full chain, one trivial change through the short circuit, harness improvements from the run record | The pipeline version bumps; rebuild two starts from the same config | Alex |

Slice order for phase 4, first pass: public opportunity listing and detail;
sign-in and organisation management; vendor proposal submission for Code With
Us; government opportunity creation and publishing; evaluation and award;
Sprint With Us and Team With Us variants; notifications; administration and
content.

---

## 16. Open questions and risks

1. **Test identity on the new target.** The old application uses a
   development-only session route per role. The new one needs an equivalent
   that is safe to ship disabled. Decided at G2.
2. **Observing email.** The old application sends real mail. Calibration of
   notification criteria may be limited to the API surface. Decided at ratify.
3. **Kaegan's pack source.** Not public. The pipeline ports the ideas and the
   scripts from the installed copy. Asking Kaegan for the source and his two
   MCP servers is worthwhile but not blocking.
4. **Storybook for page stories.** Legitimate and common, but page stories
   with mocked data can drift from real data shapes. The catalogue's stories
   use the same seed fixtures the tests use.
5. **Ponytail with reasoning models.** May increase tokens. Off by default,
   measured on one slice before a decision.
6. **Public repositories.** The egress filter is a pattern filter. The private
   run record is the safe default; publish selectively.
7. **Old fixtures containing real-looking data.** Scan before reuse.

---

## Glossary

- **Adapter**: the binding of the abstract test surface to one target's real
  locators or endpoints. Locators only, never assertions.
- **Archaeology**: an agent reading an existing system's code, history and
  documents to write what it currently does, as recovered criteria.
- **Blind**: a test-derivation session that sees the spec bundle and nothing
  else, so its tests cannot copy the implementation's mistakes.
- **Calibrate**: running the blind suite against the old application to find
  which failures are recovered bugs and which are wrong tests, before any new
  code exists.
- **Contract**: the part of the spec that tests need to act and observe:
  personas, routes, labels, test IDs, the API description, observables, seed.
- **Coverage states**: proposed, accepted, implemented, verified, monitored.
- **Criterion**: the smallest testable promise about behaviour, with a
  permanent ID and a version.
- **Gate**: a human decision point, expressed as a pull request approval.
- **Harness evals**: regression tests for the pipeline's own rules.
- **Oracle**: an independent source of truth for what is correct. Here, the
  old application during calibration, and the spec everywhere else.
- **Profile**: a preset of stages and defaults: greenfield, rebuild,
  remediation, feature.
- **Provenance**: the record of what an artifact was derived from; on a test,
  the criterion and version it came from and whether it was derived blind.
- **Ratify**: the human act of turning a recovered or proposed criterion into
  the contract, or ruling it a defect.
- **Short circuit**: the triage rule that lets a trivial change skip the
  spec-plan-approve chain.
- **Slice**: a vertical piece of work that delivers one or more scenarios end
  to end.
- **Stack profile**: an opinionated scaffold plus a standards skill, selectable
  in config.
- **Surface**: the abstract set of actions and observations tests call,
  defined in the contract.

#!/usr/bin/env python3
"""Build the reference poster for the agentic SDLC pipeline design spec.

    python3 build_poster.py
    python3 "$POSTER_KIT_DIR"/check_svg.py pipeline-poster.svg --margin 20

POSTER_KIT_DIR points at the research-poster kit and defaults to
~/.claude/skills/research-poster/scripts.

Colour axis, held across the whole poster:
  green = deterministic, blocks or enforces     gold = human judgement, a gate
  navy  = agent work, proposals                  red  = forbidden, never automated
"""

import os, sys
POSTER_KIT_DIR = os.environ.get("POSTER_KIT_DIR", os.path.expanduser("~/.claude/skills/research-poster/scripts"))
sys.path.insert(0, POSTER_KIT_DIR)
from poster_kit import Poster, BCGOV

HERE = os.path.dirname(os.path.abspath(__file__))
p = Poster(theme=BCGOV)

p.header(
    title="Agentic SDLC pipeline",
    subtitle="Proven by rebuilding the Digital Marketplace on a modern stack",
    eyebrow="Design spec on one page",
    meta_left="Executor: local Claude Code   |   Gates: pull requests or local branches   |   State: git, no database",
    right_lines=["2026-09-05 · draft",
                 "Spec: docs/specs/2026-09-05-…-design.md",
                 "",
                 "Colour: green blocks · gold judges · navy proposes · red never"],
)

# 01 ---------------------------------------------------------------------------
p.section("01", "What is being built, and why this project",
          blurb="Two products built together. The pipeline is the deliverable other teams "
                "install. The marketplace rebuild is the evidence it works, and the first "
                "opinionated stack it encodes. It is an experiment on a new repository with "
                "no business owner: nothing ships to the live product.")

p.cards([
    {"title": "The pipeline", "acc": "navy",
     "badge": ("The product", "tint"),
     "lead": "Skills, scripts, workflows, templates and a runner, versioned in one repo.",
     "items": ["Installs into any project by reference, upgrades by bumping a version.",
               "Profiles: greenfield, rebuild, remediation, feature.",
               "Configurable opinions, fixed primitives."]},
    {"title": "The marketplace rebuild", "acc": "navy",
     "badge": ("The evidence", "tint"),
     "lead": "Same behaviour, modern stack, existing Postgres schema kept, deployed only to non-production environments.",
     "items": ["Old repo is a read-only input named in config.",
               "Rebuild reuses spec and tests; replay starts over from the old repo and diffs against the ratified baseline.",
               "Spec and tests are the durable assets; every build is disposable."]},
    {"title": "Why a rebuild beats pure greenfield", "acc": "green",
     "badge": ("Measurable", "ok"),
     "lead": "An existing system is an oracle, so accuracy becomes a number.",
     "items": ["Parity: criteria verified on new over criteria verified on old.",
               "Real complexity for free: scoring, deadlines, three roles, Keycloak.",
               "Cost: archaeology and ratification overhead."]},
    {"title": "What is deliberately not built", "acc": "red",
     "badge": ("Non-goals", "bad"),
     "items": ["No decisions database, approval UI, policy editor or accounts.",
               "No agent framework: skills are configuration.",
               "No cloud agent as primary executor in this run.",
               "No change to the live marketplace or its operations."]},
])

p.band("The claim the run exists to test",
       "A team can install the pipeline, run a real application through it end to end, "
       "and get a rebuild that passes the same spec-derived test suite the original "
       "passes, with human judgement spent only at prepared gates.",
       tone="navy", acc="gold")

# 02 ---------------------------------------------------------------------------
p.section("02", "The one idea, and six rules that follow from it",
          blurb="Every piece of work traces to a criterion: the smallest testable promise about "
                "behaviour, with a permanent ID and a version. Tests derive from it, code "
                "satisfies it, reviews check it, and its state is visible on one page.")

p.chain([
    ("Proposed", "An agent or person drafts a criterion. Nothing is built from it."),
    ("Accepted", "A human ratifies it at gate G1. The permanent R-ID is minted here."),
    ("Implemented", "Code claims it in a slice. Recovered criteria enter the board here."),
    ("Verified", "A blind test derived from the spec passes against the deployed app."),
    ("Monitored", "A monitor watches the promise in a running environment."),
], highlight=[1, 3])

p.cards([
    {"title": "Checks block, agents advise, humans judge", "acc": "green",
     "items": ["Anything that must always happen is a script or branch rule.",
               "Never a request to an agent."]},
    {"title": "Agents propose, humans ratify", "acc": "gold",
     "items": ["Nothing enters the spec or merges without a named human,",
               "or a written, expiring policy that allows it."]},
    {"title": "Tests never see code", "acc": "red",
     "items": ["Test derivation sees the spec bundle and nothing else.",
               "Enforced by what is on disk, verified by provenance."]},
    {"title": "One front door", "acc": "navy",
     "items": ["Every change, even an agent-drafted fix, enters as a proposal.",
               "Same gates, no side entrances."]},
    {"title": "Derivable from git", "acc": "green",
     "items": ["Coverage, gate history, evidence and metrics are recomputed.",
               "No second store to drift."]},
], title_size=15.5, item_size=12.6)

p.band("Sixth rule: public by default, so egress is a control",
       "The intended remotes are public bcgov repositories. Live-environment detail, "
       "certificates, namespace values, internal ticket numbers, personal notes and "
       "per-person metrics never enter them, and neither do colleagues' names, ticket numbers "
       "or private notes. Nothing is pushed anywhere without the tech lead's permission at that moment.",
       tone="bad", acc="red")

# 03 ---------------------------------------------------------------------------
p.section("03", "Two repositories, installed by reference, configured not forked",
          blurb="Both are local git repositories until a step genuinely needs a remote. "
                "The pipeline repo is the product; the project repo holds everything about "
                "one application, including the generated state site.")

p.cards([
    {"title": "Pipeline repo: agentic-sdlc", "acc": "navy",
     "lead": "What a team installs and keeps current.",
     "items": ["skills/<stage>: agent instructions per stage.",
               "scripts/: deterministic checks and generators.",
               "workflows/: reusable Actions, called by version.",
               "templates/, profiles/, stacks/<name>/, schema/.",
               "bin/sdlc: the runner CLI.",
               "evals/ and fixture-project/: tests of the pipeline itself.",
               "docs/: stage contracts, config, dependency register, run records."]},
    {"title": "Project repo: the marketplace rebuild", "acc": "navy",
     "lead": "Everything about one application, all of it files.",
     "items": [".sdlc/config.yaml, lock.json, personas/<role>.md.",
               "constitution.md, intent/, spec/ with features and contract.",
               "tests/acceptance, adapters/<target>, seed.",
               "design/DESIGN.md and design/catalogue (Storybook).",
               "plan/, app/, evidence/pr-evidence.md.",
               "site/: generated state site."]},
    {"title": "Install, upgrade, run", "acc": "green",
     "lead": "Nothing from the pipeline is copied except templates to fill in.",
     "items": ["sdlc init: validate config, write lockfile, generate callers, install skill packs at pinned versions.",
               "sdlc upgrade: bump the version, regenerate, open a proposal.",
               "sdlc run <stage>, resume, status, doctor.",
               "Workflows referenced like quickstart-openshift references its helpers."]},
    {"title": "Configuration in four parts", "acc": "gold",
     "lead": "Schema-validated; unknown keys are errors, not silent defaults.",
     "items": ["sources: old repo at a commit, docs, what to exclude.",
               "target: stack profile, deploy target, test identity.",
               "policy: gate holders, tiers, rungs, triage limits, budgets.",
               "oracle: compose file, seed, base URL.",
               "skills: packs by version; extra project-local skills."]},
], item_size=12.6)

# 04 ---------------------------------------------------------------------------
p.section("04", "The artifacts: the files the pipeline produces, who makes each, and where it is judged",
          blurb="Everything the pipeline knows is a file in the project repo. Each card names the "
                "file, the stage that writes it and the gate that rules on it. Navy: written by an "
                "agent. Gold: owned or ruled by a human. Green: generated by a script.")

p.cards([
    {"title": "Constitution", "acc": "gold",
     "badge": ("onboarding · team-owned", "warn"),
     "lead": "The rules of the project. Platform rules no project may loosen, plus the project's own.",
     "items": ["Accessibility, design system, privacy before personal data, deploy target, spec in git, human checkpoints, test integrity, approved tools.",
               "Project part: purpose, scope, forbidden patterns, glossary, baselines, recorded exceptions."]},
    {"title": "Intent", "acc": "navy",
     "badge": ("intent stage · gate G0", "tint"),
     "lead": "Why, for whom, what outcome. Written by interview, technology-free.",
     "items": ["Problem, measurable outcome, users, constraints, evidence, open questions."]},
    {"title": "Spec", "acc": "navy",
     "badge": ("archaeology or intent · gate G1", "tint"),
     "lead": "What the system must do, as criteria a test can check.",
     "items": ["Each criterion has an ID that never changes, a version that bumps on any rewording, and a confidence mark.",
               "Confidence: confirmed, inferred, open. Nothing ratifies while inferred or open.",
               "Recovered criteria say where in the old code they came from."]},
    {"title": "Contract", "acc": "navy",
     "badge": ("archaeology, design · G1, G-DESIGN", "tint"),
     "lead": "Everything a test needs in order to act and observe, written down before any code.",
     "items": ["Who the users are, and how a test signs in as each.",
               "The pages, what you can do on each, and the test IDs the new app must carry.",
               "The API description; how side effects are seen (a catch-all mailbox); the seed data."]},
], item_size=12.4)

p.cards([
    {"title": "Tests and adapters", "acc": "navy",
     "badge": ("derive-tests, bind-adapter · approval", "tint"),
     "lead": "Tests derived from the spec alone; adapters connect them to a running app.",
     "items": ["Every test names its criterion and version, and whether it was derived blind.",
               "Adapters hold locators only, never an expectation.",
               "A lint rule keeps selectors out of tests and app code out of the test folder."]},
    {"title": "Design spec and catalogue", "acc": "navy",
     "badge": ("design stage · gate G-DESIGN", "tint"),
     "lead": "The design rules, plus every screen in every state as Storybook pages.",
     "items": ["Built with the BC Design System React components.",
               "Fixes the test IDs the new app must carry.",
               "The UI building blocks made here are the ones the app uses."]},
    {"title": "Plan, tasks, evidence", "acc": "navy",
     "badge": ("plan, build · gates G2, G3", "tint"),
     "lead": "How it will be built, cut into slices; and a receipt per change.",
     "items": ["Every task names its criteria; no criterion is left unassigned.",
               "Receipt per change: what was checked, what could not be, what risk remains. Append-only."]},
    {"title": "State site", "acc": "green",
     "badge": ("status script · no gate", "ok"),
     "lead": "The page you judge everything against, recomputed from files.",
     "items": ["Coverage board, one page per criterion, ratify queue, gate log, run log.",
               "Each gate links to the page it should be judged against."]},
], item_size=12.4)

# 05 ---------------------------------------------------------------------------
p.section("05", "Fifteen stages, each a contract: inputs, outputs, workspace, checks, exit",
          blurb="The runner materialises a workspace, runs pre-checks, launches the agent "
                "non-interactively with the stage skill, runs post-checks, opens a proposal "
                "and appends to the run record. Every stage is re-runnable and no stage "
                "mutates another's outputs.")

p.chain([
    ("init", "Config to lockfile, callers, templates, skill packs."),
    ("intent", "Grilling interview. Gate G0."),
    ("archaeology", "Old code, docs, history to recovered criteria. Never the old tests."),
    ("ratify", "Human rules contract, defect, edit, obsolete, spike. Mints IDs. Gate G1."),
    ("derive-tests", "Spec only on disk. Blind tests with provenance."),
], highlight=[3])

p.chain([
    ("bind-adapter", "Walk the running target; record locators, never source."),
    ("calibrate", "Blind suite against the old app. Every fail gets a ruling."),
    ("design", "DESIGN.md and catalogue. Gate G-DESIGN."),
    ("plan", "Architecture, data model, slices. Gate G2."),
    ("build", "One slice, tests written first at agreed module boundaries, evidence receipt."),
], highlight=[2, 3])

p.chain([
    ("verify", "Acceptance suite against the sandbox; failures classified and routed."),
    ("review-and-ship", "Review contract, then a named human merges. Gate G3."),
    ("deploy", "Deploy workflow to a non-production OpenShift namespace. No agent holds a credential."),
    ("operate", "Metrics, band detector, later an SRE agent over MCP. Anomalies re-enter at intent."),
    ("status", "Regenerate the state site. No agent."),
], highlight=[1])

p.band("Profiles select stages",
       "greenfield skips archaeology and calibrate · rebuild runs everything · remediation "
       "skips intent and design · feature runs the short chain. The marketplace is the "
       "rebuild profile. A trivial change takes the short circuit regardless of profile.",
       tone="tint", acc="navy")

# 06 ---------------------------------------------------------------------------
p.section("06", "Gates and policy: six decisions, each a proposal with a one-page digest",
          blurb="A gate is a proposal branch with a generated decision page that leads with "
                "the question and the recommendation. With a remote it is a pull request; "
                "without one, approval is a signed commit made by the runner on the holder's behalf.")

p.cards([
    {"title": "G0 intent", "acc": "gold",
     "badge": ("agent-held, escalates", "tint"),
     "items": ["Is this the right problem and outcome?", "Judges intent/<slug>.md."]},
    {"title": "G1 ratify", "acc": "gold",
     "badge": ("tech lead", "warn"),
     "items": ["Contract or defect, per criterion, per domain.", "The experiment's evidence: human from the start."]},
    {"title": "G-DESIGN", "acc": "gold",
     "badge": ("UX reviewer", "warn"),
     "items": ["Does the catalogue show the intended experience, accessibly?", "Findings that change behaviour become criteria."]},
    {"title": "G2 plan", "acc": "gold",
     "badge": ("agent-held, escalates", "tint"),
     "items": ["Architecture sound, every criterion assigned?"]},
    {"title": "G3 review and ship", "acc": "gold",
     "badge": ("agent-held, sampled", "tint"),
     "items": ["Does the PR do what the slice said, with evidence?", "Five per week sampled by a human."]},
], title_size=15.5, item_size=12.4)

p.cards([
    {"title": "Gate holders can be persona agents", "acc": "navy",
     "lead": "So a full run does not wait on a human at every step while the pipeline is being tested.",
     "items": ["Each persona has a written brief: cares about, refuses, escalates.",
               "Rulings carry a rationale and are marked held-by: agent on the site.",
               "Mandatory escalation on HIGH or CRITICAL tier or low producer confidence.",
               "Weekly human sample per gate; switching holder is a G-POL change."]},
    {"title": "Tiers and the short circuit", "acc": "green",
     "lead": "Every criterion carries a tier: LOW, STANDARD, HIGH, CRITICAL. Default STANDARD.",
     "items": ["Triage labels a change direct or pipeline: few files, additive, allowed paths, no criterion change.",
               "direct skips G2 and lightens G3.",
               "Autonomy rungs exist in the schema and are disabled; enabling one needs evidence at G-POL."]},
    {"title": "What unverified provenance costs", "acc": "red",
     "lead": "A test edited outside the blind workspace is marked unverified.",
     "items": ["LOW and STANDARD: allowed with a named attestation.",
               "HIGH and CRITICAL: blocked until re-derived blind."]},
], item_size=12.6)

# 07 ---------------------------------------------------------------------------
p.section("07", "Blind tests, adapters and the old application as oracle",
          blurb="The bridge between tests that never saw code and code that never saw tests "
                "is a contract written before either: personas, routes, labels, test IDs, "
                "the API description, observables and seed. Both sides implement it.")

p.steps_pair(
    left={"label": "Derive and calibrate", "acc": "navy",
          "sub": "Tests come from the spec bundle. The old app tells us which failures are real.",
          "steps": [
              ("Materialise a blind workspace", "git archive of spec/ and tests/seed/ only. No app, no old tests."),
              ("Derive acceptance tests", "Playwright flows and API contract tests, calling the abstract surface."),
              ("Stamp provenance", "criterion @R-12.3 v2, provenance blind, spec commit."),
              ("Run against the old app", "Compose file, seed loaded, old adapter signs in the old app's own way."),
              ("Rule every failure", "defect-in-old keeps the test; spec-wrong bumps the version; test-wrong re-derives blind."),
          ]},
    right={"label": "Bind and separate", "acc": "green",
           "sub": "Adapters glue the surface to a target. Lint keeps expectations out of them.",
           "steps": [
               ("Old adapter", "Walk the running app in a browser; bind by role, label, text and URL. Rendered pages only."),
               ("New adapter", "Generated from surface.yaml test IDs fixed at the design gate."),
               ("Separation lint", "No assertion in an adapter; no selector, test ID or URL in a test; no app import in tests."),
               ("Old tests quarantined", "Fixtures reused as seed data after a scan; specs mapped for gaps; run only as a secondary signal."),
               ("Unreachable criteria", "Verified at the API, or marked not calibratable and ruled on evidence."),
           ]})

p.band("Why the oracle step exists",
       "A test that fails on the old application is either a recovered bug or a wrong test, "
       "and both go to the ratify queue. When the suite is green or every red is ruled, every "
       "expectation has been consciously judged before any new code exists. Without it, the "
       "first failure on the new app cannot say which side is wrong.",
       tone="tint", acc="gold")

# 08 ---------------------------------------------------------------------------
p.section("08", "The verification loop and the internals a spec usually leaves out",
          blurb="After a build, every failing criterion is classified once with evidence "
                "and routed by the runner. Bounds stop loops. Versions stop stale tests "
                "counting as green.")

p.cards([
    {"title": "impl-defect", "acc": "navy",
     "badge": ("back to build", "tint"),
     "items": ["Test right, code wrong.", "3 attempts per criterion per slice, then the slice blocks for a human."]},
    {"title": "spec-ambiguity", "acc": "gold",
     "badge": ("to ratify", "warn"),
     "items": ["Test and code read the criterion differently.", "Edit bumps the version; tests go stale."]},
    {"title": "test-defect", "acc": "red",
     "badge": ("re-derive blind", "bad"),
     "items": ["Test does not follow from the criterion.", "2 attempts, then human."]},
    {"title": "adapter-defect", "acc": "green",
     "badge": ("re-bind", "ok"),
     "items": ["Surface binding is wrong.", "2 attempts, then human."]},
    {"title": "env-defect", "acc": "red",
     "badge": ("halt", "bad"),
     "items": ["Sandbox, seed or observable broken.", "Runner stops the slice and reports."]},
], title_size=15.5, item_size=12.4)

p.cards([
    {"title": "Versions and staleness", "acc": "green",
     "items": ["Any wording change bumps the criterion version.",
               "A test naming an older version is stale: runs, reported apart, never counts as verified.",
               "A slice claiming a stale criterion cannot pass."]},
    {"title": "Done, for a slice", "acc": "green",
     "items": ["All claimed criteria pass and none stale.",
               "Unit tests and type check green; evidence appended.",
               "No forbidden pattern; G3 merged by a named human; sandbox healthy."]},
    {"title": "Resume, concurrency, budgets", "acc": "navy",
     "items": ["Progress is commits; the run record names stage, slice, attempt.",
               "Parallel slices only if tasks.md declares them independent.",
               "Token budget per stage; exceeding stops with a report, never truncates."]},
    {"title": "Secrets and personal data", "acc": "red",
     "items": ["No deploy or database credential reaches an agent stage.",
               "Seed is synthetic; old fixtures scanned first.",
               "Egress filter runs in a separate step with its own token before anything posts."]},
], item_size=12.6)

# 09 ---------------------------------------------------------------------------
p.section("09", "Stack, dependencies, metrics and the run by phase",
          blurb="One opinionated stack profile to start, every external piece pinned and "
                "registered with a reason, and a phase plan whose exit criteria are checks, "
                "not opinions.")

p.cards([
    {"title": "Stack profile openshift-ts", "acc": "navy",
     "lead": "Scaffold from bcgov/quickstart-openshift.",
     "items": ["React, Vite, TanStack Router, BC Design System components.",
               "NestJS, Prisma over the existing marketplace schema, Postgres.",
               "Keycloak OIDC; tests sign in through a sandbox identity provider.",
               "Standards skill: layout, naming, errors, logging, API-first, tests, accessibility, plain language.",
               "Why: org-maintained, same platform as today, central workflows by version, TypeScript end to end."]},
    {"title": "Taken, and from where", "acc": "green",
     "lead": "Pinned in a lockfile; a weekly job diffs upstream and opens a proposal.",
     "items": ["spec-kit: templates only, not the CLI.",
               "tier2-v3 pack (bcgov/bcparks-ar-admin-agentic): platform articles, provenance check, triage, evals, metrics, receipt.",
               "mattpocock/skills: grilling, domain-modeling, prototype, tdd, code-review.",
               "bcgov/crow: UX skill, DESIGN.md template, rule data shape.",
               "bcgov/agent-skills: Actions hardening, OpenShift workloads. bcgov/agent-guardrails on every machine.",
               "Internal requirements practice: confidence ledger, ID at ratification, oracle independence."]},
    {"title": "Not taken", "acc": "red",
     "items": ["caveman: compresses prose the gates need readable.",
               "rl-project-template: Emerald and .NET specific.",
               "raven, rook: later, for Jira and monitoring.",
               "ponytail: optional, off by default, measured on one slice first.",
               "AI-Engineering-Coach: phase 5 retrospective only."]},
    {"title": "Metrics that isolate the agent from the reviewer", "acc": "gold",
     "items": ["Review cycles per PR; verify attempts to green per slice.",
               "Elapsed time per slice, start to merge.",
               "Parity: verified on new over verified on old.",
               "Failure classes per slice; tokens per stage; ratify rulings by kind; gate decision time.",
               "Not a headline: time-to-close a PR, which measures reviewer availability."]},
], item_size=12.4)

p.steps_pair(
    left={"label": "Phases 0 to 2: the durable assets", "acc": "gold",
          "sub": "Nothing here depends on the new stack. It survives every rebuild.",
          "steps": [
              ("Harness · phase 0", "Both repos local, sdlc init, constitution, config, guardrails, persona briefs. Exit: checks green on an empty proposal."),
              ("Spec · phase 1", "intent, archaeology per domain, ratify. Exit: no accepted criterion is inferred or open."),
              ("Tests · phase 2", "derive-tests, bind-adapter old, calibrate. Exit: every calibrate row is pass or ruled."),
          ]},
    right={"label": "Phases 3 to 5: build, then rails", "acc": "navy",
           "sub": "Each slice is a full pipeline cycle and a metrics data point.",
           "steps": [
               ("Design · phase 3", "DESIGN.md and catalogue. Exit: UX reviewer approves."),
               ("Build · phase 4", "plan, then per slice build, verify, review-and-ship, deploy. Exit: every slice done; parity reported."),
               ("Rails · phase 5", "operate metrics, one feature through the full chain, one trivial change through the short circuit, harness fixes. Exit: version bumps; rebuild two starts from the same config."),
           ]})

p.cards([
    {"title": "Decided on recommendation", "acc": "gold",
     "items": ["Test sign-in: sandbox identity provider with seeded users; app code unchanged.",
               "Email: a catch-all mailbox as SMTP target for old and new, so it calibrates.",
               "tier2-v3 pack source not public: ideas and scripts ported from the installed copy.",
               "Ponytail off; measured on one slice. Push both repos to bcgov at end of phase 0, with a go-ahead then."]},
    {"title": "How the pipeline tests itself", "acc": "green",
     "items": ["Harness evals: prompt-and-check tasks asserting the agent follows a rule.",
               "Structural checks on artifact shape, every proposal, both repos.",
               "Fixture project with a planted defect, run end to end in the pipeline's own CI.",
               "The marketplace run record is the real test."]},
    {"title": "Slice order, first pass", "acc": "navy",
     "items": ["Public opportunity listing and detail.",
               "Sign-in and organisation management.",
               "Vendor proposal for Code With Us; government create and publish.",
               "Evaluation and award; Sprint With Us and Team With Us variants.",
               "Notifications; administration and content."]},
], item_size=12.6)

p.sources([
    ["Design spec — docs/specs/2026-09-05-marketplace-rebuild-pipeline-design.md",
     "Companion walkthrough — docs/poster/walkthrough.md",
     "tier2-v3 pack as installed — github.com/bcgov/bcparks-ar-admin-agentic"],
    ["github.com/github/spec-kit", "github.com/mattpocock/skills", "github.com/bcgov/crow",
     "github.com/bcgov/agent-skills", "github.com/bcgov/agent-guardrails"],
    ["github.com/bcgov/quickstart-openshift", "github.com/bcgov/design-system",
     "github.com/bcgov/digital_marketplace", "github.com/DietrichGebert/ponytail"],
])

p.footnote("Draft for review, 2026-09-05. Describes the design as specified, not as "
           "built. Nothing has been pushed to any remote.")

info = p.write(os.path.join(HERE, "pipeline-poster.svg"),
               title="Agentic SDLC pipeline, proven by rebuilding the Digital Marketplace",
               desc="A nine-section reference poster covering what is being built and why, the "
                    "criterion gold thread and six principles, the two repositories and "
                    "configuration, the artifacts, the fifteen stages, the six gates and "
                    "policy, blind tests with adapters and the old application as oracle, the "
                    "verification loop and internals, and the stack, dependencies, metrics "
                    "and phase plan.")
print(info)

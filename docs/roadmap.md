# Roadmap

The pipeline is built in phases, and each phase is proven on a real project
before the next begins. Each phase has a design in `docs/specs/` and an
implementation plan (kept locally under `docs/superpowers/plans/`); every stage
that lands gets a contract in `docs/stages/`. This page is the one place that
lists all of them.

| Phase | What it delivers | Stages | Status |
| --- | --- | --- | --- |
| 0 · Harness | The package, config schema, structural checks (config, layout, constitution, egress), project templates, deny list and edit guard, skill packs pinned by commit, local proposals and rulings, the first state site, the fixture project, docs | `new`, `init`, `checks`, `doctor`, `propose`, `rule`, `status` | done |
| 1a · Runner and persona gates | Isolated headless stage sessions, workspace materialisation with a blindness assertion, journal, stage registry, `run` and `resume`, persona agents ruling with a recorded rationale and mandatory escalation, tracked state site with journal and proposal pages | `run`, `resume`, `rule --by agent:*`, `rule --pending` | done |
| 1b · Spec side | Read-only sources, the criterion format and parser, intent interview, archaeology per domain, ratification with the product-owner's condition vocabulary, coverage board and criteria pages | `intent`, `archaeology`, `ratify` | in review |
| 1c · Tests and oracle | Blind test derivation from the spec bundle, adapters per target, the old application started on pipeline-chosen ports as the oracle, calibration with per-criterion rulings, the contract's OpenAPI recovery | `derive-tests`, `bind-adapter`, `calibrate` | next |
| 1d · Design and plan | Design spec and screen catalogue against the design system, reviewed by the UX persona; plan with a constitution check, tasks cut into vertical slices, decision records for stack choices | `design`, `plan` | planned |
| 1e · Build, verify, ship | Build per slice in a sandbox, acceptance suite against the new target, failure classification and routing with bounded retries, review contract with an evidence receipt, deploy to a local sandbox | `build`, `verify`, `review-and-ship`, `deploy` | planned |
| 2 · Rails | Operate: metrics, band detection, monitors; the short circuit for trivial changes; harness evals; replay of a whole run from the saved config | `operate`, replay | planned |

## The run

The first project is a rebuild profile: every stage runs on it as the stage
lands, and the project's own `site/` (journal, gates, coverage, criteria) is the
record of that run. Each domain goes through archaeology, a persona ruling,
ratification, then test derivation and calibration; each slice later goes
through build, verify and review. When the whole loop has run once, the
harness is improved from the run record and the run is repeated from the same
configuration.

## What "done" means for a phase

- Every stage in the phase has a contract in `docs/stages/` that matches the code.
- The fixture project runs the phase's stages end to end with the mock executor in CI.
- The real project has run each stage at least once with a live session, and the
  journal, gate files and site show it.
- A whole-branch review found nothing blocking, and its fixes are merged.

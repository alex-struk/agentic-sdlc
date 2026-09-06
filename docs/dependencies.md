# Dependency register

Every external thing the pipeline uses, or a project it produces uses, with why. Pinned versions
live in `package.json` (the pipeline's own dependencies) or in a project's `.sdlc/lock.json` (skill
packs, resolved to a commit by `sdlc init`).

| Dependency | Used for | Taken as | Pinned version or commit | Why |
| --- | --- | --- | --- | --- |
| `ajv` | Validating `.sdlc/config.yaml` against `schema/config.schema.json` | npm dependency of the pipeline package, exact-pinned | `8.20.0` | JSON Schema validation is not worth hand-writing, and it turns a mistyped configuration key into an error instead of a silent default. |
| `yaml` | Parsing configuration, lockfiles and gate records | npm dependency of the pipeline package, exact-pinned | `2.9.0` | YAML parsing is not worth hand-writing; used by `src/config/load.mjs` and `src/commands/status.mjs`. |
| `github/spec-kit` | Heading structure for the plan template (`templates/project/plan/plan.md`) | Template structure copied with an attribution comment; no runtime dependency | not applicable — copied once, not installed | The most-used templates for this shape; the process and CLI are not used because the runner owns the process. |
| `mattpocock/skills` | `grilling` (the intent interview), `domain-modeling`, `prototype`, `tdd`, `code-review` | Skill pack: cloned into `.sdlc/packs/`, skills copied into `.claude/skills/`, pinned to a commit by `sdlc init` | `3cca18b368ae95cdbdebbff572ccafa662551015` — confirmed folders: `skills/productivity/grilling`, `skills/engineering/domain-modeling`, `skills/engineering/prototype`, `skills/engineering/tdd`, `skills/engineering/code-review` | Small, composable, model-agnostic skills; `grilling` is the intent interview, `tdd` defines seams, `prototype` produces UI variants. |
| `bcgov/crow` | The `crow-bcgov-ux` skill; structure of the `design/DESIGN.md` template | Skill pack pinned to a commit; template structure copied with attribution | `e0808300c45ef750c59b3a1df194872353ee539b` — confirmed folder: `.apm/skills/crow-bcgov-ux` | BC Design System and accessibility guidance written for BC Gov services. |
| `bcgov/design-system` | React components, design tokens and the BC Sans typeface for a generated project's UI | npm dependency of the project repository the pipeline produces, not of the pipeline itself | not applicable — added when a project's `app/` is scaffolded | The design system BC Gov services are expected to use, and it ships its own agent instructions. |
| `bcgov/agent-skills` | `github-actions` hardening, `openshift-deployment` skills | Skill pack pinned to a commit by `sdlc init` | `e48c2a7f9f981980338ba46305e481c43087a15b` — confirmed folders: `skills/github-actions`, `skills/openshift-deployment` | Org-maintained; the Actions hardening rules are specific and correct. |
| `bcgov/quickstart-openshift` and `-helpers` | Scaffold and deploy workflows for the `openshift-ts` stack profile | Scaffold read at a commit and described in `stacks/openshift-ts/README.md`; the deploy path's actions are used as the profile's pinning standard, not vendored | Scaffold read at `af1e42ed78181f338942f29aa34c5174c0cfd635` (2026-09-06). Actions it pins, and that the profile therefore expects: `bcgov/action-builder-ghcr@cb2629351c87dd1c2130073e4ebb7233a9653a63` (v4.4.1), `bcgov/action-deployer-openshift@27a85b7b157bfc9c3c9bf0aca53bcd288d4d2506` (v4.2.1), `bcgov/action-get-pr@28b0adf8e4d40720d41f9c87356ce24b0a4bd6af` (v0.3.1), `bcgov/action-oc-runner@111868d1fc50db0a40417ba321d865ef5c931bbd` (v1.7.0), `bcgov/action-test-and-analyse@8f699e3fd3fadd9a6adf6f4b1f2638ef7ecfefb9` (v2.0.0), `bcgov/actions/sysdig-monitor@4ad61a784f1c17765b03d8d6de9737c1d3f4c0f2` (v0.5.0), `shrink/actions-docker-registry-tag@e6aaef25c595b6e0edd18bf4c7dbfea3abd43299` (v5), and `bcgov/quickstart-openshift-helpers` reusable workflows at `a11ad3d1b9288fb40757c4314a62eb86ff227931` (v1.2.1) | Org-maintained, current, and deploys to the platform the profile targets. Every external action in its deploy path is pinned to a commit with a version comment, which is the convention the profile adopts. |
| `DietrichGebert/ponytail` | A scope brake during the build stage | Optional skill pack, disabled by default | `974d940a1c5344210874150b98ff0d2c861fab6a` — confirmed folder: `skills/ponytail` (the pack also ships `ponytail-debt`, `ponytail-gain`, `ponytail-review`, `ponytail-audit` and `ponytail-help`, not used here) | Honest benchmarks report it may hurt with reasoning models, so it is measured before being kept enabled. |
| Playwright, Vitest, Storybook | Acceptance tests, unit tests, and a component catalogue in a generated project | npm dev dependencies of the project repository the pipeline produces | not applicable — added when a project's test suite is scaffolded | Standard tooling for this shape of application. |
| `microsoft/AI-Engineering-Coach` | Reviewing session logs to find repeated prompts worth turning into a skill | Retrospective tool, used out of band | not applicable — not part of the pipeline or any project it produces | A later-phase tool, not a pipeline or runtime dependency. |
| Internal requirements-engineering practice | The confidence ledger, ID-at-ratification rule, the criterion template, and the case for testing acceptance behaviour against an independent oracle | Rules adopted into the constitution and checks, not software | not applicable — a set of rules, not a package | The basis for treating a criterion, not a passing test, as the unit of progress. |

## Not adopted

Recorded here so the choice is not re-litigated:

- **caveman** — compresses prose the way a gate decision page needs to stay readable; not adopted.
- **rl-project-template** — specific to a different runtime and language than this pipeline targets.
- **raven** and **rook** — considered for later integration with issue tracking and monitoring; not
  needed by the current stage set.
- **spec-kit's CLI** — the templates are used (see the register above); the CLI is not, because the
  runner owns the process spec-kit's CLI would otherwise drive.
- **`bcgov/agent-guardrails`** — optional for a team to install on its own machines as an extra layer
  of shell-level enforcement; not installed or required by the pipeline itself, which enforces the
  same boundaries through the deny list and the implement-guard hook (see `docs/stages/init.md`).

## Keeping in sync

A weekly workflow that diffs each skill pack against its upstream and opens a pull request with
the result is a later task. Until it exists, check a pack's freshness by hand:

```
git ls-remote <pack repo URL> <ref>
```

Compare the commit that returns against the `commit` recorded for that pack in the project's
`.sdlc/lock.json`. A difference means the pack has moved upstream since the project was last
initialised or upgraded.

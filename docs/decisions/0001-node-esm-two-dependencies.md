# 0001 — Node ESM, node:test, and exactly two dependencies

**Status:** accepted · 2026-09-05

**Decision.** The pipeline package is Node (>=22) using ES modules and the
built-in `node:test` runner. It depends on exactly two packages, pinned to
exact versions: `yaml` to read configuration, `ajv` to validate it against the
schema. Scripts copied into a project repository depend on nothing but git and
the GitHub CLI.

**Why.** The design spec wants deterministic scripts a team can read and run
anywhere GitHub Actions runs. Node is already on every runner and on the
platform's quickstart. A test framework, a CLI framework and a logging library
would each add a dependency surface with no benefit at this size. YAML parsing
and JSON Schema validation are the two things not worth hand-writing.

**Consequences.** Argument parsing is a 15-line function. Tests use
`node:test` and temporary directories. Upgrading a dependency is a deliberate
commit, and the dependency register lists both.

# Configuration Reference

Configuration is a YAML file describing a project pipeline, stack, policy gates, and skill packs. Unknown keys at any level are errors. Gate holders are roles (like `tech-lead`, `ux-reviewer`) or `agent:<persona>` (like `agent:product-owner`); people are bound to roles only where a remote needs it (code owners for pull-request approval), never in tracked config.

## pipeline

Required. Container of repository information for the pipeline itself.

- `repo` (string): The repository name or identifier for the pipeline.
- `ref` (string): A git ref (tag, branch, or commit) pinning the pipeline version.

## profile

Required. Enum: `greenfield`, `rebuild`, `remediation`, `feature`. The mode of engagement for the project.

## stack

Required. String matching `^[a-z0-9-]+$`. A lowercase identifier for the deployment stack (e.g., `openshift-ts`).

## project

Required. Container describing the project itself.

- `name` (string, pattern `^[a-z0-9-]+$`): The project name, lowercase with hyphens.
- `domains` (array, min 1 item): A list of business domains the project spans. Each domain is a string matching `^[a-z0-9-]+$`.

## sources

Optional. Container of source data definitions. Typically contains `old`, describing a legacy system.

- `old` (object): A source to be analyzed or migrated from.
  - `repo` (string): The repository URL.
  - `commit` (string, pattern `^[0-9a-f]{7,40}$`): A git commit hash (7–40 hex characters).
  - `docs` (array, optional): List of documentation file paths.
  - `exclude` (array, optional): List of paths to exclude from analysis.

## oracle

Optional. Container describing the reference system (usually the legacy system to which the new system is compared).

- `target` (string): The key in `sources` to use as the oracle (e.g., `old`).
- `compose` (string): Path to a Docker Compose file for spinning up the oracle.
- `seed` (string): Path to database seed files or scripts.
- `base_url` (string, format URI): A URL starting with `http://` or `https://`.
- `identity` (enum): One of `session-route` or `sandbox-idp`.

## targets

Optional. Container of deployment targets.

- Each key is a target name (e.g., `new`). Each value is an object:
  - `base_url` (string, format URI): A URL starting with `http://` or `https://`.
  - `identity` (enum): One of `session-route` or `sandbox-idp`.

## policy

Required. Container of governance gates, tiers, and budgets.

- `gates` (object): A map of required gate definitions. Must include: `G0`, `G1`, `G-DESIGN`, `G2`, `G3`, `G-POL`. Each gate is an object:
  - `holder` (string, pattern `^(agent:)?[a-z][a-z0-9-]*$`): A role name or `agent:<persona>`. Role names are lowercase words joined by hyphens. Rejects person-like identifiers (e.g., `jane.doe` fails because of the dot).
  - `escalate_to` (string, optional, pattern `^[a-z][a-z0-9-]*$`): A role to escalate to if the holder cannot decide. Lowercase, no agent: prefix.
  - `human_sample_per_week` (integer, optional, min 0): If set, the human reviewing this gate samples 1 in N decisions.
- `default_tier` (enum): One of `LOW`, `STANDARD`, `HIGH`, `CRITICAL`. The default risk tier for decisions.
- `rungs` (object, optional): A map of risk tier escalation rules. Keys are tier names, values are strings.
- `triage` (object, optional): Thresholds for automatic triage.
  - `direct_max_files` (integer, optional, min 1): Maximum files changed to bypass triage.
  - `direct_allowed_paths` (array, optional): Paths that can bypass triage.
- `budgets` (object, optional): Token budgets by category. Keys are category names, values are integers (min 1). The runner has no token-to-turn conversion yet, so it reads a value under 1000 as a turn ceiling for the stage of that name (clamped to 200) and ignores anything larger, warning once per stage that the run used the default of 40 turns instead.

## skills

Required. Container of skill packs to be installed and enabled.

- `packs` (array): A list of skill pack definitions. Each pack is an object:
  - `repo` (string): The repository or package name.
  - `ref` (string): A git ref pinning the pack version.
  - `skills` (array): A list of skill names to enable from this pack.
  - `enabled` (boolean, optional): Whether this pack is enabled. Default is true if omitted.
- `extra` (array, optional): A list of extra skill names to enable.

## egress

Required. Container of outbound traffic rules.

- `rules` (array): A list of egress rule identifiers. Each must be one of: `E-1`, `E-2`, `E-3`, `E-4`.

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
- `seed` (string, optional): The directory `oracle up` loads `*.sql` files from, in ascending name order. Defaults to `tests/seed`, which is where the `contract` stage writes them; set it only for a project that keeps them elsewhere.
- `base_url` (string, format URI): A URL starting with `http://` or `https://`.
- `identity` (enum): One of `session-route` or `sandbox-idp`.
- `compose_override` (string, optional): Path to the compose override the `contract` stage writes (mailpit, published ports, the app's non-production sign-in routes). Defaults to `.sdlc/oracle/compose.yml`, applied in code rather than in the schema.
- `service` (string, optional): The base compose service that runs the application itself. Defaults to `app`.
- `up` (array of strings, optional): Services to bring up, and build, before the migration runs and before the application itself is started. Left unset or empty, the list is derived at run time from `docker compose config --services` — every service the compose file and the override define, minus `service` and minus `migrate_service` — and those names are passed to `up` explicitly. Naming them is what keeps the application from starting before its database and its migration have run, which is what a bare `up` with no service names would do.
- `migrate_service` (string, optional): A one-off compose service that applies database migrations, run once before the seed is loaded.
- `db` (object, optional): Where to load the seed files into. All three keys are required inside `db` when it is present:
  - `service` (string): The compose service running the database.
  - `user` (string): The database user to connect as.
  - `database` (string): The database name.
  - `keep` (array of strings, optional): Tables `oracle reseed` leaves alone, replacing the default `knex_migrations`, `knex_migrations_lock`, `schema_migrations`, `migrations`. These are a migration tool's own bookkeeping: emptying them would tell the application its schema had never been built. Each name must be a plain SQL identifier, since it is written into the statement that empties everything else.
- `instances` (integer, optional, 1-16): How many independent copies of the oracle to run, each a compose project of its own with its own application, database and mail catcher. The acceptance suite spreads across them, one worker per copy, so that many tests run at once without sharing data. Defaults to 1, which behaves exactly as a single oracle always did. A copy costs whatever the application and its database cost in memory, so raise it to what the machine can hold.
- `env` (object of strings, optional): Extra environment variables passed to `docker compose` when the oracle comes up.

The mailpit API port the oracle publishes is not a config key: it always reaches the running application as the environment variable `SDLC_MAIL_API_PORT`, chosen by the runner the same way the app and database ports are.

`sdlc oracle up` records the ports and URLs it actually chose in `.sdlc/oracle-<target>.local.yaml` — untracked (`.gitignore` carries `.sdlc/oracle-*.local.yaml`), since it is a fact about this machine's current run, not project configuration. `bind-adapter` and `calibrate` read it to find the running oracle; see `docs/stages/oracle.md`.

## targets

Optional. Container of deployment targets.

- Each key is a target name (e.g., `new`). Each value is an object:
  - `base_url` (string, format URI): A URL starting with `http://` or `https://`. The address the application itself publishes on, and the one `sandbox up` waits for before it reports the target up.
  - `identity` (enum): One of `session-route` or `sandbox-idp`.
  - `compose` (string, optional): The target's own Docker Compose file, relative to the project root. Defaults to `app/compose/compose.yaml`, which is where the stack profile has the build declare the application's local services.
  - `seed_service` (string, optional, pattern `^[a-z0-9][a-z0-9_-]*$`): The one-shot compose service that puts the data back to what `tests/seed/manifest.yaml` describes. Defaults to `seed`.
  - `depends_on` (object of strings, optional): Addresses the target is not usable without, as a map of a name to a URL — conventionally `identity` for the sandbox's own identity provider. Names are lowercase words joined by hyphens; values are URLs of the same shape as `base_url`. At least one entry is required when the key is present, so a target with nothing to declare omits it rather than writing `depends_on: {}`.

    `sandbox up` waits for each address after it has waited for `base_url`, and refuses the target by name when one of them never answers: a web tier that serves is not a usable sandbox when the provider every test signs in through cannot be reached. Declare an address a service answers on once it is genuinely ready — for a Keycloak, its realm's own endpoint rather than the server root, since the server answers before the realm is imported and would answer whether the import succeeded or not.

    Each address is polled for up to two minutes, so a target declaring N of them can wait (N+1) × two minutes in the worst case, where nothing answers anywhere. A target that omits the key is waited for exactly as it always was.

    A declared address on a port the target's compose file does not publish is reported as configuration rather than as the application: it halts the run and records nothing against the build, because that string is in `.sdlc/config.yaml` and no build writes or reads that file. Only the port is compared, so a wrong host or path on a port the project does publish is not told apart from a service that is failing to serve.

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
- `budgets` (object, optional): Token budgets by category. Keys are category names, values are integers (min 1). The runner has no token-to-turn conversion yet, so it reads a value under 1000 as a turn ceiling for the stage of that name and honours it as written, up to 999. A value of 1000 or more would be a token budget the runner cannot act on, and `checks` refuses it rather than letting a run quietly fall back to the default of 40 turns: a budget a gate approved and a run ignored is worse than no budget at all. A stage that genuinely needs more than 999 turns needs splitting, not a larger number. The key `rule` caps a persona's ruling turn the same way: without it a ruling runs with 12 turns, except at G1, where the persona has to rule on every criterion in a domain and gets the stage default of 40.

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

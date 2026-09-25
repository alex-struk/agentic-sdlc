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

Required. Container of governance gates, tiers, limits and turn ceilings.

- `gates` (object): A map of required gate definitions. Must include: `G0`, `G1`, `G-DESIGN`, `G2`, `G3`, `G-POL`. Each gate is an object:
  - `holder` (string, pattern `^(agent:)?[a-z][a-z0-9-]*$`): A role name or `agent:<persona>`. Role names are lowercase words joined by hyphens. Rejects person-like identifiers (e.g., `jane.doe` fails because of the dot).
  - `escalate_to` (string, optional, pattern `^[a-z][a-z0-9-]*$`): A role to escalate to if the holder cannot decide. Lowercase, no agent: prefix.
  - `human_sample_per_week` (integer, optional, min 0, default 0): How many of this gate's agent-held rulings in each ISO week are marked as a sample for a person to read back: the first N, in the order they were ruled. The engine marks them after the ruling, on the state site; the persona ruling the gate is not told and does nothing differently.
  - `approve_unasserted` (boolean, optional, G3 only, default `true`): Whether a build whose verify verdict is `pass-unasserted` — nothing failed, and some claimed criterion was never asserted against the application — may be approved. `false` refuses that approval from either seat, a persona or a person typing `--by`, and leaves return and escalate open.
  - `block_on_missing_tests` (boolean, optional, G3 only, default `true`): Whether an approval of a build slice is refused while a criterion the slice claims is owed a test (an open `missing-test` item, `docs/operating-model.md` §7). `true` refuses it from either seat, whatever escalation stands, unless the ruling withdraws each such item with `condition-withdrawn missing-test/<id>: <why>`; the refusal is recorded like any other. `false` lets G3 approve past open items, which stay open until a test for each runs or a ruler withdraws it.
- `default_tier` (enum): One of `LOW`, `STANDARD`, `HIGH`, `CRITICAL`. The risk tier assumed for a proposal or a criterion that names none. Risk tiers are inactive for proposals; see "Risk tiers" below.
- `escalate_tiers` (array of tiers, optional, default `[HIGH, CRITICAL]`): The proposal tiers at which an agent-held gate escalates to its `escalate_to` before the persona is asked anything. Must include `CRITICAL`, and names each tier at most once.
- `provenance` (object, optional):
  - `block_unverified` (array of tiers, default `[HIGH, CRITICAL]`): The criterion tiers at which an acceptance test of unverified provenance (edited outside the blind workspace) fails the tests check outright. At every other tier it passes only with an entry in `tests/acceptance/attestations.yaml`. Must include `CRITICAL`, and names each tier at most once.
- `calibrate` (object, optional):
  - `environment_faults` (integer, min 0, default 0): How many rows of one calibration may fail because the target could not be reset to its seed or could not be reached before `calibrate` halts as an environment fault instead of recording its rows (`docs/stages/calibrate.md`, step 4). Such a row says nothing about the application. At or under this number the run goes on and those rows are recorded as failures like any other.
- `loops` (object, optional): How many times a loop between stages goes round before a person is asked. Each key is optional and has the default shown.
  - `verify_returns` (integer, min 1, default 3): How many times `verify` returns one slice's build to `build` before the return that reaches this number escalates to G3's `escalate_to` instead. Counted per slice, across every cause verify returns a build for: failing criteria and a sandbox that did not start for a reason in the build. A reviewer's own return does not count. `verify` refuses to run at all where G3 names no `escalate_to`.
  - `ratify_follow_ups` (object): The closing loop `ratify` runs over provisional criteria still `inferred` or `open` (`docs/stages/ratify.md`, "The closing loop").
    - `max` (integer, min 1, default 2): How many approved follow-up rulings a domain gets before the bound applies.
    - `on_limit` (enum `escalate` | `obsolete`, default `escalate`): What happens at the bound. `escalate` opens the next follow-up and escalates it to G1's `escalate_to`, recorded as any escalation is, so nothing leaves the contract without somebody deciding it; `ratify` refuses to run once the bound is reached if G1 names no `escalate_to`. `obsolete` marks every provisional criterion still unresolved `obsolete`, noted `unresolved after <n> rulings`.
  - `rebind`, `redo`, `recovery`, `request` (integer, min 1, default 2 each): How many times one item of owed work of that kind (`docs/operating-model.md` §6) may be sent to the stage that owes it: a binding to `bind-adapter`, a criterion's test to `derive-tests`, a criterion to `archaeology` for recovery, and a stage to its own `--revise` by one line of work's `addressed-to` conditions, where the requests one ruling files together are one send. Every send is counted, answered or not. A run handed an item sent more times than this still does the work, and the proposal it opens is escalated by the runner to that stage's gate's `escalate_to` instead of being put to its holder; a gate that names no `escalate_to` refuses the run (`docs/stages/run.md`).
- `retries` (object, optional): How many times the runner retries a stage's own work.
  - `post_check_repair` (integer, min 0, default 1): How many repair turns a stage whose output failed its post-checks is given before the run fails. Each repair turn is told exactly what the previous attempt's post-checks said, and is capped at 40 turns or the stage's own turn ceiling, whichever is lower. `0` gives none. Stages with no agent (`ratify`, `calibrate`, `verify`) get none whatever this says.
- `next` (object, optional): How `sdlc next` chooses between ready work of different kinds (`docs/stages/next.md`).
  - `order` (array, default `[proposals, owed, sequence]`): The three kinds of ready work, each named exactly once, in the order they are taken when more than one kind is ready. `proposals` is an open proposal a seat played by an agent can rule, or a build proposal to verify before it is ruled; `owed` is a returned proposal to revise, open owed work and stale tests; `sequence` is the next step of the phases. Within a kind the record decides the order. A person's seat, an escalation to a person and a dead end are never ready work, whatever this says.
- `checks` (object, optional): Strictness of checks a project could want different.
  - `hand_edits` (enum `warn` | `fail`, default `warn`): What the `hand-edits` check does with a commit not authored as the pipeline that changes an owed-work list, a gate file under `.sdlc/gates/` or `.sdlc/lock.json` (`docs/stages/checks.md`). `warn` reports it and passes; `fail` fails `checks`. Warn while the pipeline itself is being developed and hand fixes are expected; fail in live operation, where the record is changed only by runs and rulings.
- `rungs` (object, optional, reserved): Autonomy rungs, a map of tier names to strings. Nothing in the pipeline reads it, and `checks` warns when it is set.
- `triage` (object, optional, reserved): Thresholds for letting a small change bypass the full stage sequence. Nothing in the pipeline reads it, and `checks` warns when it is set.
  - `direct_max_files` (integer, optional, min 1): Maximum files changed to bypass triage.
  - `direct_allowed_paths` (array, optional): Paths that can bypass triage.
- `turns` (object, optional): The most agent turns a session may take, by stage. Keys are stage names, values are integers from 1 to 999. A stage with no entry runs with its own default: 40 for most stages, 250 for `design`, 150 for `plan`, 400 for `build`. The key `rule` caps a persona's ruling turn the same way: without it a ruling runs with 12 turns, except at G1 and on a calibration triage proposal, where the persona rules on every criterion in a page and gets the stage default of 40. A stage that genuinely needs more than 999 turns needs splitting, not a larger number.
- `agents` (object, optional): Which agent backend and model run the project's agent turns (`docs/decisions/0060-a-second-agent-backend.md`). Absent, every turn runs on `claude` with the CLI's own default model. Being under `policy`, a change to it is ruled at G-POL (`docs/decisions/0043`).
  - `backend` (enum `claude` | `codex`, optional): The default backend for every stage and ruling.
  - `model` (string, optional): The default model, passed to the CLI as `--model`. Absent, the CLI chooses, and records say so.
  - `stages` (object, optional): Per-stage choices, keyed by a stage with an agent turn. Each value may set `backend` and `model`, and `accept_weaker` (boolean): whether the stage may run on `codex` although it declares a tool allowlist Codex cannot enforce (see "Switching to Codex" below). A stage's repair turns run on the same choice as its first turn.
  - `rulings` (object, optional): Per-ruling choices, keyed by a gate (`G3`) or by a persona that holds one as an agent (`reviewer`). Each value may set `backend` and `model`. A gate's entry wins over a persona's.

  A model belongs to the backend it is written beside: an entry that changes the backend and names no model does not inherit the model above it. `checks` refuses an entry for a stage with no agent turn, or for a ruling nobody makes.

  The environment overrides all of it for one run: `SDLC_AGENT_BACKEND` (`claude` or `codex`) and `SDLC_AGENT_MODEL`. A backend override drops any configured model unless `SDLC_AGENT_MODEL` names one. Neither lifts a refusal.
- `budgets` (object, optional, deprecated): The same setting as `turns`, under the name projects written before `turns` carry. A stage `turns` names ignores it. A value under 1000 is read as a turn count; a value of 1000 or more would be a token budget the runner has no conversion for, and `checks` refuses it rather than letting a run quietly fall back to its default. `checks` warns wherever this key is set; move its entries to `turns` in the project's next policy change.

### Switching to Codex

Every agent turn runs on the Claude Code CLI unless `policy.agents` says otherwise. To run a project's work on the OpenAI Codex CLI:

1. Install the CLI (`npm install -g @openai/codex`) and sign in with `codex login`, choosing ChatGPT. The pipeline signs in with that subscription only, never an API key, and keeps its own copy of the sign-in in `$XDG_CONFIG_HOME/agentic-sdlc/codex-home` (`SDLC_CODEX_HOME`), linked to `~/.codex/auth.json`.
2. Propose the policy change, and have it ruled at G-POL:

   ```yaml
   policy:
     agents:
       backend: codex
       model: <a model your plan offers>   # optional; recorded on every turn when set
   ```

   Every ruling and every stage with no tool allowlist (`intent`, `archaeology`) then runs on Codex.
3. The stages that declare a tool allowlist — `contract`, `bind-adapter`, `derive-tests`, `design`, `plan`, `build` — are refused on Codex until the project accepts, stage by stage, that Codex cannot hold them to it: it has no tool allowlist, its sandbox limits what a session writes rather than what it reads or runs, and it does not read the deny list in `.claude/settings.json`. `docs/decisions/0060-a-second-agent-backend.md` says what each stage loses. To run one there anyway:

   ```yaml
   policy:
     agents:
       backend: codex
       stages:
         build: { accept_weaker: true }
         design: { backend: claude }      # or keep a stage on claude
       rulings:
         G3: { backend: claude, model: <model> }
   ```

4. Run `sdlc doctor`. It names which backend runs which stages and gates, whether each CLI is installed and signed in, and each stage Codex will refuse.

To try one run on Codex without changing the policy, set `SDLC_AGENT_BACKEND=codex` (and optionally `SDLC_AGENT_MODEL`) for that command. What ran each turn is on its run-record line, its journal entry, the proposal it opened, an agent ruling's gate file, and the state site (`docs/operating-model.md`, "Agent backends").

A Codex session has no turn cap; the runner stops it at thirty seconds per turn `policy.turns` allows the stage, never less than two minutes. It reports tokens rather than cost, so its turns are recorded at a cost of 0.

### Risk tiers

Risk tiers are inactive. A criterion may carry a `tier`, and a proposal opened by `sdlc propose --tier` carries one, but no stage passes a criterion's tier to the proposals it opens, so every stage-opened proposal is ruled at `default_tier`. `escalate_tiers` therefore fires only on a proposal a person opened with `--tier`. The one place a tier acts is `provenance.block_unverified`, which reads the criterion's own tier, or `default_tier` where it names none. The tier keys stay in the schema so a project's configuration is valid either way, and are removed if they remain unused.

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

- `rules` (array): A list of egress rule identifiers. Each must be one of: `E-1`, `E-2`, `E-3`, `E-4`. The egress check (`docs/stages/checks.md`) enforces `E-2`, that nothing private leaves in a committed file, and applies it only when this list includes `E-2`; a list without it scans nothing and `checks` warns that it does not. `E-1`, `E-3` and `E-4` are accepted and have no check in the pipeline. Redaction of local paths in what the pipeline writes applies whatever this list says.

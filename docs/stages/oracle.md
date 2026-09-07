# `sdlc oracle`

## Purpose

Start, stop and report on the old application — the acceptance suite's calibration target —
running through Docker Compose on ports the pipeline chooses for this machine, rather than ports
a project's own compose file happens to hardcode. `bind-adapter` and `calibrate` both read where
it ended up (see "Outputs") instead of assuming a fixed URL.

Unlike a pipeline stage (`sdlc run <stage>`), `sdlc oracle` is not part of a proposal/gate
sequence: it manages a running process on this machine, and nothing about it needs a human
ruling. It does, still, leave a line in the run record the same way a stage does.

## Inputs

`sdlc oracle up|down|status [--target <t>]`, run from inside the project's working tree.
`--target` defaults to `config.oracle.target` and is refused when given any other value — a
project configures exactly one oracle target, so naming a different one is always a mistake
rather than a choice between several.

Reads `.sdlc/config.yaml`'s `oracle` block (`docs/config.md`): `target`, `compose`,
`compose_override` (default `.sdlc/oracle/compose.yml`, written by the `contract` stage),
`base_url`, `service` (default `app`), `up` (which services to bring up before migrating and
seeding), `migrate_service`, `db` (`service`/`user`/`database`, when this oracle has a database
to seed), and `env` (extra environment variables passed to every compose call). `up` also reads
every `tests/seed/*.sql` file, in ascending name order.

## Outputs

- `.sdlc/oracle-<target>.local.yaml` — untracked (`.gitignore` carries `.sdlc/oracle-*.local.yaml`),
  since the ports it names are a fact about this machine's current run, not something to commit:
  ```yaml
  target: old
  base_url: http://localhost:3107
  ports: { app: 3107, db: 5501, mail_api: 8025 }
  mail_api: http://localhost:8025
  compose_project: sdlc-<project-name>-<target>
  ```
  `down` removes this file. Later stages read it to find the running oracle: `bind-adapter`'s
  target-`old` run fails its own pre-check, naming this file, when it is not there.
- A run-record line (`oracle up <target>: <base_url>` or `oracle down <target>`), committed with
  the pipeline's own git identity when the working tree was already clean before the command ran
  (the same convention every stage follows) — printed but left uncommitted otherwise, so an
  `oracle up` run in the middle of other uncommitted work never sweeps that work into a commit it
  did not ask for.
- To stdout: `up` and `down` print the base URL and the mail API URL (or `oracle down: <target>`);
  `status` prints the local file's contents, or `<target> is not up`, followed by `docker compose
  ps` for whatever is actually running.

## Checks that block

- `up` refuses, before touching anything, when: `config.oracle` is not configured; `--target`
  names something other than `config.oracle.target`; `config.oracle.compose` does not exist on
  disk; or `docker compose version` fails (Docker Compose is not installed, or not on `PATH`).
- Ports are chosen to avoid colliding with anything already listening on this machine: the
  application keeps the port `oracle.base_url` names when that port is free, otherwise the first
  free port from 3100 up; the database scans from 5500; the mail API (a `mailpit` service the
  `contract` stage's compose override defines) scans from 8025. The three are checked for
  distinctness before anything is started.
- The database, when `oracle.db` is configured, has to answer `pg_isready` within 60 seconds
  before migration and seeding run; the application has to answer any HTTP status at
  `<base_url>/` within 180 seconds before `up` reports success. Either timeout fails the command.
- Every `tests/seed/*.sql` file is loaded with `psql -v ON_ERROR_STOP=1`, so a broken seed file
  fails the load (and so the whole `up`) instead of applying partway and reporting success.

## Exit criterion

`up` exits 0 and prints the base URL and mail API URL once the application answers at
`<base_url>/`. `down` exits 0 once `compose down -v` has run and the local file is removed.
`status` always exits 0. Any refusal or timeout above exits 1 with a message naming what failed.

## Re-run behaviour

`up` is idempotent: if `.sdlc/oracle-<target>.local.yaml` already names a compose project that
`docker compose ps --format json` reports containers for, the command does nothing further and
just prints the URLs already on file — it never rebuilds, re-migrates or re-seeds a running
oracle. Deleting the local file (or running `down` first) forces a fresh `up` to choose new ports
and start again from nothing.

## Failure modes

- `config.oracle` missing, `--target` naming the wrong value, the compose file missing, or Docker
  Compose unavailable: refused before any port is chosen or any container is touched (see "Checks
  that block").
- The database or the application never becomes ready within its timeout: `up` exits 1 with
  whatever `docker compose` last reported; the containers `up -d --build` already started are
  left running rather than torn down, so `sdlc oracle down` (or `status`, to see what is up) is
  the next step, not a silent partial state.
- A seed file fails to load (a SQL error, a constraint violation): `up` exits 1 at that point, the
  database and any services already started are left running, and the failing file's own error is
  in the message — no later seed file is attempted.

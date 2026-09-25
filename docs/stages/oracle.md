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
to seed), `seed` (default `tests/seed`) and `env` (extra environment variables passed to every
compose call). `up` also reads every `*.sql` file in the seed directory, in ascending name order.

Left unset or empty, `up` is derived rather than defaulted to "no service names": `docker compose
config --services` lists what the compose file and the override define, `service` and
`migrate_service` are removed, and the rest are named explicitly on `up -d --build`. A bare `up`
with no names would start the application too, before its database and its migration have run.

`config.oracle.compose` under `sources/` names a file in the old application's clone, which the
pipeline materialises from `config.sources.old` rather than the project committing — so `up`
checks that clone out first (`ensureSources`, `src/runner/sources.mjs`) before looking for the
file.

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
- A run-record line (`oracle up <target>: <configured base_url> (local port <n>)` or `oracle down
  <target>`) — the target's configured URL, since the port is whatever was free on this machine
  and means nothing on anybody else's, and the run record is committed history. Committed with
  the pipeline's own git identity when the working tree was already clean before the command ran
  (the same convention every stage follows) — printed but left uncommitted otherwise, so an
  `oracle up` run in the middle of other uncommitted work never sweeps that work into a commit it
  did not ask for. Run as part of a stage — by a stage's agent session, which carries
  `SDLC_STAGE`, or in-process through `oracleUp` — the line is neither written into the record
  nor committed: it waits in `.sdlc/runs.local.txt` (ignored) and is written ahead of the next
  line the pipeline records, which is the stage's own outcome, so it reaches `main` in the stage's
  commit or proposal (`docs/decisions/0047-a-stage-is-not-charged-with-the-pipeline-s-own-record.md`).
- To stdout: `up` and `down` print the base URL and the mail API URL (or `oracle down: <target>`);
  `status` prints the local file's contents, or `<target> is not up`, followed by `docker compose
  ps` for whatever is actually running.

## Checks that block

- `up` refuses, before touching anything, when: `config.oracle` is not configured; `--target`
  names something other than `config.oracle.target`; `config.oracle.compose` does not exist on
  disk; the compose override does not exist on disk (`run sdlc run contract first: <path> is
  missing` — the override is `contract`'s own output, and without it every compose call below
  would name a file that is not there); or `docker compose version` fails (Docker Compose is not
  installed, or not on `PATH`).
- Ports are chosen to avoid colliding with anything already listening on this machine: the
  application keeps the port `oracle.base_url` names when that port is free, otherwise the first
  free port from 3100 up; the database scans from 5500; the mail API (a `mailpit` service the
  `contract` stage's compose override defines) scans from 8025. The three are checked for
  distinctness before anything is started.
- The database, when `oracle.db` is configured, has to answer `pg_isready` within 60 seconds
  before the migration service (when `migrate_service` is configured) runs — `migrate_service`
  runs independently of `db` otherwise, since a migration service can manage its own database
  connection. Seeding only runs when `oracle.db` is configured, since `psql` needs its
  `service`/`user`/`database` to connect; seed files present without `oracle.db` produce a
  warning, not a failure. The application has to answer any HTTP status at `<base_url>/` within
  180 seconds before `up` reports success. Either timeout fails the command.
- Every seed `*.sql` file is loaded with `psql -v ON_ERROR_STOP=1`, so a broken seed file fails
  the load (and so the whole `up`) instead of applying partway and reporting success.
- `up` and `run` inherit the terminal's own stdout and stderr, so a container build scrolls past
  as it happens rather than arriving all at once at the end. Every other compose call is captured,
  with a 256 MiB buffer: the default 1 MiB is smaller than a real build's output and aborts the
  call with `ENOBUFS` long before the build finishes.

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

## `sdlc oracle reseed [--target <t>] [--instance <n>]`

Puts the database back to what `tests/seed/*.sql` describes, without restarting anything: every
table but the migration tool's own bookkeeping is emptied, then the same seed files `oracle up`
loaded are applied again. The table list is worked out in the database rather than written down,
so a schema that gains a table is covered; the four names left alone are the ones the common
migration tools use.

The acceptance suite runs it before every test, through `SDLC_RESET_COMMAND`, which `calibrate`
sets for the oracle. A test that deactivates an account or grants somebody administrator rights
otherwise leaves that account changed for every test after it, and those tests fail for reasons
that have nothing to do with what they are checking — one calibration lost seven criteria that
way. A target with no configured database has nothing to reset and is given no command, so a
suite run by hand against a developer's own sandbox behaves as it always did.

A reset that fails stops the test rather than letting it run against whatever was left behind.

A reset is one `psql` session per copy, fed one script: `SET lock_timeout = '10s'`, the truncate,
then every seed file in name order. One session rather than one per file, because each `compose
exec` costs about a second before any SQL runs and a reset happens before every test.

Before the truncate, every other client session on the copy's database is ended
(`pg_terminate_backend`), and the application's connection pool opens fresh ones on its next
request. The application keeps connections of its own, and one can be inside a transaction when a
reset arrives. A truncate queued behind it makes every later query on those tables queue behind the
truncate, and when the open transaction is waiting on one of those queries from another of the
application's connections, the three wait on each other with no end the database can see
(`docs/decisions/0055-a-reset-that-waited-on-the-application-it-was-resetting.md`). A session the
database role may not end is left alone. If a session reconnects in the moment before the truncate
and holds a lock past the timeout, its sessions are ended again and the truncate retried, three
times in all.

The lock timeout is set inside the session, so it holds whatever becomes of the caller: a reset
whose caller gave up on it ends in the database within the timeout instead of keeping its
connection for ever. A statement that fails is reported against the seed file and line it came
from (`<file>, line <n>`), and the command exits 1.

## Running several copies

`oracle.instances` starts that many independent copies, each a compose project of its own with
its own application, database and mail catcher, on ports chosen one copy at a time so no two
collide. `oracle up` records them all; `oracle down` takes them all down; `oracle reseed
--instance <n>` resets one, which is what each test worker calls for its own copy.

The acceptance suite spreads across them, one worker per copy: tests inside a file stay in order
in one worker, and different files run at once. Without the key there is one copy and one worker,
which is what a single oracle always did.

This is the difference between a calibration that takes an hour and one that takes twenty minutes.
The suite runs one test at a time against one copy because every test shares that copy's data; the
only way to run more at once is to give each worker data of its own.

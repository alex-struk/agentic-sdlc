# 0055 · A reset that waited on the application it was resetting

Status: accepted · 2026-09-25

## Context

`sdlc oracle reseed` puts a copy of the oracle's database back to its seed before every acceptance
test: one `compose exec psql` that truncates every table, then one more per seed file. The
harness's fixture runs it with a two-minute timeout and fails the test when it does not finish.

A calibration against four copies came back with 231 failing rows out of 265, and 225 of them had
failed in the reset rather than in the test: 377 tests reported the reset timing out and 119 more
reported the database refusing a connection, `too many clients already`. Nothing about the
application had been asked.

Measured on the copies afterwards, each database held about 95 sessions waiting on the truncate's
table lock, against the default `max_connections` of 100, plus the application's own four to
seven. The first truncate on each copy was waiting on one of the application's connections, which
had been idle inside a transaction for three and a half hours. That transaction was the
application's own periodic work, run in front of every request; it had issued a query on a second
connection from its pool and was waiting for the answer, and the second connection's query was
queued behind the truncate. Three waits in a loop, one link of which is inside the application, so
the database's deadlock detector cannot see it. Ending the queued truncates by hand let the
application's transaction finish by itself within a second, which confirms the loop.

Everything after the first truncate followed from it. The harness's timeout killed the shell it
had started, not the `node` process under it, nor the `docker compose exec` under that, nor the
`psql` inside the container; each abandoned reset kept its session, waiting on the same lock. One
more per test, until the database refused connections at all.

The seed that exposed it was a larger one than earlier calibrations used, carrying records in the
state the application's periodic work acts on, so every reset handed that work something to do in
a transaction just as the next test's requests arrived.

A single healthy reset took about 15 seconds, almost all of it the per-call cost of fifteen
`compose exec` calls. The same script piped to one `psql` session takes about 2.

## Decision

**A reset ends the database's other sessions before it truncates.** Every client session on the
copy's database other than the reset's own is ended with `pg_terminate_backend`. Nothing is
expected to be running between two tests, and anything that is — a background job, a request
still finishing — is about to have its data removed underneath it anyway. An application's
connection pool discards a connection that was ended and opens a new one on the next request.
A session the database role is not allowed to end is skipped, since it is not the application's.

**Every lock wait in a reset is bounded inside the database.** The script opens with `SET
lock_timeout = '10s'`. A session that reconnected between the ending and the truncate and holds a
lock past that is ended again, and the truncate retried, three times in all; after that the reset
fails with the database's own error. The bound is in the session rather than on the caller
because the caller is the thing that cannot be relied on: whatever kills it, the statement it
started ends by itself within the timeout and gives its connection back.

**A reset is one session.** The truncate and every seed file go to one `psql` as one script, so
there is one thing to bound and one connection to hold, and a reset costs one `compose exec`
rather than one per file. An error `psql` reports by script line is mapped back to the seed file
and line it came from.

## What was considered instead

**A longer timeout in the harness.** The wait had no end, so no timeout was long enough; a longer
one only fills the database more slowly.

**Killing the process group from the harness.** It would stop the host-side processes from
piling up, and would still leave the `psql` inside the container, which is not in any host
process group, holding its session. The bound has to be where the session is.

**A statement timeout on the truncate alone.** It breaks this loop, and leaves the reset failing
every time the application happens to be mid-transaction, which is the ordinary case for an
application with background work. Ending the sessions removes the cause; the timeout is only
what bounds a cause nobody foresaw.

**Raising `max_connections` in the oracle's compose override.** It postpones the refusal and
changes nothing about why the sessions accumulated.

## What would reverse it

An oracle whose application cannot survive its database connections being ended — one that exits
rather than reconnecting — would need the reset to wait for quiet instead, and would pay the
lock timeout on every test that raced background work.

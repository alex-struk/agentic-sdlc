# 0035 · A credential refreshed where the next run deletes it

Status: accepted · 2026-09-21

## Context

A stage session has no sign-in of its own. It authenticates with the operator's own CLI
login: `ensureConfigHome` points `CLAUDE_CONFIG_DIR` at a directory the pipeline owns and
puts the operator's credential in it as `.credentials.json`, a symlink to the credentials
source, so a session loads none of the operator's plugins, servers or instructions and
still signs in exactly as they do (`0004`).

**A session that refreshes its own token persists the refresh by rename, and a rename
replaces the name.** An OAuth access token is refreshed when it approaches expiry, and the
result is written the way any careful program writes a file it cannot afford to corrupt: a
new file, then a rename over the old path. The old path is the symlink. So the refreshed
credential lands as a regular file in the pipeline's config home, and the file the symlink
pointed at — the operator's own — is not touched at all. The evidence is visible from
metadata alone: the config home holds a regular file where a symlink was made, its
modification time is later than anything else in the directory, and the credentials source
has not been modified since the operator last signed in interactively.

**The next run then deleted it.** `ensureConfigHome` ran on every spawn and relinked
unconditionally — whatever sat at that path went, and the directory was pointed back at the
source. That threw away the only copy of the refreshed credential and handed the next
session the credential the previous one had already found too old, from a starting point
that only got older. Every run refreshed, every run had its refresh deleted, and eventually
a run got a refusal instead of a refresh and failed with an expired session. An interactive
session, holding a credential of its own in its own config home, went on working throughout
— which is what makes the failure read as a fault in the stage rather than in the directory
the stage reads from.

**What is established and what is not.** That the refresh is written into the config home
and discarded there is established from file metadata and from the code that discards it.
Whether discarding it also spends something the source copy needs — a refresh token that
rotates on use, so that the copy left at the source is one the provider will no longer
honour — is not established, and settling it would mean reading the contents of a
credentials file, which nothing in this pipeline does. The behaviour below is correct
either way: a credential the config home was given is the newest one anybody has.

**Reporting made it unreadable as an authentication failure at all.** A session that cannot
sign in reports through the same `is_error` result, and the same non-zero exit, as a session
that crashed. What reached the journal was the CLI's sentence and nothing else — no
statement that a stage borrows the operator's login, and nothing a person could act on.

## Decision

### 1 — A credential the config home was given is kept

A regular file at the credentials path whose modification time is later than the source's
stays, and is what the next session reads. That file is a refresh the config home was
handed and holds nowhere else.

### 2 — A newer source replaces it, so signing in again is the way back

Everything else at that path is removed and relinked: a symlink (the ordinary case, and a
stale one when the source has moved), a directory, and a regular file the source has
overtaken. The last of those is what makes an interactive sign-in the recovery — it writes
a newer credential at the source, and the next stage picks it up — and it is also what
keeps a copy somebody left in the directory from standing in for the operator's own.

### 3 — The config home is private to the account that owns it

The directory is created `0700` and set back to `0700` on every call, because it holds a
live credential and a directory created under a looser umask would otherwise keep what it
was made with. The file's own mode is the session's to set; the directory's is the
pipeline's.

### 4 — A failure to authenticate says what it authenticates with

A failed result or a dead CLI whose wording is about signing in carries, after the CLI's own
account and never in place of it, a paragraph saying that a stage session authenticates with
the operator's own CLI login, where that credential sits relative to the config directory
the pipeline sets, that signing in interactively is the fix, and that a refresh a stage made
is kept in that directory rather than written back. It names no path on any particular
machine: it is printed, journalled and read by people who did not set the directory up.

Wording is the only evidence available for deciding that a failure is an authentication
failure, so the match errs toward yes. A false positive costs a paragraph of advice on an
unrelated failure; a false negative costs a person the diagnosis. The advice is attached to
a **failed** result only — a stage that succeeded while writing about sign-in screens returns
text that goes on to the journal and the proposal page, and an explanation of how the
pipeline authenticates does not belong in a stage's account of what it built.

### 5 — Sign-in is checked before a stage runs, not discovered inside it

`runStage` runs a one-turn session before the stage's own, against the same binary, the same
config home and the same flags, and refuses to start the stage when that session cannot
authenticate. A stage can run for the better part of an hour, and a credential already too
old to refresh fails the same way at the end of that as at the start, having spent the whole
budget to find out; the check costs a fraction of a cent and seconds.

It answers one question — can this machine sign in — and nothing else. A one-turn session
that reaches the model and then fails for its own reasons passes: refusing the run on that
would make this a second gate on every stage. A run stopped here is recorded and committed
like a failed `prepare`, because a run that stopped before its agent turn is still a run.

## Consequences

- A refresh survives the run that made it, and successive stages no longer start from the
  same ageing credential.
- The config home and the interactive login can hold different credentials. That is what
  the paragraph in §4 says out loud, and removing the credentials file from the config
  directory is how an operator collapses the two back together.
- A credential the config home holds is used in preference to the source while it is the
  newer of the two, so a file left there by anything else is read for as long as it stays
  newer. The narrower rule this replaces — always relink — cost a refresh on every run.
- Stale credentials are found in seconds rather than after a long stage, and the failure
  says what to do about it. A credential that goes stale *during* a long stage is not
  something any check can pre-empt, which is why §4 stands on its own.
- The directory is a session's whole config home, so the CLI keeps its own state there
  alongside the credential. What the *pipeline* puts in it is the credential and nothing
  else: no plugins, no MCP configuration, no global settings, no instructions file.

## What was considered instead

**Copying the credential into the config home instead of linking it.** It puts a second
durable copy of a secret on disk, and it fixes nothing: the copy is what gets refreshed, and
the refresh still has to survive the next call.

**Writing a refreshed credential back over the source.** The pipeline would be writing over
a file an interactive session is reading and rewriting on its own schedule, and losing that
race costs the operator their own login. The config home is the pipeline's to manage; the
source is not.

**Locking the credential across spawns.** A lock orders concurrent refreshes, and concurrent
spawns are not what this was: the runs were sequential, and each one's refresh was deleted
by the next one's first act.

**Reading the credential to check its expiry.** It is the cheapest possible pre-flight and
it is not available: nothing in this pipeline opens a credentials file. A one-turn session
answers the same question by asking the provider, which is a better answer anyway — a
credential can be well inside its expiry and still be refused.

**Giving the pipeline a credential of its own.** A sign-in provisioned for the pipeline
would end the sharing entirely, and on an executor that runs in CI rather than on a person's
machine that is what happens (`0004`). It is not available on a machine whose only sign-in
is the operator's.

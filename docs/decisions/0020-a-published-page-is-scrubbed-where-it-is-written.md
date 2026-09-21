# 0020 · A published page is scrubbed where it is written

Status: accepted · 2026-09-20

## Context

Egress rule E-2 keeps the machine a run happened on out of the repository the run commits
to. Absolute paths are the commonest way it gets in: an agent pastes a failing `npm run
check`, a test error carries the file it was thrown from, a container log names a mount,
and every one of those strings names a home directory and therefore a person.

`redactLocalPaths` has existed since the journal needed it, in `src/runner/journal.mjs`,
applied inside `writeJournal`. A journal entry is committed and published, its body is
whatever the turn and the post-checks produced, and catching a path in the egress check
after the commit catches it too late. That reasoning was right and it stands.

**It was applied to one of six writers.** The same agent text reaches a committed file by
five other routes:

- A proposal page. For every gated stage the page *is* the journal text verbatim, and the
  question and recommendation are drawn from it. Written to `.sdlc/proposals/<name>.md`,
  committed to the branch, and rendered to `site/proposals/<name>.{md,html}`.
- A ruling. An agent's rationale and conditions, plus the runner's own typecheck evidence,
  written to `.sdlc/gates/<name>.yaml` and appended to the proposal page as `## Ruling`.
- A verify result. Each row carries the acceptance test's own error, which is a stack trace
  from this machine, written to `tests/results/new/slice-<n>.json` on the proposal branch.
- A verify return. Its conditions are a failed service's log or a failing criterion's error,
  quoted so the builder has the evidence, written to the gate file.
- The run record. One line per run outcome, usually the first line of a stage's own account
  of itself, written to `.sdlc/runs/<day>.md` and published as `site/runs.{md,html}`.

A reviewer found it the way it was always going to be found: approving an unrelated
proposal, on a branch that was red on egress because a build proposal's page carried npm
error output with the project's own absolute path in it, and the site carried the same page
twice more.

`site/` deserves a separate mention. It is the published surface, and it holds no content
of its own — every page is rendered from one of the files above. So it inherits whatever
they carry, and it multiplies it: one proposal page becomes three files.

## Decision

**The helper moves to `src/lib/redact.mjs`** and every writer of agent-produced text into a
committed file calls it: the journal, `propose`, both gate-file writes and the ruling
section in `rule.mjs`, verify's result file and return gate, and `appendRun`. It is
idempotent, so a string that passes through two of them is unchanged by the second.

The rule it applies is unchanged. The project's own directory becomes a relative path,
because a reader of the repository is standing in it; any other local home path keeps its
tail and loses the root that names a machine and a person. `~/tools/bin/tsc` still says
which tool failed and no longer says whose.

**And `buildSite` redacts every page it writes.** Not as a second copy of the rule but as
the boundary: it makes "nothing under `site/` names this machine" a property of the
directory rather than a property of every writer that feeds it. The model grows — it reads
proposals, gates, the run record and the journal today and will read more — and a writer
added later that forgets the call is caught here rather than in a review.

**`appendRun` also folds newlines out of the line it is given.** The record is one line per
run outcome, and a caller that passes a multi-line message turns one entry into several
that no longer parse as entries.

## Consequences

A proposal page, a ruling and the published site now carry the same text the journal
carries: what the tool said, with the path that named a person reduced to `~`. Diffs of
existing files change the first time each is rewritten, and nothing is rewritten to make
that happen.

The redaction is a substitution, not a check. A path it does not recognise still gets
through, and the egress check remains the thing that says so. What has changed is that the
check no longer has to be the first line of defence for the one thing it was most reliably
catching too late.

## What was considered instead

**Scrubbing in the egress check instead.** The check reads files; it does not write them.
Making it rewrite what it finds would turn a check that reports into a check that edits,
and it still runs after the text is on disk and sometimes after it is committed.

**Redacting only what is published to `site/`.** `.sdlc/proposals/` and `.sdlc/gates/` are
committed and read directly — by a reviewer, by `rule`, by `build --revise`. A page that is
clean in the site and dirty in the branch is still a leak in the repository.

**Redacting once, at the commit.** Every writer here commits through a different path, and
some commit on a proposal branch while others commit on `main`. One hook covering all of
them does not exist, and the file is on disk before any of them runs.

**Leaving `buildSite` to trust its inputs.** It would be correct today and silently wrong
the first time the model reads a file nobody thought to redact. The site is the surface
that leaves this repository, and a guarantee about it should not be spread across six other
modules.

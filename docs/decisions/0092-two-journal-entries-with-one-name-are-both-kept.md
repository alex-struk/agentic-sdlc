# 0092 · Two journal entries with one name are both kept

Status: accepted · 2026-10-02

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A run's journal entry is named by the next number free in `.sdlc/journal/` on the branch the run
started from, followed by the stage: `419-build.md`. Two runs that start from the same `main`
take the same number. Where both are runs of the same stage, they write the same file name with
different contents. That happens whenever a run is made while another proposal of the same stage
is open, such as a build of one slice while another slice's build waits for verify.

When the second branch meets `main`, git reports a conflict on that file. Verify then refuses
the build as one that no longer merges, and the only way on is to rebuild the slice. A ruling's
merge into `main` stops the same way. Both entries are true accounts of runs that happened, and
neither is wrong.

## Decision

**A merge whose only conflicts are journal entries keeps both.** Where every conflicted path is
under `.sdlc/journal/`:

- the entry `main` already holds keeps its name, so the two branches agree about it from then on;
- the other entry is kept beside it under the same name with the first free `-<n>` added
  (`419-build-2.md`), and the merge is committed.

Verify's merge of `main` into a proposal branch and a ruling's merge of a proposal into `main`
both go through the same helper (`mergeInto`, `src/lib/git.mjs`). A conflict anywhere else is
reported as before, and the merge is undone.

## Consequences

- A proposal whose journal entry collided is verified and ruled like any other, without a
  rebuild.
- The journal's order is the order of the file names. An entry kept under `-<n>` sorts directly
  after the one it collided with, and each entry carries its own time in its front matter.
- Journal file names stay as they are. Entries already in projects keep their names, and
  nothing that reads them changes.

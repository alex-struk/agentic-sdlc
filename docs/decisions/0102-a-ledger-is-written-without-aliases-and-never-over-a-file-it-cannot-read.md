# 0102 · A ledger is written without aliases, and never over a file it cannot read

Status: accepted · 2026-10-04

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

The pipeline's owed work is kept in YAML ledgers (`src/spec/owed.mjs`): conditions, revision
requests, redo, rebind, recovery and the shared `.sdlc/owed.yaml`. A closing gives every entry it
closes the same closure object, and the YAML writer emits a repeated object once, as an anchor,
and refers to it from every other entry with an alias. The YAML reader refuses a document in which
one anchor is aliased more than a hundred times, as a guard against resource exhaustion. A ledger
read that fails is read as empty, by design: a stage is not stopped by a bookkeeping file it cannot
see.

So one closing of more than a hundred entries wrote a ledger every reader took to be empty, and the
next write, built on that empty reading, kept only what it added and put the loss on `main`. On
one project a single closing had already closed seventy-one entries at once.

## Decision

**A ledger is written without aliases, and read with no limit on them.** Every entry carries its
own copy of what it says. A ledger an older write left with aliases in it is read whole.

**A ledger on disk that does not parse is never written over.** A write refuses, naming the file,
and leaves it as it is. Reading such a file still yields nothing, so a stage that only reads the
ledger runs on.

## Consequences

- A closing of any size leaves a ledger every reader reads in full.
- A ledger damaged some other way stops the next write that would have truncated it, with the file
  named, rather than losing its history silently.
- A ledger written without aliases is longer on disk where many entries share one closure.

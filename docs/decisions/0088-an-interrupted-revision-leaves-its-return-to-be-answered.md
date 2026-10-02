# 0088 · An interrupted revision leaves its return to be answered

Status: accepted · 2026-10-02

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A build revision's pre-check takes up the slice's returned proposal before the builder runs. It
records the return on `main` and moves the branch to `returned/<name>`
(`recordReturnOnMain`, `src/stages/proposals.mjs`). A return recorded on `main` reads as spent.
A run stopped after that point and before it opened a proposal therefore left a return nobody
had answered. Examples are an operator's interrupt, a lost session and a killed process. Two
things followed:

- `build --revise` found nothing to revise from.
- `next` named a fresh `build --slice <n>`. A fresh build starts from `main` and discards
  everything the slice's builds had done.

## Decision

A slice whose newest build, by proposal number, is a returned one is owed a revision of it. When
a revision completes it opens a newer proposal, so a newest build that is a return is one no
revision has answered.

- **`build --revise`** takes that return up from `returned/<name>`. It does not record the return
  again, because the return is already on `main`.
- **`next`** names `build --slice <n> --revise` for the slice and says why. It does this when the
  newest ruling on `main` for the slice's builds is a return and no proposal of the slice is in
  flight.

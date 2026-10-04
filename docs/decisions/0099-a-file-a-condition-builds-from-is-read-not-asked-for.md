# 0099 · A file a condition builds from is read, not asked for

Status: accepted · 2026-10-04

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

`sdlc rule` refuses a return whose plain condition names a path the stage being returned cannot
write, because a stage handed work it cannot deliver either fails at it or reports it done
(`docs/decisions/0027`, `0036`). Every path-like token in the condition was read as a request.

A ruler sending a build back for a missing screen names two kinds of file in one line: the one to
change, and the one that says what to build. "`app/frontend/src/router.tsx`: serve the screen drawn
in `design/catalogue/<screen>.stories.tsx` at its route" asks for the router and points at the
design story the build reads. The build's workspace carries the contract, the design and the plan
for exactly that purpose. Read as a request, the design story made the condition undeliverable. On
one project the reviewer's return of a build was refused twice for this, once for naming the
contract the missing tab is declared in and once for naming the design story the missing screen is
drawn in. The second refusal ended the ruling with nothing recorded, and the run stopped.

## Decision

**A path the stage's workspace carries to be read, named in a condition beside a path the stage
delivers, is a source and is not refused.** The delivered path says where the work goes; the other
says what it is built from. A path the workspace does not carry at all is refused wherever it
stands: a build condition naming `tests/acceptance/...` asks the build to work from a test it never
sees. A condition naming only paths the stage cannot write is refused as before: "Add the tab to
`spec/contract/surface.yaml`" asks for the contract, and the contract is not the build's.

## Consequences

- A return can say what to build and what to build it from in one line, the way rulers write them.
- A condition that asks for a change to a source beside a change the stage can make is not caught
  here. The workspace still seals every path it carries to be read: a change under one ends the run
  with the path named rather than delivering it, and the run is told to leave such a request alone
  and say so in its journal.

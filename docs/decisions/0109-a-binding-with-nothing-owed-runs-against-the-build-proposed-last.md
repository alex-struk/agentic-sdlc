# 0109 · A binding with nothing owed runs against the build proposed last

Status: accepted · 2026-10-18

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A binding of the new target runs against the application a build proposal carries, started with
`sdlc sandbox up --target new --from <branch>`, and bind-adapter names the branch when it refuses a
sandbox that is not up (`docs/decisions/0078`). The branch comes from the rebind entries the run is
handed: each names a slice, and the slice's newest build is the application its rows were found on
(`docs/decisions/0080`). A run handed no entries takes the one open build proposal in the plan, and
with none open it took the newest build of the slice furthest on in the plan, on the ground that it
carries every slice approved before it.

That ground holds while slices are built in plan order and each is built once. A slice approved
earlier is built again when a later design or contract change asks its screens or behaviour to
change, and the plan's last slice was approved long before. Its build then carries none of the
approvals since, and a binding run against it binds the application as it stood before them.

Runs handed no entries are common. A G3 ruling that sends a build's failures to the adapter files a
revision request, not a rebind entry, and a request is closed the moment a run takes it up, so the
revision of a returned binding is handed nothing either. Each such run was bound against an
application that did not have the screens it was asked to read, and its reads were written from
the captured page text instead of the page.

## Decision

**With no entries and no build open, a binding runs against the build proposed last.** Of each
slice's newest build, the one whose `propose(<gate>): <name>` commit is newest is the branch named.
That build was proposed from `main` after every approval before it, so it carries them, and it is
the line of work whose failures the binding is answering. In a plan built in order, once each, it is
the furthest slice's newest build, as before. A branch that holds no such commit is not dated, and
where none is, the newest build of the slice furthest on in the plan is named.

Entries that name a slice are answered as before: the rows they carry were found on that slice's
application.

## Consequences

- A binding owed after a slice is built again is bound against that slice's build, which carries
  the screens its requests are about, and can run its reads against them before it is proposed.
- The refusal reads one commit date per slice that has a build, and only when the sandbox is not
  up.

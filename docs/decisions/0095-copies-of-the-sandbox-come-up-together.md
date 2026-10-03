# 0095 · Copies of the sandbox come up together

Status: accepted · 2026-10-03

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Verify spreads the acceptance suite across copies of the new target, one Playwright worker to a
copy (`docs/decisions/0090-verify-spreads-the-suite-across-copies-of-the-application.md`). Each
copy is a compose project of its own, on ports of its own, with its own database. Bringing one up
is a build, a start, the waits for its addresses and a seed. On one machine that took 45 seconds a
copy with the images already built.

The copies were brought up one after another, so every verify waited for the sum of them before
its first test ran: about two and a quarter minutes for three copies. More copies make the suite
itself faster, and the approval run grows with every slice approved, since it runs every criterion
earlier slices passed. Bringing up copies one after another made each further copy cost every
verify another 45 seconds, failing ones included.

## Decision

**Every copy a verify asks for is brought up at the same time.** The long steps of bringing a copy
up (`docker compose up --build --wait` and the seed) run without holding the process, so each copy
proceeds as its own commands allow. A verify waits for the slowest copy rather than for the sum of
them.

**The lowest-numbered copy that does not come up is the one reported,** with the same message as
before (`copy <i> of the <n> (<project>): …`). Copies that did come up are taken down with the rest,
as before. A sandbox brought up for one person, or for an adapter to be bound against, is still one
copy.

## Consequences

- Bringing up three copies takes about as long as bringing up one, so a project can declare as many
  copies as its machine has memory and processors for, and each one shortens the suite without
  lengthening the start.
- Copies building the same images at once share the image builder's cache, and the first build of a
  changed image may be done by more than one copy.
- A failure in one copy no longer stops the copies after it from being started; they are taken down
  when the run ends, as every copy is.

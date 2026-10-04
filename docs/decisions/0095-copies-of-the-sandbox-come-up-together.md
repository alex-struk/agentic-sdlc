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

**The first copy comes up alone, and the rest come up together.** Every copy builds the same images
from the same files, and building one image several times at once repeats the work; on one machine
it failed partway through installing an image's packages. So the first copy a verify asks for comes
up alone and builds them. The rest then come up at the same time, from what it built: the long
steps of bringing a copy up (`docker compose up --build --wait` and the seed) run without holding
the process, so each copy proceeds as its own commands allow. A verify waits for the first copy and
then the slowest of the rest, rather than for the sum of them.

**The lowest-numbered copy that does not come up is the one reported,** with the same message as
before (`copy <i> of the <n> (<project>): …`). A first copy that does not come up is reported before
any other is started. Copies that did come up are taken down with the rest, as before. A sandbox
brought up for one person, or for an adapter to be bound against, is still one copy.

**The copies go down together.** Taking a copy down stops and removes its containers and volumes,
and copies share none of them, so every copy's `docker compose down -v` runs at once and a verify
waits for the slowest. The teardown is not ok when any copy's is not.

## Consequences

- Bringing up six copies takes about as long as bringing up two, so a project can declare as many
  copies as its machine has memory and processors for, and each one shortens the suite without
  lengthening the start.
- The images are built once per verify, by the first copy; a build step that depends on a copy's own
  settings, such as an address baked in at build time, still runs once for each copy.
- A failure in one of the later copies does not stop the others from being started; they are taken
  down when the run ends, as every copy is.

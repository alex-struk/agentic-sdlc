# Stage: `plan`

## Purpose

Cut the build of the system into vertical slices, and write down how that plan meets the
constitution. It holds gate G2, ruled by the architect persona.

Unlike every stage before it, this one is not per-domain. A slice crosses domains by definition —
a vendor finding and reading an opportunity is opportunities and content and users at once — and a
plan cut one domain at a time would produce layers wearing a slice's name.

## Inputs

`sdlc run plan [--dry-run]`, run from inside the project's working tree, on `main`. The project
must carry at least one accepted criterion, and `design/screens.yaml` must exist: a plan cut
before the screens are drawn is a plan cut against guesses about them, and how much of a screen
one slice delivers is exactly what the design settles.

## Workspace

`plan`: `spec/`, `design/`, `constitution.md` and `.claude/skills/` as read-only context, plus
`plan/` and `docs/decisions/` — what this stage delivers — archived from `HEAD` alongside them. No
application and no acceptance suite: a plan that can see which criteria already have tests will
cut its slices around the tests rather than around the work.

The plan and the decision records are in the workspace because they are what a revision starts
from, and because a stage that writes over a directory it never read leaves behind whatever it did
not happen to rewrite. Everything else the workspace carries is sealed: a change to `spec/` or
`design/` here is not this stage's to deliver, and the run ends naming the paths rather than
dropping them (`docs/decisions/0027-a-run-that-fabricated-success.md`).

## Outputs

`plan/plan.md`: how the system is to be built, what runs where, which existing data survives, and
why the slices are in this order. It must carry a `## Constitution check` section saying which of
the constitution's rules bear on this work and how the plan meets each.

`plan/tasks.md`: the slices in build order, one `### Slice <n> · <title>` heading each, with a
`- criteria:` line naming what that slice is answerable for. The shape follows the criteria's own
format (`docs/spec-format.md`) — a heading, then fields as list items — so a plan reads like the
rest of the spec rather than like a second format somebody has to learn.

`docs/decisions/NNNN-<slug>.md`: a decision record for any choice a later reader would otherwise
have to reverse-engineer.

## Checks

`plan-constitution-check` refuses a missing or empty `## Constitution check` section. A heading
with nothing under it is the section added to satisfy the check rather than to answer it.

`plan-criteria-assigned` refuses a criterion in two slices, a criterion the spec never accepted,
and — the one this check exists for — an accepted criterion no slice builds. That last is how a
rebuild quietly loses behaviour: it was written down, it was ratified, it has a test, and no slice
was ever going to build it.

A slice carrying most of the spec is warned about rather than refused. Whether a big slice is
really one piece of work is a judgement only a person can make, so it is put in front of the
persona that can rather than decided by arithmetic.

## What a slice is

A piece of the system that can be built, run and shown on its own, crossing every layer it needs.
A slice that delivers "the database layer" or "all the forms" is not a slice; it is a layer, and
nothing can be demonstrated until every other layer lands beside it. No check can tell the
difference, which is precisely why G2 is ruled by a persona and not by a script.

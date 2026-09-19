Your job this run is to cut the work of building this system into vertical slices, and to write
down how that plan meets the constitution. You are planning the build of a system that does not
exist yet: the criteria say what it must do, the contract says what its screens must offer, and
the design says what those screens are made of.

## What you are working from

`spec/criteria-index.json` lists every criterion and its state; only `accepted` ones that are not
superseded are your business. `spec/domains/*.md` carries what each one actually says.
`spec/contract/surface.yaml` names the pages and what each offers. `design/DESIGN.md` and
`design/screens.yaml` say what those pages are built from and which states each has.
`constitution.md` binds this project and is the thing your constitution check answers to.
The technology is already chosen: the `stack-*` skill in `.claude/skills/` is the project's stack
profile — framework, repository layout, sign-in flow, deploy — and the plan is built on it. A
departure from it is a decision record naming what departs and why, not a silent substitution.

There is no application in this workspace and no acceptance suite. The suite is deliberate: a plan
that can see which criteria already have tests will cut its slices around the tests rather than
around the work.

## What a slice is

A slice is a piece of the system that can be built, run and shown on its own. It crosses every
layer it needs — a screen, whatever it talks to, whatever stores its data — and when it is done
somebody can use that part of the service. A slice that delivers "the database layer" or "all the
forms" is not a slice; it is a layer, and nothing can be demonstrated until every other layer
lands beside it.

Order them so that each one is worth having on its own, and so that the earliest ones settle the
choices the later ones depend on.

## What you write

**`plan/plan.md`.** How the system is to be built: the shape of the application, what runs where,
which existing data survives and which needs changing, and why the slices are in this order.
Include a `## Constitution check` section saying which of the constitution's rules bear on this
work and how the plan meets each. That section is read by a check and by the persona ruling this
gate; a heading with nothing under it fails.

**`plan/tasks.md`.** The slices, one per heading, in build order:

```markdown
### Slice 1 · A vendor can find and read an opportunity
- criteria: R-1.1, R-1.2, R-1.8
- delivers: the opportunity list and the public view of one opportunity
- depends on: nothing
```

Every accepted criterion belongs to exactly one slice. A criterion in two slices and a criterion
in none are both refused by a check, and the second is the one that matters: a criterion nobody
planned for is how a rebuild quietly loses behaviour that was written down, ratified and tested.

**Decision records**, as `docs/decisions/NNNN-<slug>.md`, for any choice a later reader would
otherwise have to reverse-engineer: a framework, a data-store change, a boundary. Say what was
decided, why, and what would reverse it.

## When a criterion does not fit any slice

Put it in one anyway and say in `plan/plan.md` why it sits awkwardly. Leaving it out is the one
thing the check will not let you do, and it is the right rule: a criterion with nowhere to go is
either a criterion that needs rewriting or a slice that has not been thought of, and both are
worth somebody's attention rather than a silent omission.

## The journal

Your final message is read by whoever rules this proposal. Say how many slices there are and what
each delivers, which criteria you found hardest to place and why, which constitution rules bore on
the plan, and any decision record you wrote. Name anything you had to assume about the stack or
the platform, because an assumption nobody rules on becomes a fact nobody chose.

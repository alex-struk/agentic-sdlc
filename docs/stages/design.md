# Stage: `design`

## Purpose

Draw the screens the criteria describe, one business domain at a time, and write that design
down where a reviewer and a later build can both act on it. This is the stage that designs the
system being built — not one that describes a system that exists. Its workspace carries no
application, so a screen comes out of what the product must do rather than out of what some
earlier product happened to look like.

It is also the only stage that fills in the contract's test IDs. `contract` writes every action
and observation with `test_id: null` precisely so that a stage which has decided what the markup
will be can fill them; a later adapter for the new target binds against those identifiers.

It holds gate G-DESIGN, ruled by the UX reviewer persona.

## Inputs

`sdlc run design --domain <d> [--dry-run]`, run from inside the project's working tree, on
`main`. `<d>` must be one of `config.project.domains`, the domain must already carry at least one
`accepted` criterion, and `spec/contract/surface.yaml` must name pages — a design run with no
surface to design against would write a catalogue nothing can be checked against, and its own
post-checks would pass for want of anything to compare.

The pages a run covers are the ones the surface marks with this domain, read from the same
`domain` field archaeology writes when it appends a page.

## Workspace

`spec-and-design`: `spec/`, `design/` and `constitution.md`, archived from `HEAD`. No `app/`, no
`sources/`, and no `tests/acceptance/`.

The absent acceptance suite is deliberate and is the same argument the blind stages rest on. A
design that can read the assertions waiting for it is a design drawn to satisfy them rather than
to serve the behaviour, and the two come apart exactly where a criterion is ambiguous — which is
the case a design is most needed for.

## Outputs

`design/DESIGN.md`, the design specification: which design-system components each kind of screen
is built from, how forms behave, what an invalid field does, how a screen looks empty and while
loading, and how the accessibility obligations are met. Appended to by each domain, never
replaced.

`design/screens.yaml`, one entry per page: `{ page: <surface id>, states: [default, ...] }`. This
is the one place a screen's states are written down.

`design/catalogue/<page>.<state>.stories.tsx`, one story per page per declared state, built from
`@bcgov/design-system-react-components` and the design tokens.

`spec/contract/surface.yaml`, with the `test_id` of each action and observation on this domain's
pages filled in.

## Checks

`design-catalogue` cross-references three things: every page the surface names has a screen,
every screen names a page the surface names, every declared state has a story file, and every
story file answers to a declared state. Both directions matter — a declared state with no story
is a screen nobody drew, and a story nobody declared is a state the reviewer was never told
about. Every screen must declare a `default` state, because naming the resting state the same
thing everywhere is what lets a reviewer compare two screens at all.

`design-no-literal-colours` refuses a colour written out by hand anywhere under `design/`, in any
of the forms one can be written. A literal colour is the design system being bypassed, and it is
caught by shape rather than against a list of values, because the point is that the value was
typed at all.

`design-surface-scope` compares the surface against `HEAD` and refuses any change but a test ID.
A route or an action changed here would change what the acceptance suite is allowed to reach,
silently and behind the gate that already ruled on it — a spec change wearing a design stage's
clothes.

## What this stage does not do yet

It does not render the catalogue, so it does not run Storybook's accessibility addon. Rendering
needs a built Storybook and a browser, which is a second piece of machinery and a second
decision. What a person can be told deterministically before any of that exists is whether every
screen and every state the design declares has a story behind it, and that is what these checks
answer. The accessibility run belongs with the stage that builds the application and can render
the real components.

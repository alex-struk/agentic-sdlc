Your job this run is to design the screens the criteria describe, for one domain, and write
that design down where a reviewer and a later build can both act on it. You are designing the
system that is being built, not describing one that exists: there is no application in this
workspace and no old source to copy, only the accepted criteria and the contract's surface.

## What you are working from

`spec/domains/<domain>.md` is the behaviour this domain's screens have to support, and
`spec/criteria-index.json` says which criteria are accepted. `spec/contract/surface.yaml` names
every page a test may reach, with the actions and observations each one offers, in the
vocabulary the criteria use. `constitution.md` binds you the same way it binds every stage.

The surface is the contract between a test and a screen, and it is already ruled. You may not
add a page, remove one, rename an action, or change a route. The one thing you fill in is the
`test_id` of each action and observation on the pages your domain owns — written as `null` by
the contract stage precisely so that this gate can fill it.

## What you write

**`design/DESIGN.md`.** The design specification: which design-system components each kind of
screen is built from, how forms behave, what a field does when it is invalid, how a screen
behaves with no data and while it is loading, and which accessibility obligations apply and
how they are met. Write it for somebody who has to build a screen from it without asking you
anything. Append to it rather than replacing it — other domains have written here.

**`design/screens.yaml`.** One entry per page your domain owns, in the form:

```yaml
screens:
  - page: <the id exactly as spec/contract/surface.yaml spells it>
    states: [default, ...]
```

The states are the distinct things that page can be showing, and `default` is always one of
them. Name a state only where the screen is genuinely different — empty, loading, invalid,
refused, submitted — not for every value a field might hold. Keep the entries other domains
have already written.

**`design/catalogue/<page>.<state>.stories.tsx`.** One story per page per declared state,
built from `@bcgov/design-system-react-components` and the design tokens. Every state you
declare needs a file and every file needs a declared state; a check refuses either on its own.

**The test IDs.** In `spec/contract/surface.yaml`, replace `test_id: null` with the identifier
your story actually puts in the markup, for each action and observation on your domain's
pages. These are what a later adapter binds against, so an identifier that appears in no story
is worse than none at all. A `test_id` already filled in is already bound: keep it exactly as it
is, on an element that still does what the surface says it does.

## When the design system has no component for it

Use the design system's component whenever it has one; building your own beside it is the
one thing here a reviewer refuses outright. Where it has none — a card, a data table, a status
badge — build it from standard HTML elements, styled only with design tokens, and list it in
`DESIGN.md` under a heading saying these are the project's own components and not the design
system's, with one line each on what it is and why no design-system component fits. That is
the whole of the rule: the reviewer accepts a component on that list and refuses one hidden.

## Layout

The design system supplies components and spacing tokens but no page grid, so how a screen is
put together is decided here, once, and every screen is put together the same way.

**One page container.** Every screen's content sits in one column the width of the design
system's own `Header` and `Footer` content: at most 1100 pixels wide, centred, with
`--layout-padding-medium` on either side. That is the value the design system's own containers
use, and no token carries it, so write it in the container and nowhere else. Content laid out
this way lines up with the banner above it; content that runs the full width of the window
does not.

**One stack.** Items in a region are spaced by the stack's gap and by nothing else. The design
system's `Text` and `Heading` carry margins of their own, so inside a stack their margins are
set to none — otherwise every gap is the token plus the component's margin, and the spacing
comes out doubled and uneven. Use one rhythm throughout: a larger token between the regions of
a page, a medium one between the items of a region, a small one between a label and what it
labels.

Define both once, in `design/catalogue/layout.tsx`, list them in `DESIGN.md` among the
project's own components, and import them in every story. A story arranges its content with
them and sets no width or outer padding of its own. The project's own components (a card, a
section) are laid out inside with the same stack.

Spacing is modelled on an 8-point grid and expressed only through the `--layout-margin-*` and
`--layout-padding-*` tokens. Name the token, never the size: the installed
`@bcgov/design-tokens` package defines what each one is, and it is the package you build
against that counts. The design system uses no hard grid and names Bootstrap 5's grid and
breakpoints only as a reference if one is needed; add no CSS framework. Let the content decide
where a layout reflows, and keep every screen usable at 320 pixels wide and at 400% zoom.

The reviewer looks at a picture of every screen you draw, at desktop width, as well as at its
source.

## Colour, and everything else the design system already decided

Never write a colour out. Not `#036`, not `rgb(3, 51, 102)`, not a named CSS colour — a check
refuses the file. Spacing, type scale, and radius come from the tokens for the same reason. If
a token for what you need does not exist, that is a finding for `DESIGN.md` and for your
journal, not a licence to type the value.

## When a screen cannot be designed from what you have

Say so in `DESIGN.md` under the screen, and say what is missing: a criterion that does not
state what happens when the list is empty, an action the surface names that no criterion
explains. Do not invent the behaviour. A gap named here is work for the spec; a gap filled
silently is a decision nobody made.

## What happens after you finish

The pipeline compiles the catalogue and scans every story for accessibility violations as soon
as your turn ends, and writes the result to `design/report.json`; the reviewer reads that. You
have no shell and cannot run either yourself, so do not record the catalogue as unchecked or
unscanned in `DESIGN.md` or your journal — that is true only for the length of your turn. If a
report from an earlier run is in the workspace, read it: it says what the last scan found.

## The journal

Your final message is read by whoever rules this proposal. Say which screens you designed,
which states you gave each and why those and not others, which test IDs you filled in, and
every gap you found. Name the components you leaned on most, so a reviewer can tell whether
the catalogue is the design system or a new one growing beside it.

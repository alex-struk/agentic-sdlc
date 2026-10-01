# 0086 · Layout is a design rule, and a design's ruler sees the screens

Status: accepted · 2026-10-01

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

The design system supplies components and spacing tokens. It supplies no page grid and no
content width, and its published layout guidance says it "does not use a hard grid". Nothing told
a design run how a screen is put together, so each story set its own outer padding, width and
gaps.

Two defects followed, and every build copied them faithfully because a build is told to build
each page from its story:

- Page content ran the full width of the window, while the design system's `Header` and `Footer`
  keep theirs in a centred column. The content did not line up with the banner above it.
- Spacing was doubled. A stack's gap was added to the margins the design system's `Text` and
  `Heading` carry of their own.

None of G-DESIGN's checks could see either. They read source, a compiler's verdict and an
accessibility scan. The reviewer read story source and never a rendered screen.

## Decision

**1. Layout is decided once, in the catalogue, and used everywhere.** The design stage defines
one page container and one stack in `design/catalogue/layout.tsx`, lists them among the project's
own components (`docs/decisions/0009-a-catalogue-is-compiled-and-scanned.md`, section 4), and
uses them in every story.

- The container takes the content width the design system's own containers use: at most
  1100 pixels, centred, with `--layout-padding-medium` either side. No token carries that width,
  so it is written once, in the container.
- Inside a stack, the components' own margins are set to none, so the gap is the only spacing.
- Spacing is named only by token. The installed tokens package defines what each one is, so the
  values in use are the ones the project builds against.
- Bootstrap's grid is a reference only, as the design system's guidance says, and no CSS
  framework is added.

The build stage defines the same two pieces once in the application and lays every screen out
with them.

**2. A design's ruler is given pictures of the screens.** Before an agent rules on a design
proposal, the runner renders each of the proposal domain's stories at desktop width and saves a
picture of each into `design/screenshots/`. The ruling request lists the pictures and asks for
the layout to be judged by eye. When no picture could be taken, the request says why, and asks
for the rationale to say the screens were not seen.

The pictures are not committed, for two reasons:

- They are retaken for every ruling, so committing them would add a domain's worth of images to
  the history each time.
- A ruling must leave the tree as it found it.

The folder is in the required ignores. A person holding the same seat sees the same screens by
opening the catalogue (`npm --prefix design start`). The evidence is the same; only the way it
arrives differs.

The UX reviewer refuses a screen outside the shared container, spacing that is doubled or uneven,
and a change to a `test_id` that was already filled in. The design stage is told to keep a filled
`test_id` exactly as it is, because an adapter is already bound to it.

**3. `init` installs the design harness.** `design/scan.mjs` and `design/.storybook/` are the
pipeline's. A design run is refused for touching them, so `init` refreshes them the way it
refreshes the acceptance harness, and commits them. `design/package.json` and `tsconfig.json`
are not refreshed: which design-system version a project draws against is the project's to move.

The scanner's digest of the catalogue now covers every module in `design/catalogue/`, not only
the stories. An edit to the shared layout changes every story that imports it, and a report
written before the edit is not evidence about the screens after it.

## Consequences

- A project designed before this has screens that do not follow the layout rule. Each domain's
  design is brought into line by a design run with a stated reason (`sdlc run design --domain <d>
  --reason …`). The run is a full proposal at G-DESIGN, ruled with the pictures. The screens
  already built are brought into line by a build run with a stated reason, ruled at G3.
- Storybook's development server pre-bundles only the packages it finds by crawling the stories.
  A story never names React itself, so the template's Storybook configuration lists React for
  pre-bundling. Without that, `npm start` renders no story. `init` delivers the corrected
  configuration with the rest of the harness.
- The pictures are as good as the catalogue's build. A catalogue that does not build gives the
  ruler no pictures and a reason, and the compile check fails the proposal anyway.

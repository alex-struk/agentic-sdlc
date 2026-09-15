# 0009 — A design catalogue is compiled and scanned before its gate is ruled

**Status:** accepted · 2026-09-15

`design` draws a domain's screens as a catalogue of Storybook stories, one per page per state,
built from the BC Design System. Gate G-DESIGN asks whether those screens serve the domain's
criteria and are built from the design system. This records what the gate is given to rule on,
and what a design may use when the design system has no component for what it needs.

## 1 — A catalogue nobody has compiled is not evidence about the design system

**Decision.** After a design run's work is collected, the pipeline compiles the catalogue and
scans every story, and writes what it found to `design/report.json`. The gate fails a catalogue
that does not typecheck or does not build, and fails a report written for stories that have
changed since it ran.

**Why.** The stage writes React and has no shell. A story naming a component the design system
does not export, or passing a prop that component does not take, reads exactly like a correct
one; so does a token name that looks right and is not defined. A reviewer reading source text
cannot tell them apart, and the UX reviewer persona declined to try: it escalated a catalogue
whose component and token names were, in its words, unchecked.

Two compilers, because they catch different things. The Storybook build resolves every import
and fails on a component that does not exist. The typecheck is what rejects a prop that does.

**Why the report carries a digest of the catalogue.** A revision fixes a story, and the report
from before it still says zero. Without a record of which stories it read, the old report would
pass the new catalogue on evidence about the previous one.

## 2 — "No accessibility violations" is shown, not claimed

**Decision.** Every story is rendered in a browser and scanned with axe. The gate fails on any
violation, on any story that did not render, and on any story file the scan did not reach.

**Why the last two.** An unrendered story is an unscanned one. Storybook reports a story that
threw by rendering an error page, which is itself an accessible document, so a scan that did not
look for it would count a broken screen as a clean one. And a scan that stopped partway would
report zero over the stories it reached.

**Why this is a gate check and not a reviewer's judgement.** For a government service
accessibility is a requirement. The persona's position — that it "cannot approve an unproven
zero" — is correct, and the only thing that can make the zero proven is a scan.

**What a scan does not settle.** Axe finds the violations a rule can detect. Reading order that
makes sense, labels that mean something, and a focus path a keyboard user can follow remain the
reviewer's to judge. The report removes the part a machine does better, and nothing else.

## 3 — The harness is read by a design run and never changed by one

**Decision.** `design/package.json`, `tsconfig.json`, `scan.mjs` and `.storybook/` are carried
into the design workspace and a run that changes any of them fails.

**Why carried.** They tell the writer which version of the design system it is drawing against,
and `design/report.json` beside them tells a revision what the last scan found.

**Why never changed.** The same access that lets the writer read the scanner would let a failing
scan be answered by editing it. That is the one repair that would make the gate's evidence
worthless, and it is ruled out by a check rather than left to a prompt.

## 4 — Where the design system has no component, a design may adapt, and says so

**Decision.** A design may use a pattern the design system does not provide when three things
hold: the design system has no released component for the need; the pattern is the standard
accessible one for it; and `design/DESIGN.md` names it as a project adaptation rather than
presenting it as official. The first users design used three, all accepted on these terms:

- **Section navigation** as a `<nav>` of links with `aria-current="page"`, because each profile
  section is its own route and the design system has no released tabs component.
- **A status badge** that states its status as a word, bordered with tokens, so status is never
  carried by colour alone.
- **A data table** as a native `<table>` with a caption and column headers, inside a focusable
  region that scrolls horizontally at narrow widths.

**Why the tech lead rules on these and the UX reviewer does not.** Whether a project may depart
from the design system is a policy question about the service, and each adaptation is a thing
the project will maintain that the design system will not. The UX reviewer's brief sends it on,
and it did.

**What would reverse an adaptation.** The design system releasing a component for the same need.
A pattern kept after that is no longer an adaptation; it is a divergence.

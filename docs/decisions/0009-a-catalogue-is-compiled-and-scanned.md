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

## 4 — Where the design system has no component, a design builds its own and names it

**Decision.** A design uses the design system's component wherever it has one. Where it has none,
the design builds one from standard HTML, styled only with design tokens, and lists it in
`design/DESIGN.md` as the project's own component rather than the design system's. The UX
reviewer accepts a component on that list and refuses one rebuilt by hand where the design system
already provides it. This is the pipeline's default behaviour; a project configures nothing to get
it.

**Why a default and not a question each time.** The first users design needed four such
components — section navigation, a status badge, a data table and a choice card — and the UX
reviewer, told only to escalate "a new pattern not in the design system", escalated them. Every
design of every domain would do the same, and each escalation would ask the same question. Tokens
already carry what makes a screen look like the service (colour, spacing, type), and the colour
check refuses anything else, so a component built from them is consistent by construction; what a
reviewer needs is to know it is there, which the list gives.

**Why not configuration, and not the constitution.** The constitution holds what the product must
meet, and article P2 already says the design system *should* be used, not *must*. A setting for how
strict a design stage is would belong in `.sdlc/config.yaml`, and none is added until a project
needs different behaviour from this default.

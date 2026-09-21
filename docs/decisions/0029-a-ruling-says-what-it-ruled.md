# 0029 · A ruling says what it ruled

Status: accepted · 2026-09-21

## Context

`sdlc rule <name> --by <seat>` printed one line: `<name>: <verdict>`. The rationale, every
condition a return or an approval carried, and the target of an escalation were reachable
only by opening the gate file or reading the commit diff. Three operators reported this
independently, and the sharpest statement of it was that the absence of conditions and the
absence of output are indistinguishable at the terminal — an operator who does not know to
go looking reports "approved, no conditions" without ever having established whether
conditions existed at all.

**A return's conditions are the case that matters most.** They are instructions a later
run acts on — `ratify` executes them against a domain file, `derive-tests` reads them off
`redo.yaml`, a returned build's next attempt is judged against them — and a terminal that
shows the verdict and nothing else is a terminal that cannot tell a clean approval from a
return carrying three unread instructions.

**The re-prompt `0028` added has the same shape, one layer down.** When a guard refuses a
ruling's condition and the persona is re-prompted, nothing said so: no console line, no
field on the gate file, no persisted transcript of the first attempt. Worse, the ruling's
`metrics` block was overwritten with the second turn's numbers rather than summed with the
first, so a ruling that cost two turns reported the cost of one. An operator asked whether
a re-prompt had fired could not answer from any artifact the run leaves, and a recovery
path that cannot be audited cannot be trusted to have run. The same overwrite turned out to
sit in a second place: `ruleByAgent`'s own automatic retry of a ruling turn that failed
outright kept only the retry's cost, dropping whatever the failed first attempt had already
spent.

Both are the same defect at different depths: a surface that should say what happened does
not, so the record a person or a later run relies on is thinner than the work actually was.

## Decision

### 1 — A ruling prints its verdict, every condition in full, where it was recorded, and the escalation target

`formatRuling` (`src/commands/rule.mjs`) builds this for `sdlc rule <name> --by <seat>`,
`sdlc rule <name> --by agent:<persona>`, and every ruling `sdlc rule --pending` prints as it
works through a batch — one function, so the three call sites cannot drift apart the way the
single-line print and the batch's own line had already begun to.

Every condition is shown in full, one per line, because a condition is an instruction and
summarising the actionable part would recreate the defect this closes. An approval or
return that carried none prints `conditions: none` rather than nothing, so a ruling with no
conditions reads differently from a ruling that was never shown any. The rationale behind
the verdict is pointed at rather than quoted whole past a fixed length — it explains the
verdict, and the gate file this line names already carries the rest of it. An escalation
prints the seat it went to.

### 2 — Terminal output is redacted the same way the gate file is

A ruling's rationale and conditions are an agent's own prose and routinely quote a path on
the machine the ruling ran on; the gate file is already passed through
`redactLocalPaths` (`src/lib/redact.mjs`) before it is written for exactly that reason. The
same text reaches the terminal now, so it goes through the same pass — nothing is printed
that the committed file would not carry.

### 3 — A re-prompt says so at the terminal, and names what the first reply got wrong

Both re-prompt paths in `ruleByAgent` — the ratification-grammar re-prompt `grammar.unparsed`
already ran, and the deliverability re-prompt `0028` added — now print a line the moment
they fire, in the same words the persona is being asked to fix. A batch run over several
proposals shows exactly which ones needed a second turn and why, rather than an operator
inferring it from a gate file's `unparsed_conditions` key existing or not.

### 4 — A re-prompted ruling's gate file records what the first attempt got wrong

A new `reprompt` field, written only when a re-prompt fired, holds the same account the
console line prints: what the first reply ruled and what was wrong with it. The verdict and
conditions the gate file already carries are the corrected reply; without this field they
read as though the persona wrote them right the first time, which is exactly the gap `0028`
otherwise left open. It sits beside `unparsed_conditions` — a ruling can carry one, the
other, or neither, but the two mechanisms never fire on the same ruling, since one applies
only where a proposal's conditions are read as instructions (`G1`, and a triage page at
`G3`) and the other only where they are not.

### 5 — Two turns' metrics are summed, not overwritten

`sumMetrics` folds cost and turns together and keeps the first turn's session — the same
shape `finishStage`'s own fix turn already uses for a stage's repair turn. Applied
everywhere `ruleByAgent` asks a persona more than once for the same ruling: the
ratification-grammar re-prompt, the deliverability re-prompt, and `askOnce`'s own automatic
retry of a turn that failed outright. A ruling that took two turns to reach its verdict
spent both of them, and a gate file or a caller told about only the last one is told less
than the ruling actually cost.

### 6 — The other commands were checked for the same shape

`run`, `checks`, `sandbox` and `status` already print what they did rather than a verdict
alone: `checks` lists every check by id with its messages, `sandbox up`/`reset`/`down` print
the failure's own messages or the address it came up on, `status` lists every page and asset
it wrote, and `run` already prints a failure's full messages and names the proposal it
opened. Nothing in this decision changes them.

`resume` did not. Once it reaches `finishStage` — the ordinary case, a session resumed after
a crash or a repeated post-check — it returned an exit code with no console output at all on
either the success or the failure path, silent in a way `run` reporting the identical result
shape was not. It now prints the same success line `run` does (`resume <stage>: ok`, plus the
proposal opened where one was) and the same failure line (`resume <stage>: failed`, plus the
messages), so a run continued through `sdlc resume` is told what happened the same way one
that never crashed is.

## Consequences

- A return's conditions, an approval's absence of them, and an escalation's target are all
  readable at the terminal, without opening the gate file.
- A re-prompted ruling is auditable from what the run itself printed and from what its gate
  file records, not only from a transcript nobody kept.
- A ruling's reported cost is what it actually spent, including a turn that failed or was
  refused before a second one landed.
- `resume` reports a resumed run's outcome the same way `sdlc run` reports a fresh one.

## What was considered instead

**Printing the whole rationale rather than pointing at it.** A rationale can run to a
paragraph or more, and unlike a condition it is not itself the actionable part — it explains
the verdict the conditions already state in full. Printing it whole would make a return with
several conditions unreadable at a terminal for the sake of text the gate file already
carries next to the conditions this line names.

**A loop of re-prompts recorded as a list.** `0028` already settled the ceiling at one
re-prompt per ruling, for the same reason `grammar.unparsed`'s did before it: a turn that
gets it wrong twice is not making a formatting slip, and a batch running unattended must not
turn one stuck proposal into an unbounded retry. A single `reprompt` field says everything a
list would, because there is never more than one entry.

**Exporting `formatRuling` for a caller to build its own view.** Nothing outside this file
prints a ruling; the three sites `sdlc rule` reaches internally are the whole of what needed
it, and exporting it would advertise a shape (three positional pieces of a gate file) that
has no reason to travel further than this module's own commands.

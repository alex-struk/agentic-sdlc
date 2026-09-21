# 0026 · A ruling is shown what it is ruling against

Status: accepted · 2026-09-20

## Context

`0014` settled that a build ruling is shown the build, and `0023` applied the same principle to
the build's evidence: what a gate is decided on cannot depend on surviving a diff cap, so the
verify result is read, summarised and carried in a section of its own outside the budget. This
is the third member of that family, and the one furthest from the diff.

A ruling prompt was built offline for a proposal that regenerated a domain's acceptance tests.
It contained the persona brief, the proposal page, the tier, the diff summary, the diff and the
checks. The text of the criteria the tests are derived from appeared nowhere in it, and nothing
in it named a path where criteria live.

**That ruling is a comparison, and one side of it was missing.** The question at the gate is
whether each test asserts what its criterion states and nothing more. The criterion's statement
is in the domain file and in the compiled index; the test carries an id in a two-line header. A
regenerated test is partially rescued by accident, because the convention is for its title to
quote its criterion verbatim, so the ruler compares a sentence against a copy of itself. Nothing
rescues the other cases:

- A **deleted spec** appears as a path and a line of prose. Its criterion's statement is on the
  branch only in a file the diff had no reason to show.
- A criterion **recorded as untestable** is the same shape. The reviewer is asked to judge
  whether a criterion can honestly be marked as one nothing on the surface can demonstrate, with
  the criterion's own words absent.
- A **plan** assigns criteria to slices by id. `0024` recorded a G3 reviewer finding that a
  slice claimed a criterion nothing it builds could demonstrate — a fact about the plan,
  discovered downstream, which the gate that ruled the plan had no way to see because the plan's
  page names ids and never text.

The ruling turn holds `Read`, `Grep` and `Glob` and can fetch any of it. Nothing tells it where,
so it spends its turns searching for what the prompt should have handed it — and a ruling turn's
budget is a dozen turns.

**The family is a gate given everything about a decision except the thing the decision turns
on**, which is `0023`'s own words. `0023` closed it for the suite result. The criteria are the
other half: the result says what the application did, and the criterion says what it was
supposed to do.

## Decision

### 1 — A ruling prompt carries the text of the criteria the proposal touches

In a section of its own, before the diff and outside its budget, exactly as the verify result
is. Each criterion is quoted with its id, version, confidence, state, the file it is defined in
and its statement, plus its given/when/then where it has one — which is the part a derived test
is actually written against.

### 2 — What a proposal "touches" is read off the proposal, not off the stage that opened it

Three sources, and no stage name or path convention among them:

- **The ids in the paths of the files it changes.** A file derived from a criterion is named for
  it by convention, which is why a spec the proposal *deletes* still says which criterion it
  was answerable to.
- **The ids in the changed lines of those files.** This is where a criterion being recorded as
  untestable, dropped from a list, or claimed by a slice is written down — none of which the
  path says.
- **The ids its own page names.**

An id is recognised by the same grammar a domain-file heading is parsed with, exported from one
place so the two readings cannot drift. The ids from the changed files and the ids from the page
are kept apart, because they rank differently: a criterion whose own file this proposal changed
is what the ruling is about, and one the page mentions is context. The cut falls on the second.

### 3 — Which gates get it is decided by the proposals, and is not a list

A proposal that derives, assigns or claims criteria names them; one that does not names none and
gets no section at all. In practice that means the plan gate and the gates holding the derived
suite, the adapters, the build and a calibration triage — the rulings that are made by comparing
something against a criterion nobody quoted — while an intent proposal and a policy article get
nothing.

This is the reasoning `0024` gives for reading addressable stages off the registry rather than
listing them. A gate list in the prompt builder is a second place to keep in step, and it goes
stale in the direction that is hardest to notice: a new stage's proposals stop being given their
criteria, and the gap looks exactly like a decision somebody made.

### 4 — It is bounded by construction, and every cut says what it cut

At most thirty criteria are quoted, each field cut at a fixed length, so the section is a few
thousand characters however many criteria a proposal names. Anything past the cap is listed by
id with the two places it can be read. The files read for ids are capped as well, by length and
by count, and a proposal whose remaining files were not read for ids is told so — a criterion
decided in a file nobody read is a criterion missing from the list, and that has to be visible.

A criterion defined in a file this proposal itself changes is named and not quoted: its text is
the proposal's own output, ordered first in the diff, and quoting it here would be the same text
a second time — the reason the proposal page and the verify result are left out of the diff for
their part.

### 5 — A criterion whose text cannot be found is named as missing

Three sources are tried: the compiled index on the proposal's branch, then the branch's own
domain files for an id the index has not caught up with, then the index on `main` for a branch
cut before the criterion was ratified onto it. An id none of them holds is named in the section
as unresolved, with a line saying that this is a gap in what was shown rather than a statement
that the criterion does not exist, and that a ruling turning on one of them is a return.

Absence of evidence must not read as evidence of absence. A ruler shown a shortened list has no
way to tell a criterion that was never there from one the prompt could not look up, and the
second is the one that should stop a ruling.

### 6 — The briefs say what the section is and what its gaps mean

The reviewer's and the architect's briefs describe it on both counts: that the criteria are
quoted before the diff and are what the derived work is compared against, and that a criterion
named as missing is a reason to return rather than something to rule around. `0023`'s
reconciliation is what delivers that to projects that already exist.

## Consequences

- A ruling on a deleted spec, or on a criterion recorded as untestable, is made against what the
  criterion says rather than against its id.
- A plan ruling sees the text of every criterion its slices claim, at the gate that rules the
  plan. `0024`'s route for carrying that finding back upstream stays exactly as it is; this is
  what gives the first gate a chance to see it.
- A ruling turn spends its dozen turns on the ruling instead of on finding the criteria.
- The prompt grows by a bounded amount on the proposals that need it and by nothing at all on
  the ones that do not.

A person in a gate seat is handed no prompt — that is true of the verify evidence `0023` added
and of the typecheck evidence before it — and reads the criteria on the branch. What the seats
share is every refusal and every power, which is where interchangeability is decided; the prompt
is how an agent is given what a person would go and read.

## What was considered instead

**Naming a path in the brief and leaving the ruler to fetch it.** It is cheaper and it is what
the defect already is: the ruler can read any file on the branch, and the whole finding is that
it should not have to spend a ruling's budget working out which. It also fails for the case that
prompted this, where the file the ruler would be told to read is the one the proposal deleted.

**Widening the diff to include the domain files.** It puts the criteria inside the budget that
decides whether they arrive, which is the thing `0014` and `0023` each concluded was wrong, and
it shows the whole of every domain rather than the criteria the proposal is about.

**Reading the ids out of the stage that opened the proposal.** The stage knows exactly which
criteria it worked on, and wiring that through would tie the prompt to a stage's own output
shape, one stage at a time, with every new stage starting from nothing. The proposal is the
common artifact, and reading it is what makes this work at gates nobody has built yet.

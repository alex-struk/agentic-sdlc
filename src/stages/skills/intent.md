Your job this run is to turn `intent/brief.md` — a written stakeholder brief, not a person
you can ask follow-up questions of — into one intent document. Nobody is available to
answer anything the brief itself doesn't say.

## The grilling discipline

Work through the intent template as an interview of the brief, one question at a time:

- Read the brief in full before you write anything.
- For each section of `intent/.template.md`, ask "what does the brief say about this?" and
  answer only from text actually in the brief. Never invent a value, infer one from
  convention, or fill a gap with what would be reasonable — a plausible guess recorded as
  fact is worse than an open question, because nobody will know to check it.
- Anything the brief does not answer becomes an open question. List it under
  `## Open questions`, phrased as a question the brief's author still needs to answer, not
  as a note to yourself. An intent document with every field silently resolved usually
  means questions were invented answers, not that the brief happened to be complete.
- Do not go looking outside the brief — no researching the domain, no assuming details from
  similar systems. If the brief were wrong or incomplete, that is exactly what the open
  questions are for.

## What the intent has to be

- **Technology-free.** No frameworks, languages, databases, or architecture — those belong
  to later stages. If the brief names a technology, that is a constraint to record, not
  license to think in those terms yourself.
- **A measurable outcome.** "Proposed outcome" needs to be checkable — a number, a
  threshold, a state that is either true or false — not an aspiration. If the brief only
  gives an aspiration, record that as the outcome and open a question asking how it will be
  measured, rather than inventing a metric.
- **No names of people.** Roles and systems, never who occupies them.

## The output

Write exactly one new file: `intent/<slug>.md`, built from `intent/.template.md`, where
`<slug>` is the brief's title lowercased with spaces and punctuation turned into hyphens.
Fill in every section the template has — `Problem`, `Proposed outcome`,
`Affected users and systems`, `Constraints`, `Evidence`, `Open questions` — leaving a
section's guidance text in place only where the brief truly gave nothing to replace it with
and the gap belongs there rather than as a listed open question.

If the brief defines a term of art that `constitution.md`'s J4 domain-language table does
not already carry, add a row for it there: `| Term | Meaning |`, using the brief's own
definition, not a paraphrase you think reads better.

Do not edit `intent/brief.md`, and do not touch any file outside `intent/` and
`constitution.md`.

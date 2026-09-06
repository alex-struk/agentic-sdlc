# Spec format: criteria in domain files

A criterion is what the system must do, stated once, in one place. A project's spec lives as one
Markdown file per business domain — `spec/domains/<domain>.md`, where `<domain>` is one of the
names in `.sdlc/config.yaml`'s `project.domains` — and each file is a sequence of criterion
blocks. Nothing else lives under `spec/domains/`.

`spec/criteria-index.json` (the machine-readable index) and `spec/spec.md` (the generated,
readable index) are produced from these files by `sdlc run ratify`; neither is edited by hand.
The parser that turns a domain file into both — `parseDomainFile`, `parseAll`, `writeIndex`,
`renderSpecIndex` in `src/spec/criteria.mjs` — is the actual contract this document describes: if
this page and the parser ever disagree, the parser is what every other stage runs against.

## One block

```
### D-permits-1 · v1 · inferred · recovered
When an applicant submits a completed permit application, its status shall change to
"Under review" and the assigned reviewer shall be notified.
- cites: src/lib/permits/application.ts:88
- reconciliation: implemented-only
- given: a permit application with all required fields completed
- when: the applicant submits it
- then: the application's status changes to "Under review" and the assigned reviewer receives a notification
- note: the old system logs this transition but has no automated test for it
```

## The heading

```
### <ID> · v<version> · <confidence> · <origin>
```

- **`<ID>`** is either `D-<domain>-<n>` — a provisional ID, minted by archaeology or written by
  hand, not yet ratified — or `R-<domain-number>.<n>` — a permanent ID, minted only by `sdlc run
  ratify`. The domain segment of a `D-` ID must match the file it lives in; `checkCriteria`
  (`src/checks/criteria.mjs`) fails a file where it does not.
- **`<version>`** is an integer starting at 1, incremented whenever the criterion's meaning
  changes (correcting a typo does not need a new version; changing what "under review" means
  does).
- **`<confidence>`** is one of `confirmed`, `inferred`, `open`. A criterion never ratifies while
  it is still `inferred` or `open`, and `checkCriteria` fails one whose `state` is `accepted` but
  whose confidence has not caught up.
- **`<origin>`** is `recovered` (found in an existing application) or `authored` (written new, no
  prior system to point at).
- The separator between the four fields is the middle dot `·` (U+00B7). A plain hyphen
  surrounded by spaces (` - `) is also accepted, for the same reason a plain apostrophe is
  accepted where a typographic one would be correct: an agent (or a person) without the real
  character at hand still needs to write a valid heading.

## The body

The first non-empty, non-bullet line (and any further non-bullet lines before the first bullet)
is the statement: one sentence, technology-free, stating what the system does and for whom.

After the statement, bullet lines carry everything else. Each is `- key: value`; an unknown key
is a parse error.

| Key | Value | Repeats |
| --- | --- | --- |
| `cites` | `<path>` or `<path>:<line>`, relative to the old application's checkout (`sources/old`) | yes, once per citation |
| `reconciliation` | `aligned` \| `implemented-only` \| `documented-only` \| `conflicting` \| `defect` | no |
| `given` | the starting condition | yes — repeats join with " and " |
| `when` | the triggering action | yes — repeats join with " and " |
| `then` | the observable outcome | yes — repeats join with " and " |
| `note` | free text; anything worth recording that has no other field | yes — every note is kept |
| `state` | `proposed` \| `accepted` \| `implemented` \| `verified` \| `monitored` (default `proposed`) | no |
| `tier` | `LOW` \| `STANDARD` \| `HIGH` \| `CRITICAL` | no |
| `replaces` | the ID of a criterion this one supersedes | no |
| `superseded-by` | the ID of the criterion that replaced this one | no |

A `recovered` criterion needs at least one `cites`, since a claim about what the old application
does has to point at where; `checkCriteria` fails one that has none. A `defect` reconciliation —
the old application does something the spec says it should not — needs either a `replaces` (the
ID of the corrected criterion) or a `note` saying explicitly that there is no replacement yet.

## Checks

`checkCriteria` (`src/checks/criteria.mjs`, run by `runChecks` whenever `spec/domains` exists)
fails on: a parse error in any domain file; the same ID appearing in two domain files; a
`recovered` criterion with no `cites`; a `cites` path that does not exist under `sources/old`
(only when `sources/old` is present — a citation cannot be checked against a source that has not
been materialised yet, so a missing `sources/old` turns this into a warning instead); a criterion
whose `state` is `accepted` while its confidence is still `inferred` or `open`; and a `defect`
reconciliation with neither a `replaces` nor a note saying there is none. `checkLayout` requires
`spec/domains` to exist at all.

## Why this shape

See `docs/decisions/0005-criteria-in-domain-files.md` for the full record. In short: agents write
Markdown reliably and YAML unreliably at this level of nesting; a domain file is the unit that
one archaeology run and one ratification proposal produce and rule, so the file boundary matches
the unit of work rather than splitting or merging it; and a strict line format lets the parser be
the actual contract — a criterion either parses or it is a finding, with nothing in between for a
reviewer to interpret by eye.

# 0005 — Criteria live in one Markdown file per domain, in a strict line format

**Status:** accepted · 2026-09-06

**Decision.** A project's criteria are not one large spec file and not a structured data format
(YAML, JSON). They are Markdown, one file per business domain (`spec/domains/<domain>.md`), each
file a sequence of criterion blocks in the strict heading-plus-bullets format described in
`docs/spec-format.md`. `spec/criteria-index.json` (machine-readable) and `spec/spec.md`
(generated, readable) are derived from the domain files by `sdlc run ratify`; neither is a source
of truth in its own right.

**Why Markdown, and not YAML or another structured format.** The domain files are written by an
agent — archaeology recovers criteria from an old application; a person or another stage authors
new ones — and an agent's reliability at producing valid output drops as nesting and quoting rules
increase. A YAML document with a `given`/`when`/`then` list nested under a reconciliation object
nested under a criteria array is the shape that goes subtly wrong: a mis-indented list item, a
colon in a statement that needed quoting, a block scalar that swallowed the next key. None of
those are visible in a diff the way a malformed heading line is. Markdown with one criterion per
`###` block and flat `- key: value` bullets is close enough to prose that an agent writes it
reliably, and close enough to a fixed grammar that a parser can validate it strictly — the two
properties do not usually come together, and here they do because the format is deliberately
narrow: nothing nests more than one level, and every field is a single line.

**Why one file per domain, and not one file for the whole spec.** A domain file is the unit that
one archaeology run produces and one ratification proposal rules: `sdlc run archaeology --domain
<d>` writes `spec/domains/<d>.md` and opens one G1 proposal about it; a reviewer rules that
proposal by reading that file, not by locating the relevant paragraphs inside a spec covering
every domain at once. Splitting the file at the domain boundary keeps the unit a reviewer reads,
the unit a stage writes, and the unit a proposal names all the same thing. A single spec file
would need the same information sliced back out for review anyway — this format skips the
slicing and lets the file boundary do it for free. It also means two domains can be worked (and
ratified) concurrently without one agent's in-progress edit colliding with another's inside the
same file.

**Why a strict line format, and not free-form prose with embedded fields.** The parser
(`parseDomainFile` in `src/spec/criteria.mjs`) is the actual contract, not this document or the
template's own comments. A criterion either matches the grammar — a recognized heading, a
statement, bullets with recognized keys — or it produces a parse error that `checkCriteria`
surfaces as a finding. There is no third state where a criterion "mostly" parses and a human has
to decide by eye whether the index is missing something. Free-form prose with fields mentioned
inline would move that judgment back onto whoever reads the file next, which is exactly the
ambiguity a criterion — the unit this pipeline measures progress by — cannot afford to carry.

**What changes later.** Nothing about this shape is expected to change with scale; more domains
means more files, not a different format. If a criterion someday needs structure this format
cannot express (a table of per-region values, say), that is a new bullet key or a new
reconciliation class added to the grammar, not a reason to move off Markdown — the same tradeoff
that makes YAML worse for an agent to write applies just as much to whatever richer format would
replace it.

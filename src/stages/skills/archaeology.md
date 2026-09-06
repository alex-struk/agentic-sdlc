Your job this run is to recover what an existing, unfamiliar application actually does for one
business domain, by reading its code rather than asking anyone — there is no one to ask, and the
old application's own commit history is the only account of its own decisions that exists.

## Where to look, and where not to

Everything you may read lives under `sources/old`, a read-only checkout of the old application
pinned to one commit. Work through it the way you would any unfamiliar codebase:

- **Entry points** — routers, controllers, CLI commands, cron jobs — to find where a request for
  this domain starts.
- **Models and migrations** — the shape data actually takes, which is often truer than any prose
  describing it, and migrations show what the shape used to be and why it changed.
- **Validation** — what a request is rejected for, not just what it is accepted for. A rejection
  rule is exactly as much a criterion as an acceptance one.
- **Status transitions** — the states a record moves through and what triggers each move.
- **Permissions** — who (which role, never which person) is allowed to trigger which transition.
- **Docs, README, and any OpenAPI/swagger file** the old application carries, read alongside the
  code rather than instead of it: prose and code disagreeing is itself a finding.

Two things are permanently off limits, not just for this run but as a habit this whole pipeline
depends on:

- **`sources/old/tests`.** A test suite encodes what its own authors believed the code should do,
  which is a second opinion about intent — exactly the kind of thing archaeology exists to
  recover independently, from the code's actual behaviour, so that a spec built from tests can
  never simply rediscover the tests it was compared against. Whatever the old application
  excluded here, it stays excluded before your session even starts; you do not need to check
  which paths that was, only to never go looking for a `tests/` directory yourself.
- **Anything outside `sources/old`**, except `constitution.md`, `spec/` (to see what earlier
  domains already recovered), and `intent/` (to see what problem this project is solving). No
  private notes, no paths belonging to a later stage, no reaching into the pipeline's own
  history.

Never name a person, in a citation, a note, or the journal — a role or a system, never who
occupied it.

## Writing one criterion

A criterion is one observable behaviour, stated as one sentence, technology-free, testable by
someone who has never read the old application's source: "when X happens, the system shall do Y"
— never "the code calls `validateAge()`". Read `spec/README.md` before writing the first one; it
is the exact grammar this file is checked against, and a block that does not match it is a parse
error, not a style preference.

For each criterion:

- **Mint a provisional ID**, `D-<domain>-<n>`, numbered from 1 within the domain file you are
  writing. Never write an `R-` ID — minting a permanent one is ratify's job, done only after a
  human has ruled on what you recovered here.
- **Set origin to `recovered`** — everything this stage writes came from an existing application,
  never invented.
- **Cite where you found it.** Every criterion needs at least one `cites: <path>` or
  `cites: <path>:<line>`, relative to `sources/old`. A claim about what the old application does
  has to point at where; a criterion with no citation is indistinguishable from a guess.
- **Grade confidence by the evidence, not by how sure you feel:**
  - `confirmed` — the code and a second source (the README, a doc, an OpenAPI file) agree.
  - `inferred` — only the code shows it; nothing else corroborates or contradicts it.
  - `open` — sources contradict each other, or the behaviour cannot be pinned down from what is
    there. Say why in a `note`; an `open` criterion with no note is a dead end for whoever rules
    on it next.
- **Choose a reconciliation class:** `aligned` (matches something already expected of the new
  system), `implemented-only` (the old app does this, nothing has said yet whether the new one
  should), `documented-only` (a doc claims it but the code doesn't do it), `conflicting` (sources
  disagree with each other), or `defect` (the old app does something that should not carry
  forward — needs a `replaces` or a `note` explaining why there is no replacement yet).
- **Write given/when/then.** The starting condition, the triggering action, the observable
  outcome — concrete enough that a later stage can turn it into a test without reading the old
  application at all.

## The contract surface

Alongside the domain file, append what you recovered about the domain's shape to
`spec/contract/surface.yaml` (pages, each carrying a `domain: <d>` field so a later reader can
tell a recovered page from one designed fresh) and, if the domain introduces a role
`spec/contract/personas.yaml` doesn't already list, append that role there too. Both files already
exist; add to them, do not replace what is already there for a different domain.

## The journal

Your final message is read by someone who has not seen the old application and will not read your
session. Lead with three sentences on what the domain actually does. Then say what conflicted
between your sources. Then say what you could not determine, and why — a gap you noticed is worth
more to the next reader than one you quietly filled in.

# Stage: `contract`

## Purpose

Complete `spec/contract/` — the pages, personas, API description and observables the acceptance
tests (a later stage) and the oracle (a running comparison target) will act through — from what
the ratified criteria say the system does, reading `sources/old` when this project has one. It
also writes synthetic seed data (`tests/seed/`) and, when this project configures an oracle, the
Compose override the oracle needs (`.sdlc/oracle/`). It holds gate G1, the same gate archaeology
holds: the contract is spec content, not implementation, and nothing later builds tests against it
until the product-owner persona rules it. Why this is a stage of its own rather than part of
archaeology or ratify, and why the Compose override is project content ruled at G1 rather than
something the pipeline generates: `docs/decisions/0006-contract-stage-and-oracle.md`.

## Inputs

`sdlc run contract`, run from inside the project's working tree, on `main`. Unlike archaeology and
ratify, it takes no `--domain` — one run completes the contract for every domain the criteria
touch at once, not one domain per run. When `config.sources.old` is set, the stage reads
`sources/old` the same way archaeology does — a read-only checkout pinned to the configured
commit, with every excluded path already removed, and `sources/old/tests` off limits. When it is
not set, the stage reads only `spec/domains/` (and `spec/criteria-index.json`, once ratify has
run) — there is no old application to recover anything from, so the contract is authored fresh
from the ratified criteria.

## Outputs

- `spec/contract/surface.yaml` completed: one entry per page the criteria need, each carrying a
  `domain:` field, a route, a title, and actions/observations named in the criteria's own
  vocabulary — never a selector or a test ID.
- `spec/contract/personas.yaml` completed: every role with a `can` list and a `sign_in` entry for
  every identity `config.oracle?.identity` and every `config.targets[*].identity` name, deduplicated.
  A persona with no sign-in at all carries `sign_in: null` explicitly. A role the target genuinely
  offers no way to act as carries `sign_in: { <identity>: { unavailable: "<reason>" } }` instead —
  used only when the target truly has no way to act as that role, with a reason saying why.
  `bind-adapter`'s `signIn` throws `unbound: signIn.<persona id> — <reason>` for an identity marked
  this way, so calibrate reports every criterion that needs it as `unbound`.
- `spec/contract/openapi.yaml`, assembled from the old application's own API description when one
  exists, or written from its routes, with a `# recovered from <path(s)> at <commit>` header — only
  when `config.sources.old` is configured.
- `spec/contract/observables.yaml` completed: email via a mail catcher at `${SDLC_MAIL_API}`, plus
  any file or notification endpoint the criteria need.
- `tests/seed/NNN-<name>.sql`, applied in name order, and `tests/seed/manifest.yaml` naming every
  record a test will refer to by handle.
- `<oracle.compose_override>` (`.sdlc/oracle/compose.yml` by default) — a Compose override for
  `config.oracle.compose` — only when `config.oracle` is configured.
- A journal entry and a run-record line, as every stage produces. The journal says which pages
  exist, which sign-in method each persona uses, what the seed contains, and what could not be
  recovered.
- A proposal at gate G1: `.sdlc/proposals/contract-v<n>.md` on a new `proposal/contract-v<n>`
  branch (`<n>` = 1 + however many `contract-v*` gate files are already on disk — one per ruling,
  not per attempt), holding the question "Is this the contract the tests will act through?" and a
  recommendation taken from the agent's own journal text, the same way archaeology's is.

## Workspace the agent sees

`stage.workspace` is a function of `config`: `with-sources` when `config.sources.old` is set,
`project` otherwise. With sources, the workspace materialises exactly as it does for
archaeology — `ensureSources` clones and pins `sources/old`, and the `implement-guard` hook still
blocks every path outside the ones this stage owns. Without sources, the agent works directly in
the project's own working tree with no extra materialisation step, since there is nothing under
`sources/old` for it to see.

Either way, the guard row for `contract` allows only `spec/contract/`, `tests/seed/`, and
`.sdlc/oracle/` — every other path, including `sources/` itself, is out of its territory.

## Checks that block

- **Pre-checks.** None beyond what the workspace itself needs. Unlike archaeology and ratify,
  `contract` does not take `--domain`.
- **Post-checks**, run against the working tree after the agent session ends:
  - `loadContract` (`src/spec/surface.mjs`) reports no errors across `surface.yaml`,
    `personas.yaml`, `observables.yaml` and `tests/seed/manifest.yaml`.
  - Every persona (other than one whose `sign_in` is exactly `null`) carries a `sign_in` entry for
    every identity this project's config actually uses. An entry may declare
    `{ unavailable: "<reason>" }` in place of real credentials; the reason has to be a non-empty
    string, or this check fails the same way a missing entry does.
  - Every domain with at least one `accepted` criterion (read from `spec/criteria-index.json`, when
    it exists) has at least one page in `surface.yaml` carrying that `domain:`.
  - `openapi.yaml` parses as YAML with a top-level `openapi` key and at least one path — only when
    `config.sources.old` is configured.
  - Every `tests/seed/*.sql` file is non-empty.
  - `checkEgress` passes over the project (synthetic seed data that reads as a real name, a real
    email, or a real ticket number is exactly the kind of leak this check exists to catch).
  - The oracle's compose override exists and parses as YAML — only when `config.oracle` is
    configured. Nothing here brings Docker up; that is `sdlc oracle`'s job.
  - Nothing changed outside `spec/contract/`, `tests/seed/` and `.sdlc/oracle/`, checked against
    `git status --porcelain`.

## Exit criterion

Exits 0 and prints `run contract: ok (opened proposal/contract-v<n>)` once the proposal branch is
open. Any pre-check or post-check failure exits 1 and prints the failing check's messages;
whatever the agent wrote, if anything, stays in the working tree, untracked, for inspection.

## Re-run behaviour

`contract` re-runs the same way any gated stage does (`docs/stages/run.md`): its own proposal must
be ruled before it can run again. Unlike archaeology, whose proposal name (`archaeology-<d>`) is
fixed per domain, `contract` has no natural per-run key — a rebuild is a rebuild — so each ruled
attempt gets its own version: the first run opens `contract-v1`; once that is approved and merged,
the next run opens `contract-v2`, and so on. A returned or escalated proposal's branch is left in
place and keeps blocking a re-run until a person deletes it, exactly as archaeology's does.

## Failure modes

- The contract's own proposal (`proposal/contract-v<n>`) is still open: refused before a workspace
  is materialised, the same way archaeology's re-run check works.
- The agent session itself fails to run, or reports failure: handled the same way every stage's
  agent-turn failure is (`docs/stages/run.md`).
- A persona is missing a `sign_in` for a configured identity, an accepted criterion's domain has no
  page, `openapi.yaml` cannot be recovered, a seed file is empty, `checkEgress` finds something, the
  oracle override is missing or malformed, or the agent touched a path outside its territory: the
  matching post-check fails, `finishStage` commits `stage(contract): post-checks failed` with only
  the journal and run record staged, and whatever the agent actually wrote is left untracked in the
  working tree for a person to look at.

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

The product-owner persona rules this proposal in the same ratification grammar archaeology's is
ruled in (`docs/stages/rule.md`, "Ratification conditions": `edit <ID>: …`, `confirm <ID>`,
`defect <ID>: …`, `spike <ID>: …`, `obsolete <ID>: …`, `contract <ID>`) rather than a plain
approve/return — a contract review routinely surfaces a criterion that needs tightening or is
already well-evidenced by reading the contract, and this is where that gets said. Each condition
names a criterion id from whichever domain it belongs to; `ratify --domain <d>` (`docs/stages/
ratify.md`, "Inputs") applies every condition whose id belongs to `<d>`, on the next run for that
domain, the same way it applies its own archaeology and follow-up rulings.

## Route parameters a test can actually obtain

A page's route may carry a parameter, and a test can only open that page if it can get a value
for it. Two shapes make that impossible, and both went undetected on a real project until the
generated types were tightened, at which point they accounted for 145 of 315 compile errors.

The first is a record the test creates and then cannot address. A test drafts something, and the
only handle it holds is the title it typed; the route wants an identifier, and nothing in the
surface returns one. So the agent is told: if an action creates something the criteria later
refer to, the page it lands on needs an observation returning that record's identifier.

The second is a page that is also the signed-in person's own — their profile, their settings,
their dashboard. Declared with a required parameter, a test acting as itself has no id to pass.
That page needs its own parameterless entry as well.

The rule the agent applies to every page it writes: a route parameter must be either a handle in
`tests/seed/manifest.yaml` or the return of some observation. Anything else makes every criterion
on that page untestable, and says so only much later, in a calibration run.

## Starting the oracle, when the project has one

Writing the Compose override is not the same as knowing it works, and nothing the agent can read
tells it whether the application will start. A file-storage path the image cannot create, an
environment variable the application validates, a migration that needs a service that is not up:
none of those are visible in source, and all of them are visible in an exit code. So the agent
runs `sdlc oracle up` itself and iterates on its own override until the application serves.

Three things bound that loop, and each exists for a reason.

**Done is not "a page was served".** An application that starts against a broken database serves
a page too. The bar is that the migration ran, the seed loaded, and a record named in
`tests/seed/manifest.yaml` is visible through the application. That is the first point at which
the target is behaving like the system the criteria describe.

**Three attempts, not "until it works".** Each attempt rebuilds the image and costs minutes.
A failure the agent cannot resolve in three is one a person needs to see, and an unbounded loop
spends the stage's whole budget discovering that — leaving no contract at all, which is the worse
of the two outcomes.

**The target may not be weakened to make it start.** The agent may change the override's
environment, paths, ports and service definitions. It may not skip or disable the migration,
relax authentication or authorisation, stub out a service the application really uses, or set a
flag that changes what the application does rather than where it runs. This target is the
definition of correct behaviour for everything built against it: an oracle that starts because it
was weakened is worse than one that does not start, because the weakening is invisible in every
result that follows.

An oracle that still will not start is a result rather than a failure. The agent leaves its best
honest attempt in place and says in its journal what happens, what it tried and what it thinks is
needed. A contract whose surface is complete and whose oracle does not start is a reasonable thing
to put in front of a gate — the reviewer can weigh it, and a person can act on a named cause.

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

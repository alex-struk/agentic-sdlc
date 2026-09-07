# Stage: `bind-adapter`

## Purpose

Write the one binding of the abstract `Surface` for one running target: the agent drives a real
browser (the Playwright MCP server) against the running application and never reads its source,
because its workspace never has any application source to read. It holds gate G3, the same gate
`derive-tests` holds: the reviewer persona rules whether the adapter binds navigation and locators
only, covers everything the contract names, and touches nothing outside its own target's corner of
the tree.

## Inputs

`sdlc run bind-adapter --target <t> [--dry-run]`, run from inside the project's working tree, on
`main`.

`--target old` binds against the oracle this project's own `sdlc oracle up` started: it requires
`config.oracle` with `oracle.target: old`, and the oracle must already be up — its base URL and
mail API are read from `.sdlc/oracle-old.local.yaml` (`readLocal`, `src/oracle/ports.mjs`), written
by `sdlc oracle up` and never committed. Any other `--target <t>` must be a key of
`config.targets`, and its base URL comes straight from `targets.<t>.base_url` — a real target has
no local file and no mail catcher of its own for this stage to point at.

## Outputs

- `tests/adapters/<t>/index.ts`, exporting `default function create(page, { baseURL, persona }):
  Surface`, implementing every page `tests/generated/surface.d.ts` declares.
- `tests/adapters/<t>/bindings.yaml`, naming every action and observation of every page in the
  surface exactly once, as `bound` or `unbound: <reason>`.
- A journal entry and a run-record line, as every stage produces.
- A proposal at gate G3: `bind-adapter-<t>` the first time a target is bound, or
  `bind-adapter-<t>-<n>` on a re-run (`<n>` = 1 + however many `bind-adapter-<t>` or
  `bind-adapter-<t>-*` gate files already exist — one per ruling, the same counting rule
  `contract`'s own `-v<n>` versioning follows), holding the question "Does this adapter bind every
  surface action and observation on `<t>`, and nothing else?" and a recommendation taken from the
  agent's own journal text.

## Workspace the agent sees

`stage.workspace` is the fixed string `blind-adapter`: a temporary directory built by `git archive
HEAD` over `spec/contract`, `tests/adapters`, `tests/seed`, `constitution.md` and the pipeline-owned
test harness — never `app/`, never `tests/acceptance/`. Before the agent turn starts,
`stage.prepare(wsDir)` runs `writeGenerated(wsDir)` (`src/spec/surface.mjs`), turning the archived
contract into `tests/generated/surface.d.ts`, `personas.ts` and `seed.ts` right there in the
workspace, exactly the way `derive-tests`'s own `prepare` does — so the agent's very first read of
`Surface` is the type it is about to implement.

Once the session ends, only `tests/adapters` is copied back into the project (`stage.collect`):
`tests/generated/*` is derived from the contract already committed on `main` and needs no commit of
its own here. The guard row for `bind-adapter` allows only `tests/adapters/` — every other path,
including `app/` (which this workspace never even materialises), `tests/acceptance/` and `spec/`,
is out of its territory.

## The browser, tools and environment

`stage.mcp` declares one MCP server, `playwright`, run as `npx -y @playwright/mcp@0.0.80
--headless --isolated` — the first stage in this pipeline to declare `mcp` at all
(`docs/stages/run.md`, "MCP servers, tools and environment"). `stage.allowedTools` narrows the
session to `Read`, `Write`, `Edit`, `Glob`, `Grep` and `mcp__playwright__*`: no `Bash`, since an
adapter session drives a browser and edits files and has no business reaching a shell. Why a
browser rather than a script the session runs itself, and why the server is pinned rather than
tracked: `docs/decisions/0006-contract-stage-and-oracle.md`.

`stage.env` carries three variables into the session, none of them printed by a dry run except by
name: `SDLC_TARGET_URL` (the target's base URL), `SDLC_MAIL_API` (its mail catcher, `old` only —
empty for every other target), and `SDLC_SANDBOX_PASSWORD` (the well-known sandbox password used to
sign in through a `sandbox-idp` identity, taken straight from the operator's own environment, empty
when unset). This is the first stage whose `env` actually carries something worth keeping off a
dry run's screen.

## Checks that block

- **Pre-checks.**
  - `--target <t>` is set; `old` requires `config.oracle` with `oracle.target: old`; any other name
    must be a key of `config.targets` — `target "<t>" is not "old" and not in config.targets: ...`.
  - A target whose identity is `sandbox-idp` needs `SDLC_SANDBOX_PASSWORD` in the environment:
    without it the session reaches the sign-in form, submits an empty password and is refused, and
    a whole agent turn is spent producing nothing. The message names the variable and never a
    value (`export SDLC_SANDBOX_PASSWORD before binding against <target>`).
  - The target answers HTTP at its base URL: for `old`, resolved from
    `.sdlc/oracle-old.local.yaml`, failing `bind-adapter: the old target is not up; run sdlc oracle
    up first` when that file does not exist; for any other target, `targets.<t>.base_url`. The
    probe itself is a plain "does anything answer at all" check — any HTTP status counts — with a
    5s timeout, and is skipped entirely under `SDLC_ORACLE=mock`.
- **Post-checks**, run against the working tree after the agent session ends, in order:
  - `checkSeparation` (`src/checks/separation.mjs`): the adapter asserts nothing, defines no
    `test()`, and imports nothing from `tests/acceptance/` or `app/`.
  - `bindings.yaml` exists, parses, and names every surface page's action and observation exactly
    once — `bound` or `unbound: <reason>` — and names nothing the surface does not declare, judged
    against the same `loadContract` result `tests/generated/surface.d.ts` was generated from.
    Names are compared as `spec/contract/surface.yaml` spells them, not as the camelCased
    TypeScript members the adapter implements: `submit_proposal`, not `submitProposal`. The prompt
    and the skill say so, because getting it wrong reports twice — once as a surface name left out
    and once as a name the surface does not have.
  - `tests/adapters/<t>/index.ts` exists.
  - Every changed path is under `tests/adapters/<t>/` — which, since this workspace never even
    materialises `tests/acceptance/` or `spec/`, is also the guarantee that neither was touched.

## Exit criterion

Exits 0 and prints `run bind-adapter: ok (opened proposal/bind-adapter-<t>)` (or the `-<n>` name)
once the proposal branch is open. Any pre-check or post-check failure exits 1 and prints the
failing check's messages; whatever the agent wrote, if anything, stays in the working tree,
untracked, for inspection.

## Re-run behaviour

A first run's proposal name (`bind-adapter-<t>`) is fixed, so a second run against the same,
still-unruled proposal is refused, the same as `archaeology`'s per-domain proposal. Once that
proposal is ruled, a later run against the same target opens a fresh, separately numbered proposal
(`bind-adapter-<t>-2`, and so on) rather than colliding with the first.

## Failure modes

Follows the same shapes every gated stage's failures do (`docs/stages/run.md`): a failing
pre-check commits `run(bind-adapter): pre-checks failed` with nothing else touched; a failing
post-check commits `stage(bind-adapter): post-checks failed` with a journal entry and the run
record, leaving whatever the agent wrote untracked for inspection; an open proposal from a
previous run is refused before a workspace is even materialised.

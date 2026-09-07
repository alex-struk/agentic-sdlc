# 0006 — The contract stage, G3 for tests and adapters, an MCP browser, and the oracle's override

**Status:** accepted · 2026-09-07

Five decisions taken while building the phase where a ratified spec becomes an executable
acceptance suite and the old application becomes the thing that suite is measured against. Each
one is recorded with what would reverse it, because each is a boundary that could reasonably have
been drawn one position further left or right.

## 1 — `contract` is a stage of its own, not part of `archaeology` or `ratify`

**Decision.** The stage list gains `contract`, an agent stage holding gate G1 and sitting between
`ratify` and `derive-tests`. Its workspace is `with-sources` when the project configures
`sources.old` — the old application checked out read-only for it to read — and `project` otherwise,
for a greenfield project whose contract is authored rather than recovered. It completes `spec/contract/` — `surface.yaml`
(the pages, actions and observations a test may name), `personas.yaml`, `observables.yaml`,
`openapi.yaml` — writes synthetic seed SQL with a manifest of named handles under `tests/seed/`,
and writes the compose override the oracle needs.

**Why it is not part of `archaeology`.** Archaeology answers "what does this domain do", one domain
at a time, and its output is ruled one domain at a time. The contract is a single artifact spanning
every domain: one page inventory, one persona list, one seed database. Folding it into archaeology
would mean either every domain's run rewriting the same shared files — a merge conflict between two
concurrent archaeology runs, and a G1 ruling on the `fees` domain that silently also rules on pages
belonging to `applications` — or an arbitrary rule about which domain owns the shared files. The
domain file is the unit archaeology writes and a reviewer rules
(`docs/decisions/0005-criteria-in-domain-files.md`); the contract is not that unit and does not fit
inside it.

**Why it is not part of `ratify`.** `ratify` is deterministic: it mints permanent ids from a ruling
and regenerates the index, and it takes no agent turn at all. Recovering an OpenAPI document and a
page inventory from an old application is exactly the kind of evidence-gathering that needs one —
and needs the `with-sources` workspace, which `ratify` deliberately does not get. A stage that
sometimes runs an agent and sometimes does not is a stage whose re-run behaviour, budget and
blindness guarantee all have to be stated twice.

**Why it comes after ratification rather than before.** The surface is only worth recovering for
behaviour that survived a G1 ruling. Recovering pages for criteria a reviewer then rejects spends a
session on a page inventory nothing will test, and the contract would have to be revised against the
ruling afterwards anyway.

**What would reverse it.** A project whose surface is genuinely per-domain — separate applications
under one repository, no shared pages, no shared seed — removes the reason the contract cannot live
inside archaeology's unit. So does a future where the surface is not recovered at all but declared
up front by a person, at which point there is no agent turn to justify a stage.

## 2 — Test and adapter proposals are ruled at G3 by the reviewer persona

**Decision.** `derive-tests` and `bind-adapter` both hold gate G3, and G3's holder is
`agent:reviewer`. The persona reads its brief (`.sdlc/personas/reviewer.md`), the proposal page, the
diff and the check results, and answers with a verdict, a rationale and any conditions — the same
mechanism every other agent-held gate uses, escalating to a named human on HIGH or CRITICAL tier or
when the brief says to always escalate on that gate.

**Why G3 and not G1.** G1 is the gate on what is *true about the product*: a criterion, a
statement of behaviour, a correction to the spec. It is held by the product owner because getting it
wrong changes what the rebuild is required to do. A test file and an adapter are neither — they are
the *implementation of a criterion that has already been ruled true*. The question a reviewer asks
of a derived test ("does this spec file actually exercise `R-1.4` as written, and does it stay
blind") is a code-review question with a right answer visible in the diff, not a product judgement.
Routing it to G1 would put the product owner in front of TypeScript, and would make the gate that
guards the spec's meaning also the busiest gate in the pipeline.

**Why an agent persona and not a named human.** The design says the derive-tests change merges with
a named human approval. This pipeline runs every gate under one simulation policy: the persona
rules, its rationale is recorded in `.sdlc/gates/<name>.yaml` and rendered on the state site, and a
tech lead samples the rulings rather than sitting in the loop for each one. Making G3 the single
exception would not add review capacity; it would add a queue in front of the highest-volume gate in
the pipeline, one proposal per domain per derivation run, and the tier escalation already routes the
cases where a human's judgement is actually required.

**What would reverse it.** Sampling that finds the persona approving tests a reviewer would have
returned — the measurement, not the intuition — moves G3 to a named human, or raises the default
tier on `derive-tests` proposals so escalation becomes the normal path rather than the exception.
The mechanism for both already exists; only the policy in `.sdlc/config.yaml` changes.

## 3 — `bind-adapter`'s browser is the Playwright MCP server, pinned by version

**Decision.** The `bind-adapter` session reaches the running target through the Playwright MCP
server, declared by the stage's `mcp` hook as
`npx -y @playwright/mcp@0.0.80 --headless --isolated` and written to a scratch `mcp.json` the runner
passes as `--mcp-config`. The stage's `allowedTools` list is `Read`, `Write`, `Edit`, `Glob`, `Grep`
and the server's own tools — notably **not** `Bash`.

**Why a browser at all.** An adapter binds an abstract action ("submit the application") to whatever
the running application actually renders. That binding cannot be derived from the spec, and the one
place it is legible is the running page. The alternative — reading the old application's templates
and copying its selectors — is exactly what the blindness rule forbids, because a selector copied
from source encodes the old implementation into the suite that is supposed to outlive it.

**Why MCP rather than a Playwright script the agent writes and runs.** A script needs `Bash`, and
`Bash` in this session would reach the whole workspace and the network. The blindness guarantee for
`bind-adapter` is meant to be structural, not a promise: the `blind-adapter` workspace contains no
`app/` and no `sources/`, and the tool list contains no way to fetch either. An MCP browser is the
narrowest tool that can see a rendered page and cannot see anything else. It also means the session
cannot silently execute the suite it is writing, which would turn a blind derivation into an
iterate-until-green loop.

**Why pinned by version.** The MCP server's tool names and their arguments are part of the stage's
prompt contract: the skill text tells the agent which tools exist. `@latest` would let an upstream
release rename a tool between two runs of the same stage and change what the stage does with no
commit in either repository — the same reproducibility argument that pins every skill pack to a
commit (`docs/dependencies.md`).

**What would reverse it.** A first-party browser tool in the executor itself, subject to the same
allow-list, removes the need for an external server. So does an upstream that stops publishing
stable pinned versions, which would make the pin worthless and force a vendored equivalent instead.

## 4 — The oracle's compose override is project content, written by `contract` and ruled at G1

**Decision.** The old application is brought up by `docker compose` with two files: the old
application's own compose file, unmodified, and an override the *project* owns —
`.sdlc/oracle/compose.yml` by default, `oracle.compose_override` when configured. The override is
written by the `contract` stage, lands in that stage's G1 proposal, and is reviewed like any other
spec content. The ports in it are not literals: the override publishes `${SDLC_APP_PORT}`,
`${SDLC_DB_PORT}` and `${SDLC_MAIL_API_PORT}`, and `sdlc oracle up` chooses free values for them on
the machine it is running on and injects them as environment variables.

**Why the override is project content and not something the pipeline generates.** What has to be
overridden is specific to one old application: which service runs the app, which environment
variables point its mailer at a catcher, whether it needs a non-production sign-in route enabled to
be reachable without a real identity provider. A generator in the pipeline would have to encode one
particular application's shape, which is the thing this repository is not allowed to do — the
fixture project exists precisely to catch a pipeline that only works for one product
(`docs/architecture.md`). Written by an agent that has just read the old application, and reviewed
at G1 alongside the rest of the contract, it is evidence about that application rather than a
pipeline assumption about all of them.

**Why it is reviewed at G1 rather than merged silently.** The override decides what the oracle *is*.
A wrong service name makes the suite measure nothing; a mail catcher wired to the wrong place makes
every mail-related criterion fail for a reason that has nothing to do with the old application's
behaviour. Every calibration result downstream inherits whatever this file says, so it belongs in
front of the same reviewer as the criteria those results are scored against.

**Why the ports are injected rather than written into the file.** A port is a fact about the machine
the oracle is running on this afternoon, not about the project. Committing `5432` means the oracle
refuses to start for anyone already running Postgres, and means two checkouts of the same project
cannot run at once. `sdlc oracle up` probes for free ports (app from the configured base URL then
3100 up, database from 5500, mail API from 8025) and records what it chose in
`.sdlc/oracle-<target>.local.yaml`, which is untracked for the same reason: nothing machine-local is
committed.

**What would reverse it.** An old application that already publishes no fixed ports and already
talks to a configurable mail host needs no override at all, and the file becomes empty rather than
reviewed. In the other direction, a fleet of projects wrapping the same family of applications would
justify a pipeline-side override *template* the stage fills in — still project content once written,
still ruled at G1, but no longer authored from scratch each time.

## 5 — A returned closing-loop follow-up goes back through `archaeology --revise`

**Decision.** A G1 ruling on a ratification follow-up can end in `return` rather than a condition in
the ratification grammar. When it does, the return is recorded on `main` — the gate file and the
proposal page are committed there and the spent proposal branch is deleted — and the domain is
re-recovered by `sdlc run archaeology --domain <d> --revise`, which reads that ruling's rationale
verbatim into its prompt and revises the domain file from the evidence in `sources/old`.

**Why the ratification grammar cannot handle it.** That grammar's verbs act on a criterion's
*record*: accept it, edit its statement, mark it obsolete, split it. Every one of them assumes the
evidence underneath is sound and only the wording or the disposition is at issue. A reviewer who
says "this criterion cites the wrong migration, and what it claims the old application does is not
what it does" is not asking for an edit — there is no correct statement to write until somebody
looks at the old application again. Encoding "go and look again" as a ratification verb would put a
condition in the grammar that `ratify` cannot itself carry out.

**Why the return is recorded on `main` rather than left on its branch.** A return merges nothing, so
without an explicit record the only trace of it is a branch that a later run would either trip over
or silently reuse. Committing the gate file onto `main` makes the return count as a ruling for
follow-up numbering (the next follow-up is `-<n+1>`, not a reuse of the returned one), puts it in
the gate log and on the state site, and frees the proposal name for the fresh `archaeology-<d>`
proposal the revision opens. The rule this serves is that a decision nobody can see is
indistinguishable from a decision nobody made.

**Why the revision is narrower than a first recovery.** `--revise` may change only
`spec/domains/<d>.md`, and only the criteria the rationale names: `archaeology-revise-scope` refuses
any other path — including `spec/contract/`, which an ordinary recovery may write — and
`archaeology-revise-keeps-minted` refuses any change to a criterion that already carries a permanent
`R-` id. A return names one criterion's evidence as wrong; it is not a reason to reopen the
permanent record of every criterion that was already accepted.

**What would reverse it.** A ratification grammar that could express a bounded re-investigation —
a verb carrying a question back to a stage and holding the follow-up open until it is answered —
would remove the need to leave and re-enter through a different stage. That is a larger change than
a verb: it means a proposal that can wait on a run, which nothing in the gate model does today.

# Agentic SDLC pipeline — companion walkthrough

A reading guide to `pipeline-poster.svg`. Each section says what that panel
shows, why it is there, and what is softer than it looks. The full design is
`docs/specs/2026-09-05-marketplace-rebuild-pipeline-design.md`; section numbers
here match the poster, not the spec.

**Context.** One visual giving easy insight into what is being built and how
it works, covering every aspect of the draft spec. The
poster is a reference to return to; this document carries the caveats.

**A note on colour.** Green means deterministic, it blocks or enforces. Gold
means human judgement, a gate. Navy means agent work, a proposal. Red means
forbidden or never automated. The same meaning holds in every section.

---

## §01 — What is being built, and why this project

**What the panel shows.** Four cards: the pipeline as product, the marketplace
rebuild as evidence, why a rebuild beats pure greenfield, and what is
deliberately not built. A navy band states the claim the run exists to test.

**The argument.** Two goals are combined on purpose. Building the pipeline on a
toy would prove nothing; rebuilding the marketplace without a pipeline would
produce one more app. The rebuild gives the pipeline a real oracle, so accuracy
is measurable, and the pipeline gives the rebuild a repeatable method, so it
can be done again when the pipeline improves.

*Softer than it looks.* The rebuild inherits legacy scope. Some of what the old
application does is accidental, and the ratify gate exists to catch that, but a
rebuild will never look like a from-scratch design. That is acceptable for an
experiment whose subject is the pipeline.

---

## §02 — The one idea, and six rules that follow from it

**What the panel shows.** The five coverage states as a chain, five principle
cards, and a red band for the sixth principle, egress.

**The argument.** The criterion is the atom. It is minted at ratification,
never reused, and versioned on any wording change. Every other artifact hangs
off it, which is what lets the state site be generated from git rather than
maintained by hand. The principles are the originating prototype's three rules plus the
front door, derivability and egress.

*What changed on 2026-09-05.* The spec previously said both repositories would
be pushed to bcgov at the end of phase 0. It now says nothing is pushed
anywhere without explicit permission at that moment, and the runner works
locally until a step genuinely needs a remote.

---

## §03 — Two repositories, installed by reference, configured not forked

**What the panel shows.** The two repo layouts, the runner commands, and the
four parts of the configuration file.

**The argument.** The tier2-v3 pack in bcgov/bcparks-ar-admin-agentic copies eighty files into each repo. Referencing
by version is what makes upgrades a one-line change and lets another team adopt
without forking. `bcgov/quickstart-openshift` already does this for its deploy
workflows, so the pattern is proven in the org.

*Caveat.* Install-by-reference needs the pipeline repo reachable from wherever
CI runs. Locally that is a path; on GitHub it is a public repo. Until a push is
authorised, CI-side stages run locally through the same scripts.

---

## §04 — The artifacts

**What the panel shows.** Eight cards, one per artifact, with the fields that
matter.

**The argument.** Intent is why, spec is what, plan is how. The contract is the
piece most pipelines leave implicit: the personas, routes, labels, test IDs,
API description and observables that tests need in order to act. Writing it
down as spec content is what lets blind tests and a blind implementation meet.

*On the confidence field.* It unifies a confirmed, inferred and open ledger from an internal
requirements-engineering practice, spec-kit's NEEDS CLARIFICATION marker and Crow's reconciliation class.
The rule that nothing ratifies while inferred or open is what stops an agent's
guess becoming contract.

*On Gherkin.* Given/When/Then is used as a writing format because it forces
observable behaviour. Cucumber, the runner that executes Gherkin, is not used,
since it adds a glue layer that breaks often and proves nothing extra.

---

## §05 — Fifteen stages

**What the panel shows.** Three chains of five stages in run order, with gate
stages highlighted, and a band on profiles.

**The argument.** A stage is a contract, not a prompt: inputs, outputs, the
workspace the agent may see, the checks that block, and an exit condition. The
runner does the same six things for every stage, which is what makes a stage
swappable between a local Claude Code session and a cloud agent later.

*What to watch.* Archaeology is the one deliberate channel from old code into
the spec. Its exclusion list matters more than its inclusion list: the old
application's own tests never reach it, because they encode current behaviour,
bugs included.

---

## §06 — Gates and policy

**What the panel shows.** The five substantive gates as cards with their
holders, then three cards on agent-held gates, tiers and the short circuit,
and the cost of unverified provenance.

**The argument.** A gate is a proposal with a one-page digest, so judging it is
reading a page rather than a diff. Gate holders are roles bound in config to a
person or a persona agent. During pipeline testing G0, G2 and G3 begin
agent-held with escalation and a weekly human sample, so a full run does not
wait on a human at every step. Ratify and design stay human because those
rulings are the experiment's evidence.

*Softer than it looks.* An agent-held gate is a rubber stamp unless three
things hold: the persona brief names what it must refuse, escalation is
mandatory on tier and confidence, and a human samples the decisions. All three
are in the spec, and all three are cheap to skip in practice. The sample size
on the state site is the tell.

---

## §07 — Blind tests, adapters and the old application as oracle

**What the panel shows.** Two numbered flows: deriving and calibrating tests on
the left, binding adapters and enforcing separation on the right. A band on
why the oracle step exists.

**The argument.** An internal planted-defect experiment showed agents write
tests that bless bugs when they can see the code. The boundary that matters is what
the test-writing session can see, not how many repos exist. The blind
workspace holds the spec bundle only. Tests call an abstract surface; an
adapter per target binds it to real locators, and a lint rule keeps every
assertion out of adapters and every selector out of tests. The old adapter is
written by walking the running application, never its source.

*On the old application's sign-in.* Its automated tests do not log in through
Keycloak. They visit a development-only address that creates a session for a
named role. Calibration's old adapter uses that. The new application does not
copy it: tests sign in through a sandbox identity provider seeded with test
users, and the application code stays production-shaped.

*Softer than it looks.* The first calibration run will produce many misses that
are adapter or contract fixes rather than defects. That is expected and cheap.
Behaviours with no observable surface in the old application, such as email to
a real mail server, are verified at the API or ruled on evidence.

---

## §08 — The verification loop and internals

**What the panel shows.** The five failure classes with their routes and
bounds, then four cards on staleness, done, resume and concurrency, and
secrets.

**The argument.** This is the section a spec usually leaves out, and where a
pipeline silently does the wrong thing. Each failure is classified once, with
evidence, and routed by the runner, not by the agent that produced it. Bounds
stop loops. Versions stop stale tests counting as green. A misclassification
that bounces more than twice is escalated with its history.

*Judgement call.* The retry bounds (three for implementation defects, two for
test and adapter defects) are starting values, not findings. The run record
will show whether they are right.

---

## §09 — Stack, dependencies, metrics and the run by phase

**What the panel shows.** The stack profile, what is taken from where and what
is not, the metrics, the six phases as two flows, open questions, how the
pipeline tests itself, and the first-pass slice order.

**The argument.** One opinionated stack, chosen because the org maintains it,
it runs on the platform the marketplace uses today, and it already references
central workflows by version. Every external piece is pinned and registered
with a reason, and a weekly job diffs upstream. The metrics are chosen to
isolate agent quality from reviewer availability, which is why time-to-close
is deliberately not a headline.

*On the rejected pieces.* caveman is rejected because it compresses the prose
the gates need readable. ponytail is optional and off by default because its
own benchmark notes reasoning models can go the other way. The tier2-v3 pack's source and its two MCP servers are not public; the ideas
and scripts are ported from the installed copy, which is not blocking.

---

## Open questions worth tracking

1. Test identity on the new target (decided at G2).
2. Observing email on the old application during calibration.
3. What sample size agent-held gates need; five per week is only the default.
4. Whether page stories in Storybook drift from real data shapes; the stories
   use the same seed fixtures the tests use to limit this.
5. When a remote is first needed, and permission to push at that point.

---

*Draft for review, 2026-09-05. Describes the design as specified, not as
built. Nothing has been pushed to any remote.*

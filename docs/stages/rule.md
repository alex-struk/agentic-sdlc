# Stage: `rule`

## Purpose

Record a verdict — `approve` or `return` — on an open proposal, checked against who is allowed to
hold that gate, and merge the proposal into `main` on approval. A gate whose `holder` in
`.sdlc/config.yaml` is `agent:<persona>` can also be ruled by that persona directly: a short
agent turn reads the proposal, the diff and the checks, and answers with a verdict the same way a
human's `--by` is trusted — phase 0 has no authentication either way (see
`docs/decisions/0003-caller-workflow-and-unauthenticated-roles.md`).

## Inputs

Human: `sdlc rule <name> approve|return --by <role> [--note "..."]`, run from inside the
project's working tree.

Agent: `sdlc rule <name> --by agent:<persona>` — no verdict is typed; the persona decides it.
`sdlc rule --pending` rules every open proposal (a `proposal/*` branch with no gate file yet)
whose gate is held by an agent, oldest branch first, and prints one line per ruling.

Typing a verdict together with `--by agent:<persona>` throws `an agent holder rules through its
own turn; omit the verdict, or rule as a human role` rather than running the agent's turn with the
typed verdict silently discarded: `sdlc rule <name> approve --by agent:<persona>` is rejected, not
dispatched.

## Outputs

On the proposal branch:

- `.sdlc/gates/<name>.yaml`: `gate`, `verdict`, `by`, `held_by` (`agent` or `human`, derived from
  whether `by` starts with `agent:`), `note`, `at`. An agent-held ruling replaces `note` with the
  persona's `rationale` and `conditions`, and adds `cost`, `turns` and `session` — what that
  ruling turn itself cost, the same three numbers a stage's journal entry records, which
  `site/index.md` totals as `Rulings cost`. A mandatory escalation records zeros, since it never
  asks the persona anything; a human ruling has no turn and carries none of the three.
- An appended `.sdlc/runs/<date>.md` entry.
- One commit, staging those two paths by name and nothing else.

On `verdict: approve` only: the working tree is checked out onto `main` and the proposal branch is
merged in with `--no-ff`, so `main` gains the gate file, the run-record entry, and a merge commit.
Two proposals opened on the same day both append to the same `.sdlc/runs/<date>.md`, which
`.gitattributes` marks `merge=union` so both sets of lines survive. If the merge fails anyway it
is aborted, the working tree is returned to the proposal branch, and the error names the
conflicted files — `main` is never left mid-merge.
On `return`, the proposal branch is left exactly as it is — not merged — so it stays open for
another round.

`buildSite` runs after every ruling, human or agent, so the state site's gate log and coverage
numbers are never more than one ruling stale. The site is a tracked artifact: every
page it generates —

- `site/index.md` (coverage, the page list, and the cost, ruling, escalation and open-proposal
  totals),
- `site/gates.md` (the gate log, this ruling now its newest row),
- `site/runs.md` (the run log),
- `site/journal.md` (the stage journal), and
- `site/proposals/<name>.md`, one page per proposal, ruled or open, including this one

— lives on `main` and nowhere else. Every page is regenerated whole from the whole project, so a
copy carried on a proposal branch would differ from every other open proposal's on every page, and
the second merge would conflict on all of them for content neither proposal is about. A stage that
holds a gate therefore builds no site at all (`docs/stages/run.md`), and regenerating it is this
command's job:

- **Approve** — the branch is merged into `main` first, then the site is rebuilt there and folded
  into that merge commit with `--amend`, rather than trailing behind it as a second commit or an
  uncommitted diff. What it reflects is `main`'s complete gate history, this ruling included.
- **Return or escalate** — the ruling commit stays on the proposal branch, where it belongs, since
  nothing about it has been accepted. The site is still regenerated on `main` — checked out for
  that and checked back out afterwards, so a returned proposal is still the working tree a person
  lands in — and committed as `chore(site): regenerate after <name> <verdict>` only if `main`
  actually changed. Usually it has not, and nothing is committed.

A project whose `.gitignore` still hides `site/` has that line reconciled away first
(`docs/stages/init.md`), so the pages are committed rather than silently regenerated and dropped.

## The agent path

When `--by agent:<persona>` names the gate's own `holder`, `sdlc rule` builds a prompt out of:

- the persona brief, `.sdlc/personas/<persona>.md`;
- the proposal page;
- the tier — the proposal's own `tier:` front matter if it set one, else
  `policy.default_tier`;
- `git diff main...proposal/<name> --stat`;
- for a `build-slice-*` proposal, the verify result for that slice, quoted before the diff and
  outside its budget (see **The verify evidence a build ruling is shown** below);
- the diff of the proposal's own output, capped at 60,000 characters — 120,000 at G3 — so a
  large or generated diff cannot blow the prompt budget. Path groups left out of it entirely:
  `app/` on a proposal whose branch does not touch the application (the spec-side personas rule
  on the spec, not an implementation); `site/`, `.sdlc/runs/` and `.sdlc/journal/`, which are
  derived from the very work being ruled on, change on every run, and between them can be
  larger than everything the persona actually needs to read; `.sdlc/proposals/`, quoted in full
  higher up already; the verify result quoted in its own section; and whatever the project's
  stack profile declares as `bulk:` in its front matter — the files its toolchain writes and
  the project commits, such as a resolved dependency tree or a generated API client, one of
  which can be larger than the whole budget on its own. Files left out on the stack's account
  are named in the prompt, since they are on the branch and a ruler may want one.

  What remains is ordered so the evidence the ruling turns on comes first — for G1,
  `spec/domains/` then the rest of `spec/`; for G0, `intent/`; for G3, the verify results, the
  acceptance suite and the adapters, then `app/`, then `evidence/`. The cap is applied to that
  order, so what falls off the end is the least important file rather than whichever one sorts
  last, and no single file takes more than a quarter of the budget while other files are still
  waiting (the last file in the order is exempt, since by then nothing is waiting). Every cut
  says what was cut: a file shown in part ends with `[truncated: <path> — <n> of <m> characters
  of this file's diff are not shown...]`, and a diff that ran out of budget ends with `[<n>
  changed file(s) not shown, in the order they were dropped: <paths>...]`;
- the structural checks, run on the proposal branch's current checkout;
- for G3 test and adapter proposals, a runner-owned TypeScript check tied to that checkout's
  commit. The runner invokes the already-installed harness compiler directly, with no emit,
  incremental output disabled and no shell or package lifecycle hooks. It supports the harness's
  `tsc --noEmit` script; missing dependencies, missing configuration or a different script are
  reported as unavailable, never as passed. It installs nothing. Diagnostics and the exit status
  are supplied to the persona and recorded in the proposal page with its approve/return ruling.

The blind test author has neither a shell nor installed dependencies in its scratch workspace.
Dependencies visible to the reviewer in the project checkout do not prove that the author could
run a typecheck. The runner owns compiler execution; the author can correct compiler errors
reported in a return without receiving wider permissions.

The agent turn runs with a tool list of `Read`, `Grep`, `Glob`, `Bash(git diff*)`, `Bash(git
log*)` and `Bash(git status*)` — enough to look further into the branch than the diff in the
prompt, and nothing that writes. It runs with `maxTurns: 12` at every gate but G1; at G1 it gets
the stage default (40 turns) instead, since a G1 ruling has to read a whole domain file and rule
on every criterion in it rather than just a proposal and a diff. Either ceiling is overridden by
`policy.turns.rule`, read the same way a stage's own turn ceiling is (`rulingTurns`,
`src/commands/rule.mjs`). `SDLC_STAGE=rule` also blocks every path in the
implement guard (`docs/stages/init.md`), so a ruling that tries to edit is stopped twice before
the clean-tree check below ever sees it. It must end its reply with one fenced JSON block and
nothing after it:

```json
{"verdict": "approve"|"return"|"escalate", "rationale": "...", "conditions": [...]}
```

Only the *last* such block in the reply is read, so anything the agent explored earlier in the
turn cannot be mistaken for its answer. A reply with no fenced JSON block throws `no verdict block
in persona reply`; a block that isn't valid JSON throws `bad verdict block: <parse error>`; a
`verdict` outside the three named values throws `bad verdict: <value>`; a verdict with no
non-empty `rationale` throws `verdict has no rationale`.

A turn that comes back reporting failure (an error result, the turn ceiling) has no verdict to
read. A ruling turn is read-only and cheap, and a failure is often transient, so it is retried
once automatically before anything is rejected. Only a second failure is rejected, with `ruling
agent turn failed after one retry: <the turn's own text>`: `parseVerdict`'s `no verdict block in
persona reply` would otherwise be the error a person sees for what is actually a failed session.
Nothing has been written at that point — no gate file, no commit — so the proposal branch and the
working tree are exactly as they were.

Right after the agent turn returns and before its verdict is even parsed, the working tree is
checked for edits the turn left behind (`assertCleanTree`): a ruling is a read-only turn, and a
persona that edited files is rejected with `rule: the ruling agent modified the working tree`
rather than having its verdict trusted. The edit is left in place, not discarded, so it stays
visible in `git status` for a person to look at.

An `approve` or `return` verdict reuses the same gate-file-and-commit path a human ruling takes,
with `by: agent:<persona>` (so `held_by: agent`) and the persona's `rationale` and `conditions`
written into the gate file in place of a human's free-text `note`. The rationale and verdict are
also appended to the proposal page itself, under a `## Ruling` heading, *before* that page is
committed — so the ruling is part of the same commit the gate file is, not a follow-up.

### The verify evidence a build ruling is shown

A build proposal is ruled on what the acceptance suite established about the application on its
branch: `verify` writes that to `tests/results/new/slice-<n>.json`, and `buildVerified` reads the
same file to decide whether an approval may be given at all (`docs/decisions/0022`). The ruler is
shown it in a section of its own, before the diff and outside the diff's budget:

- the verdict — `pass`, `fail` or `unbound` — with what each one means for the ruling;
- which proposal and which application tree the result was recorded for, and, where the branch
  has moved on since, that it is evidence about code that is no longer there;
- the number of criteria the slice claims, how many passed, and how many did not;
- a line per criterion that did not pass, carrying the first error its tests recorded — which is
  where an `unbound` criterion's adapter reason, the only account in the pipeline of what the
  application did not provide, is written down;
- the passing criteria by id.

It is bounded by construction: each reason is cut at 500 characters, the first twenty
non-passing criteria carry their reasons and the rest are listed by id, and the passing ids are
named up to forty and counted past that. A suite of hundreds of criteria cannot spend the budget
the diff needs. A build proposal with no result on its branch is told so in the same place,
rather than being left to infer it from a diff that does not mention it.

### Ratification conditions

`conditions` is free-form for most personas, but `product-owner`'s own brief
(`.sdlc/personas/product-owner.md`) gives it a closed vocabulary at G1 — one line per criterion ID,
using `contract`, `confirm`, `edit`, `defect`, `spike`, `recovery-wrong`, `obsolete` or `drop` — that
`sdlc run ratify` (`docs/stages/ratify.md`) reads back out of this same gate file and applies
mechanically.

Two of those are easy to read as each other's synonym and are not. `contract <ID>` changes nothing:
the row's confidence, state and wording are untouched, and it is recorded only so the journal can
say the ID was looked at. It does not promote anything — a criterion still `inferred` or `open`
stays that way and is not minted a permanent id. `confirm`, `edit` and `defect` all resolve a
criterion; `contract` and `spike` do not. `confirm <ID>` raises confidence on the strength of the
evidence alone, and the persona is required to say in its rationale what tipped it; `edit <ID>:
<text>` and `defect <ID>: <text>` raise it too, each for its own reason — an edited statement is
itself a second witness, and a defect row is a confirmed record of what the old system does, merely
marked as a defect rather than carried forward as-is. A criterion nobody mentions at
all is treated exactly as `contract`, so approving a proposal without a line per ID is normal.

`recovery-wrong <ID>: <text>` is the one verb whose work another stage carries out. It says the row
is not a record of the old application at all, which is a statement about the *evidence* rather than
about the wording or the disposition, so `ratify` files the criterion and the ruler's text to
`spec/recovery.yaml` for the next `archaeology` run on that domain to recover again, drops the row to
`open` so it cannot mint in the meantime, and ratifies the rest of the domain around it
(`docs/decisions/0015-one-criterion-goes-back.md`).

An archaeology proposal legitimately carries criteria marked `inferred` or `open` — that is
archaeology reporting what the evidence supports, and approving such a proposal is the ordinary
outcome. Those criteria are not the contract yet, and `ratify`'s closing loop
(`docs/stages/ratify.md`) is what asks about them again.

Because a condition is an instruction `ratify` will execute rather than commentary, a line the
grammar cannot read is a silently dropped ruling on a criterion. At G1, on an `approve` or a
`return`, every condition is parsed with that grammar before the ruling is written. If any line
fails, the persona is asked once more — the same prompt with its own unreadable lines quoted back
and the grammar restated — which is the whole fix in the ordinary case, since these are formatting
slips (`confirm <ID>: <text>`, where `confirm` takes no text) rather than disagreements. Whatever is
still unreadable after that is written to the gate file under `unparsed_conditions` and the ruling
proceeds: the verdict was reached and the reasoning is worth keeping. `ratify` then refuses to act
on that gate file at all until a person rewrites the lines in place.

What is still *not* checked here is whether a condition's ID exists in the domain: this command has
no domain file in hand. `ratify` reports an unknown ID later, against the file it actually has.

### Calibration conditions

Not every G1 proposal asks the ratification question. A proposal whose name begins `calibrate-` asks
a different one — which of the application, the criterion or the test is wrong, for a criterion the
acceptance suite failed against a running target (`docs/stages/calibrate.md`) — and its conditions
are read in the calibration grammar instead: `defect-in-old <ID>`, `spec-wrong <ID>: <corrected
statement>`, `test-wrong <ID>: <why>`, described in the product owner's own brief under "Calibration
rulings". The proposal's name is what selects the grammar, because a condition read in the wrong one
is not a parse error, it is a ruling that would be dropped in silence: `confirm R-1.1` is a perfectly
well-formed ratification condition and means nothing at all on a calibration proposal.

Everything else about the mechanism is the same. The lines are parsed before the ruling is written,
an unreadable line gets the persona one re-prompt with the calibration grammar restated, and
whatever is still unreadable lands on the gate file under `unparsed_conditions` — where `calibrate`
reports it as a dead condition on its next run rather than applying it.

At G1 a `return` also carries no conditions in practice: its rationale paragraph says what
archaeology has to go back and change instead.

At G3 a `return` is read the other way around: its conditions are not run through a grammar at
all — they are read back as plain free-text lines, one per thing that has to change, alongside the
rationale. `sdlc run derive-tests --domain <d> --revise` is what acts on them: it quotes both
verbatim to the agent and asks it to change only what the conditions name
(`docs/stages/derive-tests.md`, "Revising after a return"), and `sdlc run build --slice <n> --revise`
reads a returned build proposal's the same way.

A person rules with the same list. `rule <name> return --by <role> --condition "..." --condition
"..."` writes a `conditions` array into the gate file exactly as an agent's ruling does, alongside
the free-text `note`; the flag repeated is one condition per occurrence, so a condition's own text
never has to avoid a separator. A ruling that attaches none carries no `conditions` key at all.

### A test that reaches past its criterion

One condition line is read as an instruction on a `return`, at any gate whose conditions are free
text — which is every one but the three with a closed vocabulary of their own (ratification and
calibration at G1, and the triage page above):

```
test-overreaches <ID>: <what the test demands that the criterion does not ask for>
```

It says the criterion stands and the acceptance test derived from it asks for more — a capability, a
screen or a step the criterion never names. That is the third thing `verify`'s `unbound` verdict can
mean (`docs/stages/verify.md`), and the one the other two exits cannot express: the adapter has
nothing to bind the extra demand to, so it truthfully reports the application as lacking a surface
the application was never answerable for.

The ruling files the criterion and the ruler's own words onto `tests/acceptance/redo.yaml`, on
`main`, in a commit of its own — the request is the pipeline's bookkeeping rather than part of the
proposal, and a copy of it on a branch nobody merges would never reach the stage it is addressed to.
`sdlc run derive-tests --domain <d> --stale` then writes that one test again and is given the reason
as an instruction about what the replacement must not do.

Two things it is not. It is not a verdict on the criterion: nothing about the row, the index or the
suite is touched, and the criterion stays unverified until a regenerated test binds and passes — so
an `approve` carrying this line is refused rather than becoming a way to sign off a criterion
nothing can exercise. On the agent seat the ruler is asked once which of the two it means before
that refusal stands (below). And it is not a line that can be filed empty: a form with no reason,
or one whose reason is only whitespace, refuses the ruling before anything is written, because the
reason is the whole of what the request carries and a request without one produces the same test
again.

Inside a closed grammar the line is left to that grammar: it is recorded verbatim under
`unparsed_conditions` for a person to rewrite, exactly as any other foreign line there is, and
nothing is filed from it. Nothing is lost by that — at G1 no test has been derived yet, and the
calibration grammar's own `test-wrong <ID>: <why>` is the ruling to make there about a test that
asserts the wrong thing (`docs/decisions/0021-an-accurate-message-naming-the-wrong-culprit.md`).

### A condition whose work belongs to another stage

The same reading, at the same gates, for the general case:

```
addressed-to <stage>: <what that stage has to change, and what showed it>
```

The stage is one some run of which takes a request up (`addressableStages`, `registry.mjs`): a
stage with a revision mode takes it with `--revise`, `archaeology` with its `--revise` too, and
`contract`, whose every run completes the contract from `main`, with its ordinary run. The set is
read off the stages themselves rather than listed here. A line naming any other stage is refused
before anything is written, from either seat, with the stages that can be named; the agent seat is
asked once to rewrite it first, as for the other fixable defects. A request no run can take up would
be recorded on the ruling and filed nowhere
(`docs/decisions/0050-a-request-reaches-a-stage-that-takes-it-up.md`).

Two things follow from a ruling carrying one. The condition is left out of the list the stage being
returned is given, along with any `test-overreaches` line, so no stage is handed work it has no way
to do; that stage is told in its prompt how many conditions were addressed elsewhere, to which
stage, and in whose words, so its list is never silently shorter than the ruling on the branch. And
a request is appended to `.sdlc/revision-requests.yaml`, on `main`, in a commit of its own, for the
same reason the redo entry above lands there.

The terminal account of the ruling names each stage it asked and the run that takes the request
up (`requested of <stage>: filed on main; sdlc run <stage> [--revise] takes it up`).

That request is what makes an artifact its own gate has already approved revisable again. `sdlc run
<stage> --revise` with no returned ruling of its own (or `sdlc run contract`) is handed **every**
open request addressed to it — each one numbered, with the ruler's words verbatim and the proposal, gate and seat they came
from — and opens one fresh proposal at its own gate answering all of them. Requests filed by the
same ruling are kept together and the older ruling's come first.

The round is spent where the run delivers, not where it reads: every request the run answered is
marked `taken` in one write, in a commit of its own on `main`, after the proposal is opened, with
the proposal that answered it (`taken_by`). The proposal the ruling returned is not revised until
then, and until that proposal is approved (`docs/stages/next.md`, "Held"). A run
refused by a later check, or one that lost its agent turn, leaves every request open for the next
one. A request the run could not answer is named back in its journal entry on a line of its own —
`deferred-request <n>: <why it cannot be answered here>` — and stays open with that reason recorded
against it, so `sdlc checks` goes on reporting it. An entry is marked rather than removed either
way, so what was asked for and who asked survives the revision being merged
(`docs/decisions/0034-a-queue-read-as-though-it-held-one-thing.md`).

How many times one line of work may send a stage back this way is `policy.loops.request` (two by
default, `docs/config.md`), counted by ruling: the requests one ruling files together are one send.
A `--revise` run whose round includes a line of work past that limit still answers it, and the
proposal it opens is escalated by the runner to that stage's gate's escalation target instead of
being put to its holder (`docs/stages/run.md`, "Outputs").

Reopening is not accepting, and the guard is the same shape as the one above: an `approve` carrying
the form is refused, a form with no reason refuses the ruling before anything is written,
the filing commit touches the request file and nothing else, and the change itself is ruled by the
gate the addressed stage holds rather than by the ruler who asked for it
(`docs/decisions/0024-a-gate-that-only-moves-forward.md`).

### An instruction nobody has accounted for

A plain condition on a return is an instruction: the stage the proposal goes back to is meant to
carry it out, and its `--revise` run is handed the line verbatim. What nothing said, until this,
is whether it ever was. The revision is ruled on its own merits, the condition stops being
mentioned, and a gate file can go on asserting a change the project's own files contradict while
the record reads as complete.

Every plain condition a return carries is therefore appended to `.sdlc/conditions.yaml`, on
`main`, in a commit of its own, with a reference of the form `<proposal>#<n>` — the proposal it
was written on and its place in that ruling's own list. An `addressed-to` or `test-overreaches`
line is not: each has a ledger of its own that follows it from filing to consumption, and a
second row here would be a second thing to close for one instruction. An approval's conditions
are not either: no `--revise` run reads them, so there is nothing to be owed. Nor is a ruling in
a closed grammar, whose conditions a stage applies through a fixed vocabulary and whose own
records follow them.

A ruler accounts for one on any later ruling, with either of two lines:

```
condition-met <ref>: <what was done, and where it can be seen>
condition-withdrawn <ref>: <why it is no longer asked for>
```

Two verbs rather than one, because the two claims differ and the ledger exists to keep them
apart: the first says the work was done, the second says it should not be. Both are accepted on
an approval as readily as on a return — the revision that satisfies a condition is ordinarily
approved, and that approval is exactly where a ruler should be able to say so. A reference nobody
has open is refused before anything is written, with the open list in the message, and a line
with no reason is refused for the same reason every other verb's is; on the agent seat each gets
the same single re-prompt a fixable line always gets. An entry is never removed: what was asked
stays on file beside what was answered, by whom and why.

A condition nobody writes either line about stays open, which is what carrying it forward is. It
is read back by `sdlc checks` on every run — and so, since the ruling prompt carries the checks,
to whoever rules next — and it fails that check once the same line of work has had a proposal
approved past it (`docs/stages/checks.md`).

The stage that owes it is told the same way. A `--revise` run of any stage that starts from a
returned ruling is handed, beside that ruling's own conditions, every condition still open on
`main` for the same line of work, each by its reference, in its ruler's words, with who attached
it and on which ruling, and with the statement that the next ruler will be shown it as owed. It
is read through the same function the ruling prompt reads, so the stage and its ruler are shown
one list (`docs/decisions/0041-an-instruction-owed-by-a-stage-nobody-told.md`).

### A test a criterion is owed

A criterion `derive-tests` recorded as untestable is an owed item of kind `missing-test`
(`docs/operating-model.md` §7), named `missing-test/<id>`. A ruling touches these three ways.

**An approval writes them down.** Once the merge is on `main`, every untestable record it brought
there gets its item, stamped with this ruling (`from`, `gate`, `by`), and so does any record
already on `main` that nothing had written an entry for, stamped by the runner. An item whose
record the merge rewrote with a different owner moves to that owner; an item handed to
`derive-tests` whose approved derivation kept the record goes back to the record's owner, where
that derivation was handed it (in its domain, and owed when its branch was cut); an item
whose test now exists and has not run is handed to `calibrate` (a project that calibrates) or
`verify`. An item whose test the merge shows ran — a result row for the criterion, at its current
version, from a spec file, `pass` or `fail` — is closed as met with that row as the evidence. An
item whose criterion is superseded or obsolete is withdrawn, stamped by the runner: no test is
derived for it.

Then what the approved run was handed is settled. The run was handed what its stage owed on
`main` when it ran (in its domain, for a stage that runs per domain), which is what the commit the
proposal branch was cut from holds. Each `re-address` line in the run's account on the proposal
page — above the `## Ruling` section — that moves an item the stage still owes is applied, stamped
with this ruling (`by: <proposal>`, `gate`, `approved_by`): the hand-ons to `derive-tests` the run
held back, and any other its finish did not apply. An item the run was handed and did not hand on
is recorded as kept by its stage (`kept`, stamped the same way); it stays open, and `sdlc next`
lists it as waiting on a ruler rather than offering the stage again. A stage with no agent turn is
handed nothing, so its approvals settle nothing. All of it is staged into the merge commit, and
the terminal says which items were opened, moved, kept or closed.

**An approval whose settlement is not on `main`** is settled by

```
sdlc rule <name> --settle
```

which reads the ruling from the gate file on `main` and the handed list from the approval's
merge, brings the list into line with `main` the way every pipeline commit that touches it does,
and commits what it changed as the pipeline author: `record(<gate>): <name> settles <n> missing
tests: …`, each item named in the body. A move the approval's merge made to an item its run was
not handed is reversed first, where it still stands and nothing has kept the item since: the item
goes back to the approved stage with the reason it had there, stamped `by: runner` and
`reverts: <name>`, and the body lists it as restored. It is not a ruling and asks for no seat. A proposal with
no ruling is refused, and one with nothing left to settle commits nothing.

**A return whose request is not on `main`** is settled by the same command. It reads the ruling
from its gate file (on `main`, else on `proposal/<name>`, else on `returned/<name>`) and files each
`addressed-to` request it carries that is not already on file, open or taken, stamped with the
ruling's own seat, gate and time, in a commit of its own as the pipeline author:
`record(<gate>): <name> asks <stage> to revise`. A second settle files nothing.

**A ruler withdraws one** with the line a condition is withdrawn with, on any verdict and from
either seat:

```
condition-withdrawn missing-test/<id>: <why no test is owed>
```

It is closed as withdrawn, with the reason and the ruler, and holds for the criterion's version at
the time; a record at a later version is owed again. `condition-met` on a missing test is refused —
a missing test is closed by a test that runs, and by nothing a ruler writes — and so is a
reference to an item nothing has open, with the open list in the message. On the agent seat each
gets the one re-prompt a fixable line always gets.

**G3 does not pass over one.** While `policy.gates.G3.block_on_missing_tests` is true (the
default), approving a `build-slice-<n>` proposal is refused while an item open on `main` names a
criterion the slice claims (the plan's list for it and every row of its verify result), unless the
same ruling withdraws it, or the slice's verify result shows that criterion's test ran — the
approval then closes it. Either seat is refused in the same words and the refusal is recorded like
every other; on the agent seat the open items are quoted back for one more turn first. A standing
escalation does not lift it: whoever rules withdraws the item on the record, with the reason, or
does not approve. `false` lets G3 approve past open items, which stay open.

The ruler is shown them. A build slice's ruling prompt lists every open item naming a criterion
the slice claims, and whether the policy refuses an approval past them; the ruling prompt of any
other stage's proposal lists the items that stage owes. A person in the seat reads the same list,
with the withdrawal line, from `sdlc checks`.

### A condition asking for a path the stage cannot deliver

A stage's workspace is writable only where it is collected
(`docs/decisions/0027-a-run-that-fabricated-success.md`), so a plain condition naming any other
path is a ruling nobody can carry out. `sdlc rule` refuses the return before anything is written,
naming the path, what the stage being returned does deliver, and the `addressed-to` line to use
instead.

It is caught here because here is the only place it can be put right. By the time a `--revise` run
reads the condition the ruling is history and the stage reading it has no standing to re-address
it; the ruler is at the keyboard now, and the correction is one line. The same refusal is reached
from both seats: a person typing `--by <role>` is shown it, and a persona is told, before it rules,
which paths the stage this proposal goes back to can change and what to write when the work belongs
elsewhere.

A path is read out of a condition when it looks like one — it carries a separator or an extension —
and only when this pipeline has some say over it. "Rework the plan so the second slice stands
alone" names no file; `plan/tasks.md` does. A path no stage of this pipeline delivers is refused
too, and says so rather than naming a stage.

Only a return is checked. An approval's conditions are commentary no `--revise` run reads, and the
verdicts that may not carry a cross-stage request at all are refused by the two guards above.

### A defect a second turn can answer, and what a refusal leaves behind

Every refusal above fires after the ruling turn has answered, because the verdict is the thing
being refused. On the agent seat, a ruling is therefore given **one** more turn before any of them
stands — one per ruling, not one per guard. What the second turn is asked depends on what was
wrong:

- **A line to rewrite.** A condition verb used without its reason, a plain condition naming a path
  the returned-to stage cannot deliver, or an accounting line naming a condition nothing has open.
  The persona's own reply is quoted back with the offending line and what it should have written,
  and it is told to keep the rest of the ruling exactly as it was.
- **A verdict to choose.** An approval carrying a `test-overreaches` or `addressed-to` line, or an
  approval on a `build-slice-*` proposal with no current passing verify result. There is no line to
  rewrite here: the verdict and the record are two positions at once, so the ruler is asked which
  of them it means, with both ways out named. Neither is picked for it — both were already its own
  to take.

Whatever comes back, corrected or not, replaces the reply that triggered it and is what the
refusals are then run against, in the words they always used. A reply that switches to `escalate`
on the second turn is handled exactly as it would have been had it escalated on the first
(`docs/decisions/0028-a-guard-that-corrected-a-fault-by-destroying-the-work-that-held-it.md`,
`docs/decisions/0036-every-guard-in-the-ruling-path-and-what-a-refusal-costs.md`).

Three refusals get no second turn, because none of them has a ruling to save: a reply the verdict
protocol could not be read out of, a turn that failed after its own automatic retry, and a turn
that wrote to the working tree. The last leaves its edit in place rather than resetting it, so the
tampering stays visible where it was made.

The human seat gets no second turn either, and needs none: there is no turn to redo, the refusal
hands the whole ruling back, and the line that was fine can be given again beside the one that was
rewritten.

**A refused ruling writes no gate file — and is recorded anyway.** Two entries on `main`, in a
commit of their own: a run-record line naming the proposal, the gate, the seat and the guard's own
sentence, and a journal entry beside it holding the verdict, the rationale, every condition the
ruling produced, and what the turns cost. The cost lands in the state site's totals, so a turn
spent on a refusal is counted rather than missing. `main` rather than the branch, because a refused
proposal is still open and may be ruled again or abandoned, and a record on a branch nobody merges
is a record nobody reads. A turn nothing was read out of is recorded the same way, with the reply's
failure in place of a verdict. A human ruling is recorded at zero cost, since no turn was spent. A
refusal on a tampered working tree records nothing at all: switching to `main` to write it would
carry the tampering across.

## Mandatory escalation

Some proposals never reach the persona at all. Before asking, `sdlc rule` escalates on its own
when either is true:

- the proposal's tier is one `policy.escalate_tiers` names (`HIGH` and `CRITICAL` by default;
  the list always includes `CRITICAL`);
- the gate is named in the persona brief's `escalates` list (a persona can hold a gate and still
  always defer on it). The list lives in a YAML front-matter block at the top of the brief:

  ```markdown
  ---
  escalates: [G-POL]
  ---
  # Persona: tech-lead
  ```

  The brief's prose says *why*, for the agent that reads it; this list is what the runner acts on,
  and the front matter is stripped before the brief reaches the prompt. Nothing is inferred from
  the prose, so a sentence scoped to one kind of item — the installed tech-lead brief's "a
  platform-article change is escalated, never ruled here" — leaves the persona ruling every other
  proposal at that gate, which is what it says.

The brief is read from `main` rather than from the proposal's own branch. A ruling has that branch
checked out, and a branch opened weeks ago carries the briefs of the day it was opened; the brief
is the ruler's instruction sheet rather than part of the proposal, so a correction to a persona
applies to every proposal still open when it is made.

### An escalation that reaches nobody

An escalation is a hand-off, so a verdict that escalates to the role the escalating seat itself
holds — `by: agent:<role>` and `escalate_to: <role>` — hands the question to no seat the pipeline
can fill. Either path can produce one: a persona ruling an escalation raised by another persona and
escalating again, or a gate whose holder and escalation target are the same role.

It is recorded, not refused. The gate file carries the verdict, the rationale, the conditions, the
metrics and the `escalate_to` the verdict named, plus a `stalled` line saying the question reached
nobody and a person has to rule it or the proposal has to be withdrawn. Refusing would destroy a
ruling the persona produced, and the two remaining verdicts are not open to a ruler that has just
said the decision is above the pipeline.

The stall is said on the terminal in the turn it happened, in the run record, on the gate log and
the proposal page, in the state site's counts, and in the refusal a stage gets when it tries to run
again behind the still-open proposal — where "rule it" would otherwise be the instruction that
produced the loop.

A role escalating to a different role is unaffected, and so is a person in the seat: a human
`--by <role>` carries no `agent:` prefix, which is what makes a person ruling an escalation an
agent of the same role raised the way out of a stall rather than another instance of one.

## The configuration a ruling reasons from

`.sdlc/config.yaml` is versioned with the repository, so the copy on a proposal branch is the
configuration as it stood the day the branch was opened. The prompt quotes it resolved block by
block instead, under **The project's configuration**, and tells the ruler to read that rather than
the file on the branch:

- `main` governs, because it is what is true now. An address a target answers on, the services it
  depends on, the stack profile its toolchain is — these describe the world the project runs in,
  and the branch's copy of them is a stale snapshot.
- `policy` is read from the branch. It is the terms the proposal was made under, and it is the copy
  the pipeline already acted on when it chose the seat ruling this gate — except on a proposal that
  changes `policy` itself, which is ruled at G-POL under `main`'s policy (below).
- A block the proposal itself changes is read from the branch, whichever kind it is, with `main`'s
  current value quoted beside it. A proposal whose subject *is* the configuration is ruled on what
  it proposes; `main`'s copy would be the absence of the change it was asked about.

Whether the proposal changes a block is a comparison between the branch and the merge base — the
same comparison the diff is taken over — not something read out of the proposal's prose.

Where the branch and `main` disagree on a block the proposal does not change, both values are
quoted under **Where the branch disagrees with `main`** and the disagreement is named. Showing one
of them silently is what let two rulings in a row reason from an environment the project had left.

The instructions an earlier ruling left owed are quoted from `main`'s ledger for the same reason:
`.sdlc/conditions.yaml` is written on `main`, so a branch carries whatever had been filed when it
was opened, and the guard that refuses a ruling for closing a reference nothing has open already
reads `main`'s copy.

The gate file records `verdict: escalated`, `escalate_to: <the gate's escalate_to>`, and a
rationale beginning `mandatory escalation: <reason>`. The proposal branch is left open — nothing
is merged — and a run-record line is appended the same as for any other ruling.

An agent-decided `escalate` verdict (as opposed to a mandatory one) is recorded the same way, with
the persona's own rationale instead of the mandatory-escalation wording.

## Workspace the agent sees

The full project checkout, on the proposal branch — the same `cwd` the human commands operate on.
Nothing is materialised into a separate workspace for a ruling.

## Checks that block

- `verdict` must be `approve` or `return`.
- `--by` is required. It asserts a role and is not authenticated in phase 0: the check is that the
  role named holds the gate, not that the person running the command is that role (see
  `docs/decisions/0003-caller-workflow-and-unauthenticated-roles.md`).
- The working tree must be clean. A gate commit that swept in unrelated edits would make the
  record of a ruling untrustworthy, so `rule` refuses to start and lists the dirty paths.
- The branch `proposal/<name>` must exist.
- `.sdlc/proposals/<name>.md` must exist and its `gate:` front-matter line must be present.
- The project's configuration must load and validate.
- The named gate must exist in `policy.gates`.
- **A proposal whose branch changes the `policy` block of `.sdlc/config.yaml`** (compared with
  its merge base, on the value) is ruled only at G-POL. At any other gate it is refused, from
  either seat, and `rule --pending` leaves it open and prints why. At G-POL, the seat, the
  escalation target and every other policy value the ruling acts on are read from `main`'s
  policy, not the branch's: the policy a proposal asks for is its subject, and cannot name who
  rules it (`docs/decisions/0043-a-policy-change-is-ruled-under-the-policy-it-changes.md`). The
  prompt still quotes the proposed policy as the proposal's change, with `main`'s beside it.
- `by` must equal that gate's `holder` or `escalate_to`; anyone else is rejected, and the error
  names who is allowed.
- **Approving a `build-slice-<n>` proposal requires a current passing verify result**
  (`tests/results/new/slice-<n>.json`, for this proposal and for the application tree the branch
  carries). The refusal names the missing evidence and the `sdlc run verify --slice <n>` that
  produces it. Returning or escalating the same proposal is held to nothing, so a slice whose suite
  could not be bound or could not be run is still rulable in the direction that fits it. The check
  is on the verdict rather than on the seat: a person typing `--by` is refused the same approval as
  the persona holding the gate, and on the agent path it runs once the persona has answered, before
  anything about the ruling is written — and there the missing evidence is quoted back for one more
  turn first, so a rationale reached honestly is not thrown away over a verdict the ruler can still
  change (below). The one approval that goes through without a passing result
  is the one made by the target of a standing escalation, on either seat, on an escalation somebody
  else raised — the escalation and the ruling on top of it are together the record of the override
  (`docs/decisions/0022-a-guard-that-stopped-the-failure-being-recorded.md`).

- **Approving a `build-slice-<n>` proposal while a criterion it claims is owed a test** is refused
  where `policy.gates.G3.block_on_missing_tests` is true (the default), from either seat and
  whatever escalation stands, unless the ruling withdraws each such item — see "A test a criterion
  is owed" above.

- **On the agent path, that this machine can sign in at all**, asked before the acceptance
  typecheck and the ruling turn rather than discovered inside them. It is a one-turn session
  against the same config home, binary and flags the ruling turn will use, so it exercises the
  credential the ruling will actually authenticate with, and it costs a fraction of a cent against
  a ruling turn that is paid for twice when it fails. The refusal says which credential is read and
  where from, and never what it is. Skipped under the mock executor, which reaches no session at
  all. Nothing is recorded for it: no turn was spent and no ruling was produced, and the proposal
  is left exactly as open as it was.

For the agent path (`--by agent:<persona>` or `--pending`), the policy check is narrower: `by`
must equal the gate's `holder` exactly. A persona agent is never allowed to act as the
`escalate_to` target the way a human can — escalation targets are human roles by schema, so this
only ever rejects a persona ruling a gate it does not hold. An agent-held gate with no
`escalate_to` at all is rejected next, before the persona brief is read or any agent turn runs:
`gate <name> has an agent holder but no escalate_to`.

`--pending` rules each open, agent-held proposal in its own try/catch: one proposal's failure (a
bad verdict block, an escalation with no target) is printed and written to the run record, and the
loop moves on to the next branch rather than aborting the whole batch.

A batch rules a build proposal on the merits, and the merits are the suite's result, so it leaves
one without a passing result for the tree on its branch open rather than ruling it. Where the suite
has not run against that tree at all there is nothing to rule and nothing is printed; where it ran
and did not pass, the batch prints `<name>: left open — <reason>; rule it by name to return or
escalate it`, because the ruling that fits such a slice is a return or an escalation and a batch
making one by itself would send the builder to rebuild an application that may be sound, at the
cost of one of the three attempts `verify`'s retry ceiling counts.

Once every branch has been considered — whether every proposal ruled cleanly or some failed along
the way — `--pending` ends the batch back on `main`, regardless of what the last ruling in it was.
A `return` or an `escalate` normally leaves the working tree checked out on the proposal branch
(see "Return or escalate" above), which is right for a single `sdlc rule <name>` but would leave a
batch on whatever branch its last proposal happened to be, and the next `sdlc run` requires `main`.
Nothing about the ruling depends on this: a return's or an escalation's commit lives on its own
branch and stays reachable there no matter what the working tree is checked out to afterwards.

A failure that leaves the working tree dirty (an agent's turn tampering with a file) is different
and stops the batch instead of continuing. `git checkout -q main` succeeds even with uncommitted
changes present whenever the file is identical on both branches, so switching back to `main` to
carry on would carry the tampering onto `main` silently, and every later proposal in the batch
would then fail its own clean-tree check with a message pointing at the wrong ruling — and `main`
would be left dirty besides. So `--pending` checks the tree after any failure: if it is dirty, it
does not check out `main`, does not attempt the run-record commit (there is nothing clean to
commit it onto), and stops — no further proposals are ruled. The failure is still pushed into the
returned results, and the summary carries a `stopped: "<name>: working tree dirty after the ruling
agent's turn; inspect and clean before continuing"` entry. The checkout is left on the offending
`proposal/<name>` branch with the tampered file visible, for a person to inspect and clean up
before running `--pending` again — the one way a batch can end off `main` on its own.

## Exit criterion

Exits 0. Human path prints `<name>: <verdict> at <gate>`. Agent path prints `<name>: <verdict>` on
approve/return, or `<name>: escalated (<rationale>)` on escalation; `--pending` prints one such
line per proposal it rules. Every ruling, and every `--pending` batch, then ends with the short
`next` block (`docs/stages/next.md`), read from `main` whichever branch the ruling left checked out.

## Re-run behaviour

Ruling the same name again overwrites `.sdlc/gates/<name>.yaml` and commits it on the proposal
branch, so a second `approve` does have something to merge: the fresh gate file, followed by
another merge commit on `main`. That is a second ruling on the same proposal, not a no-op, and
the gate log will show both. Treat a proposal as ruled once its verdict is recorded.

## Failure modes

- Bad verdict string, missing `--by`, or no such proposal branch: throws immediately.
- The proposal file is missing its `gate:` line: throws naming the proposal.
- The named gate is not in the project's policy: throws.
- The proposal changes the `policy` block and is not at G-POL: throws, naming the gate it is at
  and saying a policy change is ruled only at G-POL. Nothing is written.
- `by` is not a listed holder or escalation target for that gate: throws, naming who is allowed.
- The working tree is dirty: throws before anything is checked out, listing the dirty paths.
- The approval merge conflicts: the merge is aborted, `main` is left as it was, the working tree
  returns to the proposal branch, and the error names the conflicted files.
- Agent path: the ruling turn reports failure, is retried once, and fails again: throws `ruling
  agent turn failed after one retry: <text>`, having written nothing. No persona brief at
  `.sdlc/personas/<persona>.md`: throws `no persona brief for
  <persona>`. The persona is not the gate's `holder`: throws naming who is (`is not a holder of
  <gate>`). The gate has no `escalate_to`: throws `gate <name> has an agent holder but no
  escalate_to`. The agent turn edited the working tree: throws `rule: the ruling agent modified
  the working tree` and leaves the edit in place. The reply has no fenced JSON block: throws `no
  verdict block in persona reply`. The block is not valid JSON: throws `bad verdict block: <parse
  error>`. The reply's `verdict` is not `approve`, `return` or `escalate`: throws `bad verdict:
  <value>`. The verdict has no non-empty `rationale`: throws `verdict has no rationale`.
- CLI: a verdict typed together with `--by agent:<persona>` throws `an agent holder rules through
  its own turn; omit the verdict, or rule as a human role` instead of running the agent's turn.

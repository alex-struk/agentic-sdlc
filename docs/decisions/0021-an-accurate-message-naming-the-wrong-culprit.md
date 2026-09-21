# 0021 · An accurate message naming the wrong culprit

Status: accepted · 2026-09-20

## Context

`verify` reports `unbound` when the adapter could not bind a member an acceptance test
calls: the test asks the surface for something, the adapter goes looking for it in the
running application, and there is nothing there. The message it writes is the adapter's own
account, quoted verbatim, and it is true — the application really does not provide that
surface. It is the only place in the pipeline that reason is written down (`0019` §2).

An `unbound` verdict has three causes. Two of them the pipeline can say.

The application is missing something the slice was asked to build, in which case the build
proposal is returned at G3 with those reasons as the conditions and `build --slice <n>
--revise` takes them on. Or the slice was asked for too much, in which case what it claims
is changed in `plan/tasks.md` so its criteria match what it builds. Both are offered in the
remediation text `verify` prints, and both are right about the cases they are for.

**The third cause is that the criterion is right and the acceptance test derived from it
reaches past it.** The test drives a capability the criterion never asks for — a screen, a
step, a control that is nowhere in the row it was derived from. The adapter cannot bind
that, because the application was never answerable for it, and what comes back is an
accurate message naming the wrong culprit: the application is reported as lacking a surface
nobody ever put in the contract. Rebuilding cannot fix it, because there is nothing wrong
with the build. Re-scoping the slice gives up a criterion that was correct all along.

The remedy exists already, one stage over. `derive-tests --domain <d> --stale` writes the
tests for the criteria on `tests/acceptance/redo.yaml`, which is exactly "this criterion
has not moved and its test has to be written again". **Nothing could put a row on that
list from here.** The file had one writer — `calibrate`, applying the product owner's
`test-wrong <ID>` from a calibration proposal — and `calibrate` only opens rows for
criteria that fail against the *old* application. A criterion the old system passes and the
new build cannot exercise is invisible to it. So the judgement arrived at a gate with no
lever, and the two exits on offer were a rebuild that cannot succeed and a re-scope that
gives up something true.

## Decision

### 1 — `test-overreaches` is a ruling verb whose work another stage does

The condition form is

```
test-overreaches <ID>: <what the test demands that the criterion does not ask for>
```

A ruling that returns a proposal and carries it files the criterion, the version it stands
at and the ruler's text verbatim onto `tests/acceptance/redo.yaml`, and the next
`derive-tests --domain <d> --stale` for that domain writes that one test again.

This is the shape `0015` settled for `recovery-wrong` and `0008` for `adapter-wrong`: a
ruling the receiving stage cannot execute is handed to the stage that can, as a file rather
than as a condition. `rule` spawns no agent, reads no contract and writes no test; what it
carries out is the *recording* — which criterion, why, and at what version — and the
writing is `derive-tests`' own, blind, in its own workspace.

**Why it is not simply `test-wrong`.** Both say the criterion is right and the test is not,
and both ask for the same thing to happen. They differ in what they tell the writer, and
that difference is the entire value of the entry: `test-wrong` says the test asserted the
wrong thing, and this says the test asked for more than the criterion did. One is a
correction and the other is a subtraction. A writer told the first about a test that
over-reached would go looking for a wrong assertion and find none. `test-wrong` also
belongs to the calibration grammar, which is ruled at G1 against the old application —
the wrong proposal, the wrong gate and the wrong question for a verdict reached from a
verify run against the new build.

### 2 — The reason is carried to the writer, or the entry is worthless

The entry carries `why`, and `derive-tests` quotes it verbatim into the prompt under a
paragraph naming each id and what was wrong with the test being replaced, followed by the
instruction that the new test must assert what its criterion states and stop there.

**This is the part the whole route turns on.** A criterion is on the redo list precisely
because nothing about the criterion has changed. Hand the writer the id and the statement
again, with nothing else, and it writes the same test again — including the over-reach,
which was never visible in the criterion in the first place. The request would be answered,
the entry cleared, and the next verify would report the same `unbound` for the same reason.
The reason is the only thing in the request that says what to do differently.

The same paragraph now carries `test-wrong`'s reason too, which it did not before, for the
same reason and to the same end. The stage stays blind: the ruler's text says what the test
demanded, never anything about the running application or how it is built.

**Why a form with no reason refuses the ruling.** A blank reason files a request the writer
cannot act on, which is the defect this verb exists to close, wearing the verb that was
supposed to close it. A reason that is only whitespace is not a reason. The refusal happens
before anything is written — no gate file, no commit, nothing filed — so the proposal is
left exactly as open as it was and the ruling can be made again with a sentence in it.

### 3 — It cannot make a criterion pass

The verdict requests a re-derivation and asserts nothing else. Nothing about the criterion's
row, the criteria index, the acceptance suite or the verify result is touched by the filing;
the only path written is `tests/acceptance/redo.yaml`. The criterion stays unverified until
a regenerated test binds and passes against the application, which is a fact established by
running the suite and by nothing a ruler can write.

**An approval may not carry the form at all, and is refused outright.** This is the guard
that matters. Everything else about the verb is a request for work, and a request for work
is harmless; an approval carrying it would be a route by which a criterion nothing can
exercise is signed off with a note about its test, and the slice merged on the strength of
it. The refusal is checked on both the human and the agent path, in the same place in the
sequence, before anything is written.

### 4 — Any gate whose conditions are free text, rather than G3 and the build proposal alone

The form is read out of a ruling's conditions wherever those conditions are free-text lines
a writer reads — every gate and every proposal family except the three with a closed
vocabulary of their own: ratification and calibration at G1, and the reviewer's triage page.

**Why not scope it to build proposals.** The verdict is about a criterion and the test
derived from it, and neither belongs to the proposal being ruled. `verify`'s `unbound` is
the case that has no lever today, but the same judgement is reachable from the same evidence
one seat over — a reviewer looking at a returned test proposal, a tech lead ruling an
escalation after three builds that could never have succeeded. A route keyed to a proposal
name would make the identical judgement inexpressible depending on who happened to be
holding the gate, which is the defect this record is about in a second costume.

**Why the three closed grammars are the exception.** A closed grammar is closed on purpose:
a line it cannot parse is a ruling that would otherwise be dropped in silence, so it is kept
verbatim under `unparsed_conditions` and the stage that owns the grammar refuses to act on
the gate file until a person has rewritten it. Reading a second, unrelated verb out of those
same lines would file a request off a ruling that has been declared unreadable, and jam the
owning stage while doing it. Nothing is lost by the exception: at G1 no test has been
derived yet, and `calibrate`'s own `test-wrong <ID>: <why>` is the ruling to make there
about a test that asserts the wrong thing.

### 5 — A person in a gate seat attaches the same conditions an agent does

`rule <name> return --by <role> --condition "..." --condition "..."` writes a `conditions`
array into the gate file exactly as an agent's ruling does, alongside the human's free-text
`note`. The flag repeated is one condition per occurrence, so a condition's own text never
has to avoid a separator.

This is not an extra: it is what makes the seat a seat. Every stage that acts on a return
reads `conditions` — `build --revise` and `derive-tests --revise` both quote them to the
agent as the list of things that have to change — and a seat that could record only one
free-text line was a seat that could not rule the same ruling. The remediation `verify`
already printed for an `unbound` slice asked for a return "with those reasons as the
conditions", which no person could actually carry out. A ruling with no conditions still
writes no `conditions` key, so a gate file is never read as a ruling that deliberately
attached an empty list.

## Consequences

- `tests/acceptance/redo.yaml` has two writers and a `verb` on the entries one of them
  makes. An entry with no `verb` is the older, unmarked kind and is worded as `test-wrong`.
- The filing lands on `main` in a commit of its own, while the ruling stays on the proposal
  branch. The request is the pipeline's bookkeeping, not part of the proposal, and a copy of
  it on a branch nobody merges would never be read by the stage it is addressed to. The
  caller is left on the branch it was on.
- An id already on the redo list is not filed twice — the first reason recorded is the one
  somebody wrote about — so a ruling read again files nothing and reports nothing.
- A `test-overreaches` line naming a criterion the contract does not hold files nothing and
  says which id it could not place. Only a run that derives that id ever clears an entry, so
  a request for a criterion nothing derives would sit on the list for ever.

## What was considered instead

**Widening `calibrate` to open redo rows for criteria that fail against the new build.**
`calibrate` is the old application's stage: it runs the suite against the oracle and asks
the product owner what a failure there means. Pointing it at the new build would give it two
subjects and two questions, and the ruling it produces would be made at G1 against a
proposal describing the old system.

**Letting `verify` file the entry itself when it sees `unbound`.** `verify` cannot tell the
three causes apart — that is the whole difficulty, and the adapter's message is equally
consistent with all three. Filing on its own judgement would send correct tests back to be
rewritten every time a build was genuinely incomplete.

**A marker on the criterion rather than an entry on a list.** The stage that has to redo the
work needs the ruler's reason, not the fact that somebody was unhappy. The same reasoning
`0015` gives for `spec/recovery.yaml`: a bare marker tells the next run to guess again.

# 0046 · A missing test is owed until a test runs

Status: accepted · 2026-09-24

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

`0042` decided that a criterion recorded as untestable is an open owed item naming what is missing
and the stage that owns supplying it; that it stays open until a test that runs exists; that proof
by other means counts only as a named test the application carries and verify executes; that a
ruler withdraws an item nobody can close, with the reason written down; and that whether an open
item blocks a slice is policy. `0044` gave owed work one module, with a new kind stored in
`.sdlc/owed.yaml` at no cost to the module.

That left open where the owner is written, when an item opens, how a project that already holds
untestable records gets its items, what the owing stage does with one, what counts as a test that
runs, how a ruler withdraws one, and what the policy key refuses. A project on this pipeline held
sixty-nine records, each with a free-text reason and no owner, the day this was built.

## Decision

**The record names the owner, and derive-tests is held to it.** A record in
`tests/acceptance/not-testable.yaml` carries `missing` and `owner` beside its `reason`. The
`derive-tests-records` post-check refuses a run that writes or changes a record, or keeps one for a
criterion it was handed, without both, or with an owner that is not a stage or is `derive-tests`
itself. How to choose the owner is judgement and is in the derive-tests skill; the prompt defers to
it. A record that names no owner is owed by `contract` (`0007`: a blocked record names a missing
contract capability), and its reason stands for what is missing.

**An item is owed from the moment its record is on `main`, and its entry is written by a pipeline
commit.** The approval that merges a record writes its entry into the merge commit, stamped with the
ruling. A record on `main` with no entry — the sixty-nine above — is read as open, owed by its
owner, by every reader: `next`, `checks`, the ruling prompt and the G3 guard. Its entry is written,
stamped `by: runner`, by the next pipeline commit that touches the list: any approval, a withdrawal
or a re-address. Reading never writes, so `next` stays read-only (`0045`), and the project changes
only through pipeline commits.

**The owing stage is handed it, and hands it on in its journal.** The runner appends a stage's open
items to its prompt, read from `main`, with one line form: `re-address missing-test/<id> to <stage>:
<why>`. The lines are applied when the run finishes, on `main`, in a commit of their own attributed
to the proposal the run opened — the way `deferred-request` lines are settled (`0034`). The stage
may hand on only what it owes; a line for anything else moves nothing and is named in the commit.
When to hand an item on is in the contract skill. `derive-tests --stale` derives the items handed
to it in its domain, and an approved derivation that keeps the record hands the item back to the
record's owner. An item whose test exists and has not run is owed by `calibrate` for the oracle's
target, or by `verify` in a project that does not calibrate.

**A test runs when a result row says so.** A row for the criterion, at its current version, from a
spec file, whose result is `pass` or `fail`. A failing row closes the item too: the question was
whether a test runs, not whether the application passes it, and a failure is `verify`'s and
`calibrate`'s to route. The calibration that writes such a row closes the item; so does the G3
approval of a slice whose verify result has one, which is also why that row lets the approval
through the guard below. An `attested` row closes nothing.

**Proof by other means is decided and not built.** An `attested` row naming an in-application test
verify executed would close an item. Verify runs the acceptance suite and nothing else, so no row
can name such a test; teaching it to run a named test inside the application is its own change,
through the stack profile. Until then only an acceptance test that ran closes an item, and the
operating model marks the rest as decided, not yet built.

**A ruler withdraws one with the line a condition is withdrawn with.** `condition-withdrawn
missing-test/<id>: <why>`, on any ruling and from either seat, through the same guards: no reason,
or a reference nothing has open, is refused with the open list in the message, and the agent seat
gets its one re-prompt. `condition-met` on a missing test is refused, because nothing a ruler writes
closes one. A withdrawal holds for the criterion's version.

**`policy.gates.G3.block_on_missing_tests`, true by default.** An approval of a build slice is
refused while an open item names a criterion the slice claims, unless the same ruling withdraws it
or the slice's verify result shows its test ran. Both seats are refused in the same words and the
refusal is recorded. A standing escalation does not lift it, unlike the verify evidence guard
(`0022`): the escalation target can already withdraw the item on the record, and an approval that
passes over one without a word is the omission this exists to stop.

## Alternatives

**Backfill with a command that commits every entry at once.** One commit, and every entry exists
before anything reads it. It needs a command nobody would otherwise run, a moment somebody has to
choose, and a reader that is wrong until then; reading records without entries as open is right from
the first read, and the next approval writes them down anyway.

**Store nothing and derive every item from the records.** It cannot hold a withdrawal, a move, or
the fact that an item was met, since the record is gone once a test exists, and an item that
disappears with its record is the quiet disappearance `0042` exists to end.

**A verb of its own for withdrawing a missing test.** Clearer to read, and a second form for a ruler
to learn, a second grammar for both seats to refuse the same way, and a second place for the two to
drift. The reference already says what kind of item it is.

**Apply a stage's re-address lines when its proposal is approved.** The gate would then rule the
move. A proposal that is returned would hold the item back while the stage it was handed to waits,
and a run that opens no proposal could never hand anything on. The move is visible on the proposal
page, in the journal it came from, and in its own commit.

**Close only on a passing row.** It would make an item's closure depend on the application being
right, which is what verify and calibration already decide; a test that runs and fails is exactly
what an untestable record was not.

**Let a standing escalation approve past an open item.** The verify guard allows it because an
escalation is the only way a slice past its retry ceiling can be finished. Nothing is trapped here:
the withdrawal is open to every ruler.

## What would reverse it

Withdrawals that routinely say the same thing — that a class of record is owed no test — would argue
for the record to say so and the item not to open. Items that sit with `contract` across several
contract runs without being handed on are evidence the skill does not tell it enough, or that the
default owner is wrong for that project. A stack profile that can run a named in-application test
is what builds the attested closure.

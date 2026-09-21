# 0015 — One criterion can go back to archaeology without holding up its domain

**Status:** accepted · 2026-09-20

`archaeology` recovers a domain's behaviour from an old application as provisional criteria, and the
ruling at G1 decides which of them become the contract. The ruling acts through a closed vocabulary
of conditions, and every verb in it assumes the row it names is an accurate record of the old
application: the disagreement is about wording (`edit`), about whether the behaviour should carry
forward (`defect`, `obsolete`), about confidence (`confirm`), or about a decision not yet made
(`spike`).

A criterion can be none of those. It can be recovered wrongly: a statement about a guard that can
never execute, citations that point at the code the statement misreads, and a consequence recorded
backwards. There is no correct statement to `edit` to, because writing one means reading the old
application again. `defect` and `obsolete` both assert the row accurately describes the old system,
which is the thing that is not true, and `obsolete` additionally throws away a behaviour nobody has
established anything about. `spike` records a question that is already settled — and it is one of
the two non-answers a criterion is allowed before the closing loop marks it obsolete on its own.

Returning the proposal is the route that exists for wrong evidence (`0006`, §5), and it is the wrong
size for this. A return sends the whole domain back and holds every criterion in it until the
revision is ruled again. Where eleven criteria are sound and the twelfth is not, that is eleven
criteria frozen behind one, for as long as the one takes.

## 1 — `recovery-wrong` is a ratification verb whose work another stage does

**Decision.** The ratification grammar gains `recovery-wrong <ID>: <what the evidence actually
shows>`. `ratify` applies it by recording the request — on the row as a note, and in
`spec/recovery.yaml` as an entry carrying the id, the domain, the version, the ruler's text verbatim
and a fingerprint of the evidence the row held — and by dropping a provisional row to `open` so it
cannot mint a permanent id while it is out. Everything else in the domain ratifies in the same pass.
The next `archaeology` run for the domain is given the entries and the reasons in its prompt and
recovers those criteria again.

**Why this is not the condition `ratify` cannot carry out.** The objection to encoding "go and look
again" as a verb is that `ratify` cannot look again: it spawns no agent, reads no old application,
and applies conditions mechanically. That remains true, and this verb does not ask it to. What
`ratify` carries out is the *recording* — which criterion, why, and in what state it went out — and
recording is exactly what it already does for every other verb. The looking is `archaeology`'s, in
its own workspace, with `sources/old` mounted.

**Why a file rather than a marker on the row.** The stage that has to redo the work needs the
ruler's reason, not the fact that somebody was unhappy: "the guard sits behind a condition that is
always false, so nothing in the application rejects anything here" tells the next recovery what to
read, and a bare marker tells it to guess again. The reason is on the row as a note too, so the
domain file alone says why the criterion is in the state it is in, but the file is what the stage
reads and is judged against.

**Why `spec/recovery.yaml`.** `calibrate` already hands a ruling it cannot execute to the stage that
can, through `tests/acceptance/redo.yaml` (`test-wrong`) and `tests/adapters/rebind.yaml`
(`adapter-wrong`, `0008` §3). This is the same shape and is read and written through the same kind
of module. It lives under `spec/` because the stage that acts on it may write nowhere else.

**When to use which.** `recovery-wrong` is for one row in a domain whose recovery is otherwise
sound. A return is still right when the recovery is wrong broadly — the wrong entry point was read,
several criteria have no evidence, what came back is not usable — because then there is no sound
remainder to release and a whole-domain revision is what is actually needed.

## 2 — An entry is answered by the criterion changing, not by anything clearing it

**Decision.** Nothing removes an entry from `spec/recovery.yaml`. An entry is outstanding — still
owed work — only while the criterion it names is still in the domain file and still matches the
fingerprint it was sent back with: its statement, citations, given/when/then, confidence,
reconciliation class and notes.

**Why not a bookkeeping pass.** Any stage that clears entries can fail to clear one, clear one
early, or be skipped, and every such bug is silent. Deriving the state from the criterion itself
cannot drift from the criterion, and it makes replay free: `ratify` re-applies every gate file's
conditions on every run, so a `recovery-wrong` line is read again on each pass, and filing the same
request twice would otherwise reopen work that was already done. An entry with the same id and the
same reason is filed once.

**Why the whole evidence set and not just the statement.** A re-recovery can conclude that the row
was right — rarely, but it happens, and it must be able to say so. Fingerprinting the notes as well
means "I read the migration again and it does say this; here is the line" is a real answer that
resolves the entry, while changing nothing at all is not.

## 3 — A criterion out for re-recovery leaves the closing loop while it is out

**Decision.** `ratify`'s follow-up proposal does not list a criterion with an outstanding entry, and
the loop's two-ruling bound does not count it.

**Why.** The follow-up asks the product owner which still-unresolved criteria become the contract.
A criterion out for re-recovery has no answer to give: it is waiting on the old application's source,
not on a ruling, and asking for a verdict on evidence known to be wrong invites exactly the
wave-through the persona's brief forbids. Worse, the bound would eventually mark it `obsolete`
"unresolved after two rulings" — a recovered behaviour dropped from the contract for failing to
answer questions nobody asked it. It rejoins the loop the moment it has been recovered again, with
whatever confidence that recovery graded it.

## 4 — A criterion that comes back unchanged fails the run that returned it

**Decision.** `archaeology`'s post-checks include `archaeology-recovery`: a run for a domain that
still carries an outstanding entry — the criterion is in the file, and every recorded field is
identical — fails, naming the criterion and the reason it was sent back.

**Why a failure rather than a note.** The failure this route exists to prevent has already happened
once by another road: a stage was told to redo a criterion, re-emitted the domain file byte for
byte, and reported success. Nothing downstream could tell that from a re-recovery that agreed with
the original, so the row stayed wrong and the ruling looked acted on. A check is how every other
promise in this pipeline is made legible, and this one is cheap to satisfy honestly: correct the
row, or record on it what was read and why it stands.

**What would reverse it.** Runs failing this check for criteria that were genuinely re-examined and
genuinely unchanged, often enough that the note the check asks for reads as a formality rather than
as evidence. The count of how many times a criterion has been sent back, which `ratify` reports, is
where that would show up first.

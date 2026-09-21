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
cannot drift from the criterion.

**The same rule decides whether the condition still applies at all.** A gate file is never
consumed: `ratify` re-reads every approved ruling on every pass, so a condition is an instruction
that fires again each time. For every other verb that is harmless, because each one checks the row
before acting and a second application is a no-op. `recovery-wrong` is not like them, because the
work it asks for is done somewhere else and lands after the ruling: re-applying it would push its
note back onto a row that had been recovered again, drop that row to `open`, and restore the exact
fingerprint that says the work is still owed — which would then fail the next recovery run's own
check for work that run had already done. So the condition applies only while its own request is
still outstanding. Once the criterion has stopped matching the request filed with it, the condition
does nothing, for good. A later ruling naming the same criterion with a different reason is a
different request and is filed as one; the same reason twice is the same request and is filed once.

**Why the whole evidence set and not just the statement.** A re-recovery can conclude that the row
was right — rarely, but it happens, and it must be able to say so. Fingerprinting the notes as well
means "I read the migration again and it does say this; here is the line" is a real answer that
resolves the entry, while changing nothing at all is not.

## 3 — A criterion out for re-recovery leaves the closing loop while it is out

**Decision.** `ratify`'s follow-up proposal does not list a criterion with an outstanding entry, and
the loop's two-ruling bound does not count it.

**Why, and why "while it is out" is the whole of the rule.** The follow-up asks the product owner
which still-unresolved criteria become the contract.
A criterion out for re-recovery has no answer to give: it is waiting on the old application's source,
not on a ruling, and asking for a verdict on evidence known to be wrong invites exactly the
wave-through the persona's brief forbids. Worse, the bound would eventually mark it `obsolete`
"unresolved after two rulings" — a recovered behaviour dropped from the contract for failing to
answer questions nobody asked it.

The exemption is exactly as wide as the outstanding request and no wider. It is computed from the
entries the criteria still match, plus whatever this pass is filing, so it lifts the moment the
recovery comes back: the criterion is then an ordinary unresolved row, the follow-up asks about it,
and the bound can reach it. An exemption keyed to "was ever sent back" instead would disable the
pipeline's only termination guarantee for that criterion permanently, and a loop that cannot close
is a worse failure than the one this route exists to fix.

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

## 5 — The ruling on a re-recovery is read, and the row it corrects may be rewritten

**Decision.** `ratify` reads three families of ruling for a domain, oldest first by the `at` each
gate file records: the first archaeology proposal, the closing loop's follow-ups, and the numbered
archaeology proposals a re-run opens. And `archaeology --revise` may rewrite an already-minted
criterion when, and only when, that criterion has an outstanding re-recovery request against it.

**Why the numbered proposal has to be read.** A re-recovery is a fresh archaeology run, and a fresh
run opens `archaeology-<d>-<n>`. That proposal is where the persona rules on the work the request
asked for, so a `confirm` closing the criterion out is filed there. Read only the first proposal and
the follow-ups, and that ruling is dropped: the criterion stays short of the contract, and the only
route left to it is a follow-up asking a question the persona has already answered.

**Why ordered by time rather than by name.** The families number independently, so
`archaeology-<d>-3` and `ratify-<d>-3` say nothing about which came first — and the order decides
which verdict on a criterion applies over which. Every gate file `sdlc rule` writes records when the
ruling was made, which is the only total order that is also true.

**Why the permanent record opens for exactly one row.** A minted criterion can be recovered wrongly
too, and a ruling can say so. In a revision, the check that refuses any change to a minted criterion
and the check that refuses an unchanged re-recovery would then contradict each other, and the run
could satisfy neither. The narrow exemption — this row, because a ruling sent it back — leaves the
rest of the permanent record exactly as closed as it was. Removing such a row stays refused: the
contract, its tests and anything that replaces it point at that id, and deciding a behaviour should
not be carried forward is `obsolete`'s ruling to make, not a recovery's.

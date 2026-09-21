# 0028 · A guard that corrected a fault by destroying the work that held it

Status: accepted · 2026-09-21

## Context

A return may carry a plain condition — a line of free text a writer reads, not a structured
instruction — but only where it names a path the stage the proposal goes back to can
actually change. `assertDeliverableRulable` (`src/commands/rule.mjs`) refuses one that
names anything else, and the refusal is right: a stage's workspace is writable only where
it is collected, and a condition asking for a path outside that either fails mid-run or is
done and quietly dropped (`0027`), which is worse than refusing it up front.

Where it ran was wrong. It fired after the ruling turn had already answered — a verdict, a
rationale, and every condition but the one at fault — and it threw. The throw discarded all
of it. A reviewer that produced a correct and valuable ruling, including a finding that a
proposal asserted work its own branch did not contain, lost the whole ruling because one
condition among several used a plain form where `addressed-to <stage>: <why>` was needed.
Re-running cost a fresh paid turn and produced a different ruling — not a retry of the one
that was thrown away, a new one, since nothing forces two turns over the same proposal to
agree.

The persona had already been told the rule. `deliverabilityNote` (`src/runner/persona.mjs`)
names, in the prompt itself, what the stage this proposal returns to can change and gives
the `addressed-to` line to use for anything else. It wrote the wrong form anyway — a prompt
note is not read as reliably as a grammar is enforced — so this recurs, and a stronger
warning is not what fixes a recurring mistake; a chance to correct it is.

The shape already had an answer in the same file, ten lines above. `grammar.unparsed`, read
at G1 and at a triage return, catches a condition the ratification grammar cannot read,
quotes the unreadable lines back to the persona with the grammar restated, and asks once
more. What comes back — corrected or not — is what is recorded, because the verdict was
reached honestly and the reasoning is worth keeping either way. `assertDeliverableRulable`
answered the same kind of mistake with a throw instead, ten lines below.

## Decision

### The re-prompt precedent is followed exactly, once, before the refusal

A defect a rewrite can fix mechanically — a condition line missing the reason its own form
requires, or a plain line naming a path the returned-to stage cannot deliver — is looked for
before the hard checks run, in `ruleByAgent`. Found once, the persona is re-prompted: its
own prior reply quoted back, the offending line, what it should have written, and the same
closing instruction the unparsed-conditions re-prompt uses — keep the rest exactly as it
was, rewrite this line, finish with the JSON block as before. The reply that comes back,
corrected or not, replaces the one that triggered the re-prompt and is what the hard checks
after it are run against. A reply that switches to `escalate` on the second turn is handled
exactly as it would have been had it escalated on the first.

One re-prompt, not a loop: the same ceiling the unparsed-conditions path holds itself to,
for the same reason — a turn that gets it wrong twice is not making a formatting slip
anymore, and a batch running unattended must not turn one stuck proposal into an unbounded
retry.

### A refusal that still happens does not vanish silently

Where the second reply is still undeliverable, the guard refuses exactly as before — no
gate file, no proposal section, no commit, the same as any other refused ruling. What
changes is what the refusal says. Every throw in this trio of guards now carries, appended
to the reason, the verdict and every condition the ruling produced, not only the line that
sank it. Nothing else could hold it: a refusal here writes nothing to the branch, so the
thrown message — read on the terminal directly, or carried into the run record and printed
by `rule --pending`'s own failure handling — is the only place a ruling that may have cost
two full turns is still visible. An operator reading it can act on the rest of the ruling by
hand rather than paying for a third turn to find out what the first two already said.

### The guard itself is unchanged

Nothing about what a return may carry is different. A condition naming an undeliverable
path is still refused before anything is written, on both seats, in the same words it
always used. The re-prompt is a chance to fix the one line that would otherwise sink an
honest ruling; it is not a second reading of whether the line was right.

### The human seat needed no change

`rule()` calls the same three guards in the same order, before `commitRuling` writes
anything — a property that predates this fix. A person's return with an undeliverable
condition is refused with the identical message an agent's second, still-undeliverable
reply gets, listing the same guidance and the same full set of conditions. Nothing of a
person's own typing is at risk of the loss a re-prompt exists to prevent: there is no turn
to redo, and the condition that was fine can simply be given again alongside the one
line rewritten — which the refusal message now shows in full, so there is nothing to
reconstruct from memory either.

### The two siblings the same shape covers

`assertOverreachRulable` and `assertAddressedRulable` sit beside `assertDeliverableRulable`
in the same file, run at the same point, and each refuse a condition line carrying no
reason — the identical defect: a verb used correctly with nothing after the colon, fixable
by the same rewrite. That branch of each now goes through the same one-turn re-prompt, and
its throw carries the same verdict-and-conditions suffix.

The other branch of each — an approval carrying a `test-overreaches` or `addressed-to`
condition, which no verdict but a return may carry at all — is not read by the re-prompt.
That is not a line with the wrong shape; it is the verdict and the condition disagreeing
about what was just ruled, and asking the persona to reword the line would really be asking
it to choose a different verdict, which is the ruling itself and not a correction of it.
Both throws still fire immediately, unprompted, and now carry the same visibility suffix as
everything else in the trio, so a wasted turn there is at least not an invisible one.

## What else runs after the turn and throws, and was left alone

**`assertApprovalEvidence`.** It refuses an `approve` with no current passing verify result,
after the turn, discarding whatever the persona said. This is not an oversight: `0022`
reasoned through exactly this trade and kept the throw, because the guard has no line to
quote back — a missing result is a fact about the branch, and the only correction available
is a different verdict, which is the ruling itself. `0022` already accepted the cost of the
turn spent reaching it. Extending visibility to it would mean widening its signature to
carry conditions it has never taken, for a guard a decision record already settled; left as
it stands.

**`parseVerdict`.** A reply with no fenced JSON block, invalid JSON, an unrecognised verdict,
or no rationale throws with no retry at all. It looks like the same family — after the turn,
a throw — but there is no ruling to lose: nothing parsed, so there is no verdict and no
condition list to preserve. A future re-prompt for a malformed reply is a reasonable next
step but is a different repair, for a different failure (the protocol was not followed, not
that one line inside a followed protocol was wrong), and is left unfixed here.

## Consequences

- A return refused for an undeliverable plain condition, or for a `test-overreaches`/
  `addressed-to` line missing its reason, gets one more turn before the ruling it belongs to
  is thrown away — the ordinary case, since the persona was already told the rule and the
  mistake is a formatting slip rather than a disagreement.
- A ruling still refused after that turn costs two turns instead of discarding both, and the
  operator sees the whole of what was produced — verdict and every condition — in the
  message that reports the refusal, not only in a session nobody kept.
- The human seat's behaviour was already correct and needed no change: confirmed by test,
  not merely inspected.
- `assertApprovalEvidence` and `parseVerdict` keep throwing exactly as before, for reasons
  specific to each rather than because they were missed.

## What was considered instead

**Re-prompting for the verdict/condition-type conflicts too.** Rejected for the reason given
above: there is no line to rewrite that settles the conflict, only a verdict to reconsider,
and re-prompting for that is re-running the ruling under another name rather than fixing a
slip in how it was written down.

**Recording the refused ruling as a `## Ruling` section or gate file, flagged unusable.**
Considered and rejected on the same ground `0027` rejected recording an unparsed condition
that would change a criterion: an undeliverable condition is not commentary a stage reads
past, it is an instruction, and a record that looks like a ruling but must never be acted on
is a trap for whatever reads gate files next. The message is enough — it is read once, by
the person who has to act on the refusal, not by any later automated reader.

**Raising the retry ceiling for this defect specifically.** One re-prompt is what the
unparsed-conditions precedent already established as enough for a formatting slip, and nothing
about this defect argues it needs a different ceiling; matching it keeps one rule for "a
persona's reply had a fixable defect" instead of one per guard.

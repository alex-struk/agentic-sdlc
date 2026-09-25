# 0048 · A hand-on waits for what it rests on, and an item a stage keeps is not offered again

Status: accepted · 2026-09-25

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

`0046` hands a stage the missing tests it owes and lets it move each one on with a journal line,
`re-address missing-test/<id> to <stage>: <why>`, applied when the run finishes. It left three
things open, and a project running it met all three in one contract run.

The run was handed 69 items. It supplied what 60 of them lacked and handed those to `derive-tests`,
sent 3 to `ratify` as unobservable in themselves, and said in its journal why the other 6 stay with
`contract`. Its proposal was approved. What the approval should leave behind was not decided:

- A hand-on to `derive-tests` says "what the writer lacked now exists". It exists on the proposal
  branch. Moved when the run finishes, the item is offered to `derive-tests` while the contract it
  needs is not on `main`, and stays with the writer if the proposal is returned.
- An item the run was handed and said nothing about stays owed by `contract`, and `sdlc next`
  offers `sdlc run contract` for it. The run has already said it cannot supply it, so following
  `next` runs the same stage on the same items without end.
- Twelve of the items named criteria that ratification had since superseded or made obsolete.
  `derive-tests` derives no test for such a criterion, so `next` offered `derive-tests --stale`
  runs that would not derive them, and nothing could ever close them.

## Decision

**A hand-on to the test writer is applied by the approval.** A gated run holds its
`re-address … to derive-tests` lines; the approval that merges its proposal applies them in the
merge commit, stamped with the ruling (`by: <proposal>`, `gate`, `approved_by`). A move to any
other stage — the one whose the item is, or `ratify` — rests on nothing the run made and is applied
when the run finishes, as `0046` decided, so a returned proposal does not hold it back. A gate-less
stage's work is on `main` when it finishes, so all its moves are applied then.

**Saying nothing is how a stage says it could not supply an item.** The contract skill already
tells the stage that an item it writes no line for stays owed, and asks it to say why in the
journal; the run above did exactly that for each of its six. The approval records each item the
run was handed and did not hand on as `kept`, stamped the same way. The item stays open and owed by
the stage. `sdlc next` does not offer the stage for it again: it lists it under `waiting on a
person`, as waiting on a ruler, with the withdrawal line and the deviation that runs the owner once
something has changed. Any later move clears `kept`.

**What the run was handed is read from where its branch was cut.** A stage is handed what its stage
owes on `main`, in its domain for a stage that runs per domain, and nothing commits to `main` while
a stage runs (`0047`), so the commit the proposal branch was cut from — the merge-base of the
approval's two parents — holds exactly that list. An item owed after the run started was never
handed to it and is not kept by it. The lines are read from the run's account on the proposal page,
above the `## Ruling` section, so a ruler quoting one is never read as the run saying it. The same
reading applies any move the run's finish did not, so an approval leaves the list as the run's
account says, however its finish went.

**A retired criterion is owed no test.** A criterion another supersedes, or one made obsolete, is
derived no test (`acceptedCriteria`), so its missing test can never close. Every reader leaves it
out, as a record with no entry is read as open before anything writes it (`0046`), and the next
pipeline commit that touches the list withdraws it, stamped by the runner, with the supersession
as the reason. The ruling that retired the criterion is the withdrawal.

**A stage with no agent turn is handed nothing.** `ratify` has no prompt to be handed an item, and
running it applies rulings rather than answering one, so an item owed by `ratify` waits on a ruler
too: a condition that changes the criterion, or a withdrawal. Its approvals, and `calibrate`'s, have
nothing to settle; what `calibrate` and `verify` owe is answered by what they run.

**An approval whose settlement is not on `main` is settled by `sdlc rule <name> --settle`.** It
reads the ruling from the gate file on `main` and the handed list from the approval's merge, brings
the list into line with `main` as every pipeline commit that touches it does, and commits what
changed as the pipeline author, so the hand-edit check reads it as the pipeline's. It is idempotent,
refuses a proposal with no approval on `main`, and asks for no seat, since the ruling it applies is
already recorded.

## Alternatives

**Hand every item the stage did not re-address elsewhere to `derive-tests`.** It needs no word from
the stage. The writer would be handed items whose blocker still stands, re-record each with the
same owner, and its approval would hand them straight back: the loop moves from one stage to two
and costs a derivation each time. The stage knows per item and says so.

**A line of its own for "could not supply".** Explicit, and a second form for the stage to get
wrong and for the prompt to explain, meaning what silence already means under the skill.

**Settle on the next pipeline commit that touches the list.** Nothing to type. It needs a way to
tell which approvals are unsettled, which is reading every approved proposal on every commit, and
until some other commit happens `next` keeps naming the wrong run.

**Settle in `next` or `checks`.** Both only read (`0045`).

**Record the handed list when the run starts.** Exact, and a commit on `main` during a stage, which
`0047` rules out; the branch point already holds the same list.

## What would reverse it

Kept items that a later run of the same stage routinely supplies without anything having changed
would say that a stage's silence is not a reliable "could not", and that the owner should be offered
again after some bound. Runs that hand an item to `derive-tests` which the writer then re-records
with the same owner would say the hand-on is being claimed without the supply, which is the
proposal's ruler's to catch.

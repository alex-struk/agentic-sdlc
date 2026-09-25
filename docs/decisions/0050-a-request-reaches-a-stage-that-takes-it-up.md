# 0050 · A request reaches a stage that takes it up, and the revision that rests on it waits

Status: accepted · 2026-09-25

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A reviewer returned a test proposal at G3 with two conditions. The first was
`addressed-to contract: …`: two tests changed one seeded record, the seed is the contract's, and
the writer cannot add a record. The second was the writer's own: once the contract has supplied a
record of its own, move the tests onto it.

The second was filed as owed. The first was filed nowhere. `0024` made a stage addressable when it
has a revision mode (`revisionOverlayPaths`), and `contract` has none, because every run of it
completes the contract from `main`; a request to it came back from the filing code as
`unroutable`, and nothing printed that list. The ruling recorded both lines, the gate file showed
both, and only a reader who went looking for the request on `.sdlc/revision-requests.yaml` could
tell that half of it had gone nowhere. The same was true of `archaeology`, which reads requests on
its `--revise` run but declares no overlay, although the persona briefs named it as addressable.

Then `sdlc next` named `derive-tests --revise` first. The writer's condition says to act once the
contract has supplied the record, so a revision run then does one of two things: fails at a
condition it cannot meet, or meets it some other way, which is the change nobody asked for.

## Decision

**A stage is addressable when some run of it takes a request up.** `requestTakenBy(stage)` in the
registry answers `"revise"` for a stage with a revision mode, and otherwise whatever the stage
declares as `takesRequests`: `archaeology` declares `"revise"`, since its `--revise` run reads
requests without an overlay, and `contract` declares `"run"`, since its ordinary run is the one
that starts from `main`. `addressableStages()` is the set, read off the stages as `0024` wanted.
`contract`'s run is handed every open request addressed to it, in the prompt block every reopening
uses, and `finishStage` spends the round as it does for any other stage.

**A line naming a stage that takes no request is refused before anything is written.** From
either seat, in `assertAddressedRulable`, with the stages that can be named; the agent seat gets
the one re-prompt the other fixable defects get. A request that no run can take up and that is
recorded anyway is indistinguishable, on the ruling, from one that was filed.

**The ruling says what it filed.** `sdlc rule` prints `requested of <stage>` with the run that
takes the request up, from both seats.

**A request records the proposal that took it up.** `taken_by`, beside `taken`.

**A returned proposal is held while its own ruling's request to another stage is unanswered, or
answered by a proposal not yet approved.** `next` does not offer the revision; it lists it under
`held:` with the reason and offers the request instead, which is upstream. An approval of the
proposal that took the request up, or of a later one in its line of work, releases it. A request
to the returned proposal's own stage holds nothing, since the revision answers it (`0024`). A
request taken before `taken_by` was recorded names no proposal and is read as answered, since
nothing on file says which proposal to wait for.

**A recorded return whose request is not on `main` is settled by `sdlc rule <name> --settle`.**
It reads the gate file from `main`, the proposal branch or the returned branch, files each
`addressed-to` request not already on file, stamped with the ruling's own seat, gate and time,
and commits as the pipeline author. Filing dedupes on the request's identity against every entry,
open or taken, so a second settle files nothing.

## Alternatives

**Give `contract` a `--revise`.** A second way to run a stage whose every run already starts
from `main` and completes the whole contract; the flag would change nothing about what the run
reads except the requests, which the ordinary run can read as well.

**Keep the unroutable list and print it.** The ruling would still be recorded with a request in
it that nothing will answer, and the terminal line is the only record that it was not filed.

**Order the request before the revision and offer both.** Upstream-first ordering already does
that. The revision would still be offered, and `sdlc run` would run it without a deviation.

**Hold only while the request is open.** The request is taken when the addressed stage opens its
proposal, which is before anyone has ruled that the answer is right. A revision built on an
unapproved contract is built on a branch.

## What would reverse it

A stage that takes requests up in a way neither `--revise` nor its ordinary run describes would
need a third value of `takesRequests`. Revisions routinely held for requests whose answer never
mattered to them would say that a ruling should mark which of its requests the revision rests on,
rather than every request it files holding the revision.

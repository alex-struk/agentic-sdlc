# 0084 · A ruler can withdraw a request, and verify names the failing line

Status: accepted · 2026-10-01

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A ruling files a revision request with `addressed-to <stage>: <why>` on a return
(`.sdlc/revision-requests.yaml`). The request is closed as met by the run of that stage that takes
it up, and by nothing else. A run handed a request it cannot answer defers it with
`deferred-request <n>: <why>`: the request stays open, `next` offers the stage's `--revise` run for
it again, and once the line of work has sent the stage back more often than `policy.loops.request`
allows, the proposal that run opens is escalated. No ruling can close it.

Some requests cannot be answered by any run of the stage they were sent to. A build ruling asks
`bind-adapter` to re-run a criterion's test and report which step read an empty value.
`bind-adapter` is never shown the tests and cannot run the suite, so every run defers the request,
and `next` goes on naming `sdlc run bind-adapter --target <t> --revise` for it. The ruler who knows
the request is unanswerable, or that its question has been settled another way, has no line to say
so. Plain conditions and missing tests already have that line,
`condition-withdrawn <ref>: <why it is no longer asked for>`
(`docs/decisions/0032-an-instruction-nobody-had-to-account-for.md`,
`0046-a-missing-test-is-owed-until-a-test-runs.md`).

The request above was asked for because verify's return condition did not say which assertion
failed. A condition is built from the test error: its first line, the lines that say what the
application did (`Received:`, `Expected:`, an element that intercepts pointer events), with colour
codes and the stack dropped. A test with several `expect` calls reads `Received: ''` from any of
them. Playwright's JSON report records the failing assertion's place on each result:
`error.location` and the stack's frames, with the absolute path of the machine the suite ran on.
The result rows verify writes keep only the message.

## Decision

**A request is named `request/<proposal>#<n>`.** `<proposal>` is the proposal whose ruling filed
it, and `<n>` is its position, one-based, among the requests that proposal's rulings filed, in
filing order. That is ordinarily its position among the ruling's `addressed-to` conditions. The
reference is derived from the file rather than stored on it: entries are only ever appended and
never removed, so a position does not change, and requests filed before references existed are
named the same way. The `request/` prefix keeps it apart from a plain condition's `<proposal>#<n>`,
which numbers the same ruling's other lines.

**A ruler withdraws one with the condition verb's own line.**

```
condition-withdrawn request/<proposal>#<n>: <why it is no longer asked for>
```

It is accepted on any verdict and from either seat, as `condition-withdrawn` is for a condition or a
missing test. The entry is closed under `withdrawn: { why, by, at }`, beside everything it was
filed with, including a run's `deferred` account. It is not written as `taken`, so nothing that
reads `taken` as "a run answered this" is told a run did. A withdrawn request is no longer handed
to a run, offered by `next` or reported by `sdlc checks`, and it releases a returned proposal held
on it. `condition-met` on a request is refused, because a request is met only by the run that takes
it up. A reference to no open request is refused before anything is written, with the open
requests and their references in the message, and the agent seat gets the one re-prompt any
fixable line gets.

**The reference is printed wherever an open request is listed.** `sdlc checks` leads each untaken
request's warning with it and names the withdrawal beside `sdlc run <stage> --revise`. `next`
appends the references to the item that offers a stage's run for its requests, and for a request a
run deferred, the line that withdraws it. The ruling prompt lists, with references, every open
request a run has deferred and every open request this proposal's own line of work filed.

**Verify's return condition names the place in the test the assertion failed.** When the suite's
report is read, each failed test records `line`, the line of the first stack frame inside its spec
file. That frame is the failing assertion, or the call into a helper or adapter member that threw.
Only the number is kept. The condition ends `— at tests/acceptance/<domain>/<file>:<line>`, with the
row's own project-relative path. A row without `line` whose message carries the stack is located
from the message. The 400-character cap applies to the text before the location, so truncation
never removes it. A location is not the test's code, so the builder is still never shown the test
(`docs/stages/build.md`).

## Consequences

- A request no run of its stage can answer ends with a ruling that says why, rather than with the
  owed-loop escalation that is the only way out without one.
- References are positions in an append-only file. A file edited by hand to remove or reorder an
  entry renumbers that proposal's later requests; `sdlc checks` reports such an edit as a
  hand-edit.
- A result row's tests carry `line` where the report located the failure; rows written before this
  carry none and are located from their message where it holds a stack.
- A ruler reading a verify return sees which assertion of a test failed. A request to another stage
  to find that out is no longer needed.

A ruler reads the requests its proposal answered in that proposal's own account, and may close
one there. The run closed it when it took it up, so the line asserts what is already true: it is
dropped before the ruling is checked, with a note naming the request, rather than refused as
naming nothing open. The ruling prompt likewise reads open requests from the proposal's branch,
where a run's take is recorded until the proposal merges.

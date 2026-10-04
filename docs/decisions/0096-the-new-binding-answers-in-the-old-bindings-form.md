# 0096 · The new binding answers in the old binding's form

Status: accepted · 2026-10-03

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A test reaches either target only through the contract's surface, and each target has its own
binding of it under `tests/adapters/<target>/`. Calibration runs the tests against the old target,
so the tests are known to pass on what the old binding returns. Many of them read an observation as
text and look for words in it.

The contract names what a member is for, not the exact text it returns, so a binder can satisfy it
in more than one form. A new binding that answers in another form fails a test the application
passes. Two cases from one project: an observation that returned every checkbox with its state,
where the old binding returned only the ticked ones, made every area's name appear in the text; and
an action that did not accept a spelling of its input the old binding accepted refused the input
before anything reached the application. Each failure was returned to a builder, who cannot see or
change the binding, and cost one or two builds before a ruler traced it to the binding.

The binder of the new target already has the old binding in its workspace: `tests/adapters/` is the
stage's own output and is archived in whole.

## Decision

**The binder of the new target matches the old target's binding of each member.** The bind-adapter
skill tells it to read `tests/adapters/old/index.ts` before binding a member, and to return the same
items, in the same order and with the same separators, leaving out what the old binding leaves out.
An action accepts the same spellings of its input. The running page decides how a thing is reached;
the old binding decides what is handed back. Where the new page offers something the old one did not,
the binder says so in its journal.

## Consequences

- A difference in form between the two bindings is settled when the new target is bound, before a
  build is judged by it.
- Nothing checks the rule mechanically. A ruler who finds a new binding answering in another form
  sends it back to `bind-adapter`, as before.
- A project with only one target is unaffected.

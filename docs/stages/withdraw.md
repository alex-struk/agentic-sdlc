# Stage: `withdraw`

## Purpose

Set aside a proposal that is still open without ruling on anything it asks. A ruling answers a
proposal's question: approve accepts it, return sends it back with conditions, escalate hands it
on. None of those fits a question that should not have been asked. Examples are a proposal built
on evidence later found to be broken, such as a calibration whose target could not be reset, or
one that a newer proposal of the same kind has overtaken. Leaving it open is not an option either,
because a stage that opens a family of proposals waits for the open one to be ruled before it
opens the next.

`withdraw` closes it, records who did so and why, and answers nothing. The reasoning is
`docs/decisions/0057-a-proposal-set-aside-without-an-answer.md`.

## Inputs

`sdlc withdraw <proposal> --by <role> --reason "<why>"`, run from `main` in the project's working
tree with a clean tree.

- `<proposal>` — the proposal's name, whose branch is `proposal/<proposal>`.
- `--by` — who is withdrawing it. The seats allowed are the ones that could rule it, read from
  the policy on the proposal's own branch: the gate's holder, its `escalate_to` as a person, and
  `agent:<escalate_to>` where the project plays that role by an agent. A person types the role; an
  agent passes `agent:<persona>`. Both go through the same check.
- `--reason` — required, and written to the record. Local paths in it are scrubbed first.

## Outputs

- `.sdlc/gates/<proposal>.yaml`, committed on the proposal's branch and on `main`, both as the
  pipeline:

  ```yaml
  gate: G3
  verdict: withdrawn
  by: tech-lead
  held_by: human
  note: its rows came from a run whose target could not be reset
  at: 2026-01-01T00:00:00.000Z
  ```

  The branch copy is what `sdlc rule --pending` and `sdlc next` read to decide a proposal is no
  longer open. The copy on `main` keeps the proposal's number taken, so the next proposal of the
  family is numbered after it, and puts it in the state site's table of rulings. `held_by` is
  derived the way a ruling's is (`src/lib/seat.mjs`).
- A run-record line, `withdraw <proposal> at <gate> by <seat>: <reason>`, in the same commit on
  `main`.
- To stdout: `<proposal>: withdrawn at <gate> by <seat>; it is no longer open, and nothing it
  asked was answered`.

`withdrawn` is none of the verdicts a reader acts on. It approves nothing, so nothing is merged
and no condition becomes owed. It returns nothing, so no stage is sent back. It is not an
escalation, so nobody is waiting on it. A calibration family's next run applies nothing from it
and asks its question afresh, over whatever rows are then on file.

## Workspace the agent sees

None. `withdraw` is a command, not an agent turn.

## Checks that block

- The proposal branch exists.
- The tree is clean and HEAD is on `main`.
- The proposal is open: no gate file on its branch or on `main`, or only one recording an
  escalation, which a person still owes an answer to. A proposal already approved or returned
  is refused (`<proposal> is already ruled: <verdict>`).
- The proposal page on the branch has a `gate:` line, and the branch's policy has that gate.
- `--by` is one of the seats listed under Inputs.
- `--reason` is not empty.

## Exit criterion

Exit 0 once both commits have landed and HEAD is back on `main`. Any refusal above exits 1 and
changes nothing.

## Re-run behaviour

A second `withdraw` of the same proposal is refused as already ruled, since its gate file now
records `withdrawn`.

## Failure modes

- The commit on the branch fails: HEAD is put back where it was, and the failure is reported.
  Nothing is written on `main`.
- The branch commit leaves the tree dirty: HEAD stays on the proposal branch, so the residue is
  visible where it was made, and the command says so.

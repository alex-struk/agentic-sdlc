# 0083 · A rebind limit counts per application build

Status: accepted · 2026-10-01

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A verify of a build slice files each row its suite found unbound on the new target as owed to
`bind-adapter --target new`, stamped with the slice, while the binding has been sent for that row
fewer times than `policy.loops.rebind` allows (`docs/decisions/0075-what-a-verify-charges-to-the-build.md`).
The count is `sends` over every rebind entry ever filed for the row, open or closed
(`src/spec/owed.mjs`). Past the limit the row is no longer owed, and the build is ruled as any
build that did not pass.

The new target's adapter does not look at the page for a member it marked unbound. It throws the
reason it recorded when it was bound (`tests/adapters/new/bindings.yaml`, `index.ts`), whatever
the application now serves. Only a binding run against the current application replaces that
reason.

A slice's first build can lack a screen its criteria need. Its verify finds the rows unbound and
files them; the binding runs against that build, finds nothing, and the sends are spent. The
builder then adds or fixes the screen in a revision. The next verify reports the same rows unbound
with the reasons recorded against the earlier build, such as `Page not found` for a route the
current router defines, and owes no rebind because the row's sends are spent. The build is charged
for the adapter's stale reasons, returned, and eventually escalated, and nothing changes until a
person orders a binding by hand.

The limit exists to stop a binding loop: `bind-adapter` sent again and again to the same
application, writing the same reasons back. A binding against an application that has changed
since the last send is not that loop.

## Decision

**A rebind entry a verify files records the application it measured.** Verify already records the
`app` tree of the build branch as `app_tree` on its result (`tests/results/new/slice-<n>.json`).
Each rebind entry it files carries the same value as `app_tree`, beside `slice`.

**The limit counts the sends made against that application.** When a verify settles its rows
(`syncUnbound`, `src/spec/unbound.mjs`), a row is owed while it has been sent fewer times than
`policy.loops.rebind` allows, counting only entries stamped with the `app_tree` it measured and
entries stamped with none. A new build of the application earns the binding its sends again; the
same build re-measured at the limit is still refused. The over-limit check every gated run makes
(`src/runner/owed-limits.mjs`) counts a handed entry that carries an `app_tree` the same way, so the
first send against a new build is not escalated as the third send overall.

**A send that names no application counts against every build.** Entries filed before verify
recorded the application keep counting as they did.

**Calibration is unchanged.** Calibration measures the oracle's fixed application and passes no
tree, so every send counts toward the limit, including any a verify stamped.

## Consequences

- A slice whose screen arrives in a later build is offered `bind-adapter --target new` again by
  `next`, with the `sandbox up --from` step it needs, instead of having its build charged for the
  adapter's stale reasons.
- The number of binding runs a slice can be owed grows with its builds: up to
  `policy.loops.rebind` per build. Builds are themselves bounded by `policy.loops.verify_returns`,
  so the total stays bounded.
- An entry's `app_tree` is read by the limit alone. `next`'s routing of a rebind
  (`docs/decisions/0079`, `0080`) and drive's choice of the branch to start the sandbox from
  (`bindingBranch`, `docs/decisions/0078`) read the slice and the adapter as before.
- A row whose sends were spent by entries that name no application stays spent on every build,
  and waits on a ruler as before.

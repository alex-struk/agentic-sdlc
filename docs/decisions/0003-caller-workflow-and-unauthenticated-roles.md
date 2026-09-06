# 0003 — The checkpoint caller, and roles as assertions in phase 0

**Status:** accepted · 2026-09-06

Two choices in phase 0 look like gaps if you read them against the finished
pipeline. Both are deliberate, both are consequences of there being no remote
repository yet, and both change when one exists.

## The checkpoint caller is a pinned `npx` invocation, not a reusable workflow

**Decision.** `templates/workflows/sdlc-checkpoint.yml` runs the pipeline's own
checks with `npx --yes github:<repo>#<commit> checks --json`, where `<commit>` is
the commit `sdlc init` recorded in the project's `.sdlc/lock.json`. It is not a
GitHub reusable workflow (`uses: <repo>/.github/workflows/x.yml@<tag>`).

**Why.** A reusable workflow has to be resolved by GitHub from a repository that
exists and that the calling repository can read. The pipeline repository has no
remote yet, so there is nothing for `uses:` to name. An `npx` invocation is
resolvable the moment a remote appears, and until then it is at least honest
about what it would run.

**Why a commit and not a tag or a branch.** The lockfile's whole purpose is to
say which version of the pipeline a project is running, and a commit is the only
pin it can make that cannot move underneath the project. A tag can be moved; a
branch moves by design. The configured `ref` is still recorded — it is what the
next `sdlc init` resolves against — but the workflow runs the commit.

**What changes later.** Once the pipeline has a remote and tagged releases, a
reusable workflow referenced by tag becomes available and is the better shape:
it is cacheable, it shows up in GitHub's own dependency views, and it does not
re-install the pipeline on every run. Moving to it is a change to the template
and to `init`'s substitution, not to anything a project holds.

## `--by <role>` is an assertion, not an authenticated identity

**Decision.** `sdlc rule <name> approve|return --by <role>` checks that the role
given is the gate's `holder` or its `escalate_to`, and records it in
`.sdlc/gates/<name>.yaml` along with whether the gate was held by a human or an
agent. It does not verify that whoever ran the command is that role. Rulings are
committed by the runner's own git identity (`sdlc <sdlc@localhost>`) and are
unsigned.

**Why.** Gates in phase 0 are local branches merged on the same machine that
opened them. There is no second party in the loop to authenticate against: no
remote to push to, no pull request to approve, no code owners file to consult,
and no key infrastructure for signing. A role check with no authentication
behind it is still worth having — it catches the wrong gate holder ruling by
mistake, which is the common error — but it stops a mistake rather than an
impersonation, and the record should not read as though it stops more.

**What changes later.** Authentication arrives with the remote, and it arrives
as the platform's own: a `CODEOWNERS` file naming who may approve which paths,
and pull-request approval as the act that records the ruling. At that point
`--by` becomes a label on a decision whose author GitHub has already
authenticated, and the `held_by` field keeps its separate meaning — whether a
person or an agent made the call.

**Read the gate log accordingly.** `site/gates.md` marks agent-held rulings
`agent-held, unsampled` for the same reason: it is a record of what was
asserted, and phase 0 has nothing behind the assertion but the record itself.

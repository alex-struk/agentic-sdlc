# Stage: `doctor`

## Purpose

Check that the local machine and the target project have what the pipeline needs: required and
optional tools, the agent backends the project's turns run on, the agent deny list, the egress name
list, and a valid configuration.

## Inputs

`sdlc doctor [dir]`, defaulting to the current directory.

## Outputs

To stdout, one line each for:

- `node` and `git` (required), and `gh`, `claude`, `docker` (optional) — found/not-found and
  version.
- Whether `<dir>/.claude/settings.json` has a deny rule starting `Bash(git push`, used as a proxy
  for "the deny list from `sdlc init` is present".
- The egress name list's state (`missing`, `empty`, or `<n> names`) and the path it resolved to:
  `SDLC_EGRESS_NAMES` if set, otherwise `<XDG_CONFIG_HOME>/agentic-sdlc/egress-names.txt`, with
  `XDG_CONFIG_HOME` defaulting to `~/.config`.
- Whether `SDLC_SANDBOX_PASSWORD` is set — never its value. A `sandbox-idp` target signs in by
  filling a real form with it, and `bind-adapter` and `calibrate` both refuse such a target
  without it; a project with no `sandbox-idp` target never needs it, so an unset variable is a
  warning rather than a failure.
- The result of `checkConfig(dir)` (see `docs/stages/checks.md`).
- The agent backends the project's turns run on, resolved from `policy.agents` and any
  `SDLC_AGENT_BACKEND`/`SDLC_AGENT_MODEL` in the environment (`docs/config.md`):
  - `agents <backend> runs …; model: …` — one line per backend in use, naming the stages (of the
    project's profile, with an agent turn) and the gates (with an `agent:` holder) it runs, and the
    models configured for it; "the CLI's default model" where none is.
  - `<backend> <version>, <sign-in>` — one line per backend in use: whether its CLI is on the
    machine, and whether it is signed in. For `claude`, whether a sign-in is present in the
    pipeline's config home; for `codex`, what `codex login status` says against the pipeline's own
    Codex home, reduced to "signed in with ChatGPT", "signed in with an API key" (a warning: the
    pipeline signs in with ChatGPT only) or "not signed in". Nothing the CLI prints about an
    account is repeated, and no credential is opened. A CLI that is missing is reported with the
    command that installs it.
  - `codex refuses <stage>` — one line per stage set to run on Codex on the host that Codex will
    refuse (`docs/decisions/0060-a-second-agent-backend.md`), with the setting that accepts it.
  - `stage <name>: <backend>, in a container (<setting>), egress <list>: <hosts>` or
    `stage <name>: <backend>, on the host` — one line per stage, and `ruling <gate>: …` for each
    ruling that runs in a container (`docs/decisions/0061-an-agent-session-in-a-container.md`). A
    stage set to run in a container that cannot be isolated is a warning saying why.
  - Where any turn runs in a container: whether Docker answers (a warning naming the turns that will
    be refused when it does not), whether the agent image for each backend and the egress proxy
    image are built (a warning when not: they are built on first use, or by `sdlc isolation build`),
    and a warning when a run that did not finish left session containers behind, which
    `sdlc isolation clean` removes.
  - A warning when `SDLC_AGENT_BACKEND` is set, since it overrides the project's choice for every
    turn run from that shell.
- Whether the project's persona briefs are current with the pipeline's templates, naming each one
  that is behind or carries local edits (`docs/stages/init.md`). A brief that is behind rules by
  instructions the pipeline has since corrected while reading as a complete brief, so it is
  reported here; it is a warning, never a failure.

## Workspace the agent sees

No agent.

## Checks that block

For the exit code only: `node` and `git` must both be found, and the config check must be `ok`.
The deny-list line, the egress-name-list line, the sandbox-password line, the persona-briefs line,
the agent-backend lines, and the optional tools (`gh`, `claude`, `docker`) are reported but do not
affect the exit code: a machine may check a project whose turns it never runs.

## Exit criterion

Exits 0 only when node, git and config all check out; otherwise 1. Every line is printed
regardless of the final exit code, so a failing run still shows the full report.

## Re-run behaviour

Idempotent, and writes nothing to the project. Checking a backend's sign-in prepares that backend's
config home outside the project (`ensureConfigHome`, `ensureCodexHome`) exactly as a stage would
before its first turn, so the sign-in checked is the one a stage will use. Safe to run repeatedly,
including immediately after `sdlc init`.

## Failure modes

- `node` or `git` not found on `PATH`: fails the required-tools check.
- `.sdlc/config.yaml` missing or invalid: reported through the config line's message.
- The deny rule is missing from `.claude/settings.json`: reported as a warning suggesting
  `sdlc init` be re-run.
- The egress name list is missing or empty: reported as a warning naming the file to fill in.
- A backend in use is not installed or not signed in: reported as a warning with the command that
  fixes it.

# 0060 · A second agent backend

Status: accepted · 2026-09-25

## Context

Every agent turn the pipeline runs — a stage's work, a repair turn, a persona's ruling, the
one-turn sign-in check — was a Claude Code session: `claude -p`, isolated in a config home the
pipeline owns (`0004`), signed in with the operator's own login (`0035`), held to the stage's tool
allowlist and the project's deny list and implement guard. A project needs to be able to run that
work on the OpenAI Codex CLI instead, choose which turns run where, and see afterwards which
engine did any given piece of work.

The two CLIs do not offer the same controls. Claude narrows a session's tools per call
(`--allowedTools`), caps its turns (`--max-turns`), reads the project's `.claude/settings.json`
deny list and `PreToolUse` hook, and reports cost in dollars. Codex offers none of those in the
same form. This record says how each Claude mechanism is carried over, what holds on Codex and why,
and what does not.

## Decision

### 1 — One interface, two backends

`BACKENDS` in `src/runner/executor.mjs` holds `claude` and `codex`, each with the same members: the
binary it spawns (`SDLC_CLAUDE_BIN`, `SDLC_CODEX_BIN`), the home it prepares, the arguments for one
turn, how its output is read, the paragraph a failed sign-in is given, how its sign-in is checked
without spending a turn, and a line describing it. `runAgent` spawns whichever the turn names and
knows nothing else about either. The `claude` backend passes exactly the arguments it always has,
with `--model` added only when a model is configured. `SDLC_EXECUTOR=mock` stands in for both.

### 2 — Which turns run where is policy

`policy.agents` in `.sdlc/config.yaml` names a default backend and model, with entries per stage
and per ruling (by gate, then by persona, a gate's entry being the more specific). An operator
overrides it for one run with `SDLC_AGENT_BACKEND` and `SDLC_AGENT_MODEL`. A model belongs to the
backend it is written beside: a layer that changes the backend and names no model leaves the CLI
to choose one (`src/runner/agents.mjs`, `docs/config.md`).

It is under `policy` because it changes who does the work, which is the same kind of decision as
who holds a gate. A proposal that changes it is therefore ruled at G-POL, under `main`'s policy
(`0043`), with no routing of its own. The environment override is for an operator trying a run; it
changes nothing on disk, and every record of the turn says what it chose.

### 3 — A Codex turn

The flags are those `codex exec --help` lists for `codex-cli 0.157.0`, and the `-c` keys are
configuration keys the same CLI reads:

| Argument | Why |
|---|---|
| `exec … -` | Non-interactive, with the prompt read from stdin, for the reason the Claude prompt is: a G3 ruling's prompt is larger than one argument may be. |
| `--json` | The session's events as JSONL: `thread.started` carries the session id, `item.completed` the agent's messages and actions, `turn.completed` the token usage, `turn.failed` and `error` the CLI's account of a failure. |
| `--sandbox read-only` / `workspace-write` | Read-only for a turn whose allowlist names no editing tool — a ruling, the sign-in check — and workspace-write otherwise. |
| `-c sandbox_workspace_write.network_access=true` | Only for a writing stage whose allowlist grants a shell: the shell exists to reach something (a package registry, the oracle), and the workspace sandbox has no network unless granted. |
| `-c approval_policy="never"` | Nobody is there to approve. A command outside the sandbox fails and the session is told, rather than waiting. |
| `--model` | Only when a model is configured. |
| `-c developer_instructions=…` | The stage's skill, with an index of the skills under `.claude/skills/` in the workspace (name, description, path), so a session reads the project's skills where they already are. Refused above 100,000 bytes, below the one-argument limit. |
| `-c mcp_servers.<name>.command=…`, `.args=…` | The stage's MCP servers. A server needing environment values is refused rather than given them on the command line. |
| `--ephemeral`, `--ignore-user-config`, `--skip-git-repo-check` | No session persisted; no `config.toml` read even if one appears in the home; an ephemeral workspace is an extracted archive, not a repository. |
| `--dangerously-bypass-hook-trust` | Codex runs no hook it has not been told to trust. The one hook in the pipeline's Codex home is the one the pipeline wrote (§4). |

The working root is the child's cwd, set to the stage's workspace, so no local path is on the
command line. `OPENAI_API_KEY` and `CODEX_API_KEY` are removed from the session's environment: the
pipeline signs in with the operator's ChatGPT subscription and never with a key.

The home is `CODEX_HOME`, pointed at a directory the pipeline owns
(`$XDG_CONFIG_HOME/agentic-sdlc/codex-home`, or `SDLC_CODEX_HOME`). It holds `auth.json`, a link to
the operator's own (`$CODEX_HOME/auth.json` or `~/.codex/auth.json`, or `SDLC_CODEX_CREDENTIALS`),
under the rules `0035` set for Claude's: `0700`, a refreshed credential kept while it is newer than
the source, a newer source taking over. Nothing opens it.

A successful session's text is its last agent message. Its turn count is the number of actions it
reported (messages, commands, file changes, tool calls), which is the nearest thing Codex reports
and not the same unit as Claude's turns.

### 4 — The implement guard reaches a Codex session through its hook

Codex has a `PreToolUse` hook with Claude's wire format: the tool's input as JSON on stdin, exit 2
with a reason on stderr to refuse. The pipeline writes `hooks.json` into its Codex home registering
the project's own guard, `.sdlc/hooks/implement-guard.sh`, relative to the session's working root.
The hook runs where the guard is — the project and `with-sources` workspaces, which is where it runs
for a Claude session too — and passes where it is not. Codex runs a hook from that directory only
with `--dangerously-bypass-hook-trust`, and a hook runs with the session's working root as its cwd
and its environment, including `SDLC_STAGE`.

A Codex session edits through a patch rather than through tools that name one path, so the guard
reads every path any `*** Add File`, `Update File`, `Delete File` or `Move to` header in the tool's
input names — the patch as a string, or a shell command carrying one — besides the path a Claude
edit tool names, and refuses the call when any is outside the stage's territory. The hook has no
matcher, so a non-edit tool that names a `path` in the stage's blocked territory is refused too.

### 5 — Codex has no turn cap; the runner stops the session

A Codex turn is stopped at a wall-clock ceiling of thirty seconds per turn the stage is allowed,
never less than two minutes, and reported as a failed turn ending `wall_clock_limit`. `policy.turns`
sets it for Codex through the same number it sets Claude's `--max-turns` with.

### 6 — What ran the work is recorded with the work

Every turn returns `engine`: the backend, the model and the CLI's version. The model is the one the
CLI reports having used — Claude's result names every model a session called, and the costliest is
the one that did the work — otherwise the one configured, otherwise empty, which is shown as "the
CLI's default model". Codex's event stream names no model, so a Codex record names the configured
one or says the CLI chose; a project that wants the model on the record configures it.

It is written to the run-record line, the journal's front matter (`backend`, `model`, `cli`), the
proposal page a stage opens (front matter and a **Worked by** line), an agent ruling's gate file and
the **Ruled on** line it appends to the proposal, and shown on the state site beside the seat —
"persona agent · codex *model*" — and on the journal and proposal pages. `src/lib/engine.mjs` is the
one vocabulary for all of them, as `src/lib/seat.mjs` is for seats. A person's ruling and the
runner's verdict ran on no agent and name none (`0040`).

### 7 — A stage that declares a tool allowlist runs on Codex only when the project says so

`codexRefusal` refuses, with the pre-checks and before anything is spent, a stage set to run on
Codex whose Claude configuration names a tool allowlist, unless the project sets
`policy.agents.stages.<stage>.accept_weaker: true`. The refusal names what the stage would lose. The
environment override cannot lift it. Today that is `contract`, `bind-adapter`, `derive-tests`,
`design`, `plan` and `build`; `intent` and `archaeology` run on Codex as configured, and so does
every persona ruling. `sdlc doctor` lists each stage Codex will refuse.

## The guarantees, one by one

| Guarantee | On Claude | On Codex | What still holds on Codex | What does not |
|---|---|---|---|---|
| **A ruling writes nothing** | Read-only allowlist; the clean-tree check after the turn | Read-only sandbox | The sandbox refuses every write at the operating system; the clean-tree check runs as before. | Nothing: this is at least as strong. |
| **A blind stage reads only its workspace** (`derive-tests`, `bind-adapter`, `design`, `plan`) | No shell; the file tools read inside the workspace | A full shell; the sandbox limits writes, not reads | The workspace is still built from `git archive` of only its context, sealed, and checked for drift; only `collect` paths come back; post-checks and scope checks run. What the session can *write* is confined to the workspace. | What the session *reads*. It could open the application or the acceptance suite by absolute path, and nothing records that it did. Refused by default. |
| **A narrowed shell runs only its commands** (`build`: `npm`, `npx`, `node`, `ls`, `mkdir`; `contract`: the oracle, `docker logs`, `curl`) | `Bash(<pattern>)` entries are the whole grant | Any command, with network granted | Writes confined to the workspace (`build`) or the project tree (`contract`), with the guard's territory where it runs; collect, drift, post-checks. | Which commands run. With the network the stage needs, a push, a publish or a deploy is limited only by what credentials the machine exposes. Whether the sandbox lets a session reach the Docker socket was not established. Refused by default. `build`'s `Bash(node *)` already runs arbitrary code on Claude, so for `build` the loss is of the narrowing rather than of containment. |
| **The project's deny list** (`.claude/settings.json`: no `git push`, `git reset --hard`, `npm publish`, `kubectl`, reading `.env` …) | Read by every session in a workspace that carries it | Not read | A stage with no network grant cannot reach a remote; a ruling cannot write. | The list itself. A Codex session in a project workspace could run `git commit` or `git reset --hard` in the project; the runner's clean-tree and scope checks see a changed tree, not a moved `HEAD`. |
| **The implement guard** | `PreToolUse` hook from the project's settings | `PreToolUse` hook from the pipeline's Codex home (§4) | The same script, the same table, the same workspaces. | Its coverage of Codex's own tool names is taken from Codex's patch format and was not observed from a signed-in session. A write through a plain shell command (`echo > path`) passes on either backend. |
| **A turn cap** | `--max-turns` | None | A wall-clock ceiling derived from the same setting (§5). | A cap in the unit the policy is written in. |
| **Cost** | Dollars per session | Tokens only (a subscription) | Token usage is kept on the turn's raw result. | Journals and gate files record a Codex turn's cost as 0, so the state site's totals count Claude's spend only. |
| **Sign-in, and never a key** | Operator's login linked into the config home | Operator's ChatGPT sign-in linked into the Codex home | The same keep-if-newer rules; key variables removed; `doctor` reports an API-key sign-in as a warning; a one-turn check before each stage and ruling. | — |

## What was established, and how

The flags are from `codex --help`, `codex exec --help`, `codex login --help`, `codex login status
--help` and `codex doctor --help`, for `codex-cli 0.157.0`. The event names of a failing session
(`thread.started`, `turn.started`, `error`, `item.completed`, `turn.failed`) and the CLI's exit code
were observed from a session that could not sign in. A session run through `runAgent` against a
signed-in CLI, in a read-only sandbox, returned `ok`, its reply, one step, a session id, the CLI's
version and its token usage, which establishes the success path (`turn.completed` with `usage`,
`item.completed` with an `agent_message`). That a hook in `CODEX_HOME/hooks.json` runs only with
`--dangerously-bypass-hook-trust`, alongside `--ignore-user-config`, with the session's working root
as its cwd and `SDLC_STAGE` in its environment, was observed with a `SessionStart` hook. The
`PreToolUse` input and output schemas are the ones the binary carries.

Not established: which tool names and inputs a signed-in Codex session hands its `PreToolUse` hook
when it edits a file; whether the sandbox reaches the Docker socket; and the Codex model a session
used when none is configured.

## Consequences

- A project runs every stage with no allowlist, and every ruling, on Codex with one line of
  configuration, and every other stage on Codex by accepting it stage by stage.
- Every record of a turn says what ran it, and the state site shows it beside the seat.
- The Codex home holds the sign-in link, the one hook the pipeline registers, and whatever state
  the CLI keeps for itself; the pipeline writes nothing else into it.
- `sdlc new --interactive` and `--answers` run the onboarding interview on `claude` before any
  project configuration exists, and are outside this choice.

## What was considered instead

**Writing the skill into an `AGENTS.md` in the workspace.** Codex reads one, but a project-mode
workspace is the project itself: the file would be a change in the project's tree that every scope
check counts as the agent's, and it would sit on top of any `AGENTS.md` the project keeps. Developer
instructions carry the same text without touching the tree.

**Refusing only the stages with no shell.** It leaves `build` and `contract` on Codex with network
and a full shell and without the deny list, and says nothing about it. A stage whose Claude
configuration narrows what it may run depends on that narrowing, whichever way it narrows it.

**A per-run Codex home.** It would keep concurrent runs' hooks apart, but a credential refreshed
into a home that is deleted after the run is the defect `0035` exists to prevent.

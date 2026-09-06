# 0004 — Stage sessions run isolated, not `--bare`

**Status:** accepted · 2026-09-06

A stage's agent session (`runAgent` in `src/runner/executor.mjs`) is a plain `claude -p` call, the
same binary an operator runs interactively — but it must never load what an operator's own
interactive session loads. This record says what that is, why it matters for a pipeline stage
specifically, and the mechanism `ensureConfigHome` and the flag set in `buildArgs` use instead.

## What a plain headless session loads, and why a stage session must not

Left to its defaults, `claude -p` reads the operator's `~/.claude` (or wherever
`CLAUDE_CONFIG_DIR` already points): every installed plugin, including any that register their own
session-start or stop hooks; every configured MCP server, each one a live process the session can
call out to; a global instructions file merged into the system prompt ahead of anything the
pipeline supplies; and stop hooks that fire when the session ends. None of that is under this
pipeline's control, none of it is declared anywhere a stage's contract or a project's checks can see
it, and all of it can change what the session does or says without a single line of the pipeline
changing. A stage's work is meant to be reproducible from the stage's own skill text, the project's
own checks, and nothing else — an operator's personal plugin picking a different tool, or a global
instructions file steering the session toward a habit that has nothing to do with the project, is
exactly the kind of variance a pipeline stage cannot afford to inherit. It also means a stage
session running under one operator's machine cannot be told apart, by anything the pipeline
produces, from the same stage running under another's — which is the point: the pipeline's record of
what a stage did should not depend on whose laptop ran it.

**Why an MCP server specifically is worse than the rest.** A plugin or a global instructions file
changes what the session *thinks*; a live MCP server is something the session can *call*, with
whatever the server happens to expose — write access to a personal task tracker, a mail account, a
notes corpus — folded into a stage session that a project's own deny list and guard hook were never
written to account for. `--strict-mcp-config` (no config passed, so the session loads none of them)
closes that specific door regardless of anything else.

## Why `--bare` is unusable here

`claude --bare` looks like the obvious answer — it skips hooks, plugin sync, auto-memory,
attribution and `CLAUDE.md` auto-discovery in one flag — but it also restricts how the session can
authenticate: with `--bare`, Anthropic auth is strictly an `ANTHROPIC_API_KEY` environment variable
or an `apiKeyHelper` supplied through `--settings`; the OAuth token and the OS keychain a
subscription login relies on are never read. This pipeline authenticates the way an operator already
does on their own machine — a `claude` subscription login, not a separate API key provisioned for
the pipeline — so `--bare` would make every stage session fail to authenticate at all. Isolation has
to come from somewhere that does not touch how the session logs in.

## What the pipeline's config home contains

`ensureConfigHome()` (`src/runner/config-home.mjs`) points `CLAUDE_CONFIG_DIR` at a directory that
holds exactly one thing: `.credentials.json`, a symlink to the operator's real credentials file
(`~/.claude/.credentials.json`, or `$SDLC_CREDENTIALS` when set — the test suite points this
elsewhere so it never touches a real machine's credentials). Nothing else lives there: no plugins,
no MCP configuration, no global settings, no `CLAUDE.md`. The directory itself defaults to
`$XDG_CONFIG_HOME/agentic-sdlc/claude-home` (`~/.config/agentic-sdlc/claude-home` when
`XDG_CONFIG_HOME` is unset), overridable with `$SDLC_CLAUDE_HOME`, and is created — along with a
fresh symlink, if the previous one is stale — on every call. Pointing an entire config home at a
directory this empty is what lets the session authenticate exactly the way an interactive session
would (the same OAuth credentials, read through the same symlink) while genuinely loading nothing
else: there is nothing else in the directory *to* load.

## The rest of the isolation: flags, and what still applies

Beyond `CLAUDE_CONFIG_DIR` and `--strict-mcp-config`, `buildArgs` sets:

- `--permission-mode acceptEdits` — the session can edit and run commands without a human in the
  loop approving each one, which is what makes an unattended headless stage possible at all; nothing
  here weakens what it is allowed to touch (see below).
- `--no-session-persistence` — the session's transcript is not saved to disk and cannot later be
  resumed with `claude --continue` or `--resume`; a stage's record is the journal entry and the
  files it left behind, not a saved conversation.
- `--max-turns <n>` — a hard ceiling on how long a single stage session can run, derived from
  `config.policy.budgets[<stage>]` by `turnsFor` (`src/commands/run.mjs`); a stage cannot spin
  indefinitely against its cost budget.
- `--append-system-prompt-file <path>` — the stage's skill text (the pipeline's own preamble plus
  the stage's own instructions), the only extra system-prompt content a stage session receives, read
  from a scratch file written fresh for this run and deleted when it finishes.

**What isolation does not remove.** The project's own `.claude/settings.json` — the deny list
blocking `git push`, `git merge`, destructive git operations, reading secrets, and more (see
`docs/stages/init.md`) — and `templates/hooks/implement-guard.sh`, registered as that project's own
`PreToolUse` hook and reading the `SDLC_STAGE` environment variable the executor sets to confine
each stage's edits to the paths it owns, both live inside the project directory itself and load
normally: isolating the *operator's* configuration does not touch the *project's*. A stage session
is confined by what the project says it may do, not by having no configuration at all.

**The runner never pushes.** No command in this pipeline — not a stage's agent session, not
`sdlc rule`'s persona turn, not `finishStage`'s own commits — ever runs `git push`. Every commit
`sdlc run`, `sdlc propose` and `sdlc rule` make lands on a local branch (`main` or a
`proposal/<name>` branch) in the project's own working tree; getting that history to a remote is a
step outside anything this pipeline runs, and `Bash(git push*)` is denied to every agent session
regardless.

## What changes later

A token-denominated budget (`docs/superpowers/plans/2026-09-06-phase-1a-runner.md` notes
`--max-turns` as a phase 1a stand-in for a real token-to-turn conversion) would change what
`turnsFor` computes, not this isolation contract. A CI executor running in a cloud environment
rather than a person's own machine removes the credentials-symlink half of `ensureConfigHome`
entirely — there is no personal OAuth session to isolate *from* on a machine that never had one —
but the rest (no plugins, no MCP servers, no global instructions, the project's own deny list and
guard hook) stays exactly this shape.

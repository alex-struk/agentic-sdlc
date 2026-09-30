# 0077 · A browser session signs in without seeing the password

Status: accepted · 2026-09-30

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

`bind-adapter` binds a target by driving a browser through the Playwright MCP server, in a session
with no shell (`docs/stages/bind-adapter.md`). A target whose identity is `sandbox-idp` signs in
through an identity provider's form, and the password for that form is `SDLC_SANDBOX_PASSWORD`,
which reaches the session only as an environment variable. A session without a shell cannot read
an environment variable, and it must not type a password it was not given. So a session binding a
`sandbox-idp` target could not get past the sign-in form: every binding behind sign-in was written
without seeing the signed-in page, and build slices that relied on those bindings failed verify.

The rule this pipeline holds for every credential applies to the fix: a credential never goes into
a file on disk, a log line, a command argument, a prompt, a run record, a gate file or a commit
message. It reaches a process through its environment and nowhere else.

The Playwright MCP server (`@playwright/mcp`, pinned at 0.0.80) takes `--secrets <path>`, a dotenv
file it reads once when it starts. Where a tool argument the session passes to `browser_type` or
`browser_fill_form` is exactly a secret's name, the server types the secret's value instead. Every
tool response is redacted: the value is replaced with `<secret>NAME</secret>` wherever it appears,
so a snapshot, an evaluated expression or a network log shows the name and never the value.

## Decision

**A stage may declare `mcpSecrets(ctx, config)`,** returning `{ server, values }`: the MCP server
the stage's `mcp` declares that is to be given secrets, and the secrets by name. `bind-adapter`
declares it for a `sandbox-idp` target only, with `SDLC_SANDBOX_PASSWORD` read from the runner's own
environment.

**The secrets reach the server through a named pipe, not a file.** Both places a session's MCP
config is written, a stage's first turn and its repair turn, create a FIFO with mode 0600 in the
turn's private scratch directory, append `--secrets <fifo>` to that server's arguments, and write
the MCP config naming the FIFO's path (`src/lib/secret-pipe.mjs`). The runner offers the dotenv text
to whoever opens the FIFO for reading, for as long as the session runs, so a server restarted
mid-session reads it again; the FIFO is closed and removed with the scratch directory when the turn
ends. A FIFO has a path and no content: what is written into it is held in a kernel buffer until the
reader takes it, and nothing is written to disk. An empty value opens no pipe and adds no argument.

**The session types the variable's name.** The prompt tells a `sandbox-idp` session to type the
literal text `SDLC_SANDBOX_PASSWORD` into the identity provider's password field, that the browser
tool substitutes the real password and shows it back as `<secret>SDLC_SANDBOX_PASSWORD</secret>`,
and to type nothing else there. The adapter it writes reads the password from
`process.env.SDLC_SANDBOX_PASSWORD` at run time, as every later stage runs it.

## Consequences

- A `bind-adapter` session sees the signed-in application, so bindings behind sign-in are made
  against what the application shows rather than inferred.
- The password is in the runner's environment, the session's environment (`stage.env`, for the
  adapter it runs) and the MCP server's memory. It is not in the prompt, the MCP config, the
  command line of any process, the session's context or any file.
- `mkfifo` is a Linux and macOS tool, so a stage that declares `mcpSecrets` runs on those hosts
  only. `bind-adapter` already runs on the host and never in a container
  (`docs/decisions/0061-an-agent-session-in-a-container.md`).
- A value that no dotenv quoting reproduces exactly, one holding a line break or all three kinds of
  quote, is refused before the session starts, naming the variable and not the value.
- **Why not a temporary file.** A file mode 0600, deleted after the turn, is still a credential
  written to disk for the length of a session, and the rule has no exception for a short one.
- **Why not a saved browser session.** Playwright's `--storage-state` would let the runner sign in
  once and hand the session its cookies. Those cookies are session tokens, and the storage-state
  file that carries them is a credential on disk.

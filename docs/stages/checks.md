# Stage: `checks`

## Purpose

Run the structural checks that decide whether a project (or the pipeline repository itself) is in
a valid state. The same checks run locally and are what continuous integration runs on a pull
request.

## Inputs

`sdlc checks [dir] [--self] [--json]`. `dir` defaults to the current directory. `--self` runs only
the egress check, over every tracked text file in the pipeline repository except
`node_modules/`, `package-lock.json`, `.superpowers/` and `docs/superpowers/`. The scope is an
exclude list rather than a list of directories to include, so a file added somewhere new is
scanned by default instead of being silently skipped. `--json` prints the raw results array
instead of the formatted text.

## Outputs

To stdout: one line per check id (`config`, `layout`, `constitution`, `criteria`, `egress`, or just
`egress` under `--self`) marked `ok` or `FAIL`, with any messages and warnings indented beneath —
or the same data as a JSON array under `--json`. Nothing is written to disk.

## Workspace the agent sees

No agent.

## Checks that block

- **config** — `.sdlc/config.yaml` exists, parses, validates against `schema/config.schema.json`,
  and its `profile` is one of the four known profiles.
- **layout** — every path required for the configured profile's stage list exists: `constitution.md`,
  `.sdlc/config.yaml`, `.sdlc/lock.json`, `intent/`, `spec/`, `spec/features`, `spec/domains`,
  `spec/contract`, `plan/`, `app/`, `evidence/pr-evidence.md`, `tests/acceptance`, `tests/adapters`,
  `tests/seed`, plus `design/` when the profile's stages include `design`.
- **constitution** — `constitution.md` exists, has no unfilled `{{placeholder}}`, has at least one
  `### P<n>` platform article, and every such article has a `Source:` line that is either the
  literal word `convention` or an `http(s)://` URL.
- **criteria** — runs only when `spec/domains` exists on disk (a project that has not reached
  archaeology yet has nothing here to check). Fails on: a parse error in any `spec/domains/*.md`
  file (a malformed heading, an unknown bullet key, a heading ID whose domain does not match the
  file it lives in, an out-of-vocabulary `state`/`reconciliation`/`tier` value, or a repeated
  single-value bullet key); the same criterion ID appearing in two domain files; a `recovered`
  criterion with no `cites`; a `cites` path that does not exist under `sources/old` (a warning
  instead, when `sources/old` is not present to check against); a criterion whose `state` is
  `accepted` while its `confidence` is still `inferred` or `open`; and a `defect` reconciliation
  with neither a `replaces` nor a note. See `docs/spec-format.md` for the format itself.
- **egress** — every tracked, text-typed file (skipping `.sdlc/packs/`, and any path git still
  tracks but that is gone from disk) is scanned line by line for ticket-number patterns,
  private-notes-folder paths, references to a private notes location or a meeting or transcript,
  local home paths (`/home/<name>`, `/Users/<name>`, `C:\Users\<name>`), and any name in the
  egress name list. A missing or empty name list is a warning, not a failure. The name list is
  read from `SDLC_EGRESS_NAMES`, then `<project>/.sdlc/egress.local.txt`, then
  `$XDG_CONFIG_HOME/agentic-sdlc/egress-names.txt` (defaulting to `~/.config`).

## Exit criterion

Exits 0 when every check's `ok` is true, else 1.

## Re-run behaviour

Pure and idempotent: reads only, writes nothing. Safe to run repeatedly and in CI without side
effects.

## Failure modes

- Missing `.sdlc/config.yaml`: fails only the config check; layout falls back to the `rebuild`
  profile's requirements since it cannot read the real profile.
- Malformed YAML or a schema violation: surfaces as one message per problem, so several issues in
  one file are all visible in a single run.
- A tracked file matching more than one egress pattern, or containing more than one listed name,
  reports one message per line per match.
- The ticket-number pattern (two to five capitals, a hyphen, two to five digits) also matches
  standards tokens written the same shape: an ISO date standard, an RFC number or a WCAG level
  written with a hyphen between the body's initials and its number all look exactly like a work
  item. The fix for a false positive is an allowlist of tokens that are known standards, not a
  weaker pattern — loosening the pattern to spare them is how a real ticket number gets through.
  (This page cannot spell those examples out, for the same reason.)

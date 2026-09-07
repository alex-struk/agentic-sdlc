# Stage: `checks`

## Purpose

Run the structural checks that decide whether a project (or the pipeline repository itself) is in
a valid state. The same checks run locally and are what continuous integration runs on a pull
request.

## Inputs

`sdlc checks [dir] [--self] [--json]`. `dir` defaults to the current directory. `--self` runs only
the egress check, over every text file in the pipeline repository except
`node_modules/`, `package-lock.json`, `.superpowers/` and `docs/superpowers/`. The scope is an
exclude list rather than a list of directories to include, so a file added somewhere new is
scanned by default instead of being silently skipped. `--json` prints the raw results array
instead of the formatted text.

## Outputs

To stdout: one line per check id (`config`, `layout`, `constitution`, `egress`, `criteria`,
`criteria-index`, `separation`, `generated`, `tests`, or just `egress` under `--self`) marked `ok` or
`FAIL`, with any messages and warnings indented beneath — or the same data as a JSON array under
`--json`. Nothing is written to disk.

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
- **criteria-index** — runs alongside `criteria`, whenever `spec/domains` exists. Fails when
  `spec/criteria-index.json` is present but no longer matches the domain files it was generated
  from, comparing each criterion's id, domain, version, confidence, state and statement — the
  fields a later stage actually reads. The index is what every stage after ratify reads *instead
  of* the domain files, so one that has drifted is worse than none at all: a stage builds against
  criteria the spec no longer holds and nothing says so. The fix is to run `sdlc run ratify
  --domain <d>`, which regenerates it. A project with no index yet passes. This is deliberately
  not part of `criteria` itself: `archaeology` legitimately leaves the index behind, since
  recovering a domain is exactly the act of adding criteria the index does not have yet, and
  ratify is the stage that catches it up.
- **separation** — runs whenever `tests/` exists. Keeps the acceptance suite blind to the
  implementation. Over `tests/adapters/**/*.ts`: fails on `expect(` (an adapter drives the page, it
  never asserts), on an import whose path contains `../acceptance` or `app/`, and on a `test(` call
  (an adapter must not define its own copy of the suite). Over `tests/acceptance/**/*.ts`: fails on
  an import whose path contains `/adapters/`, `app/` or `../../app`; on `page.` (a test never holds
  the page object); on `locator(`, `getBy`, `data-testid` or `querySelector` (a test never reaches
  for a locator); on a string literal that starts with `http://`, `https://` or a route-shaped `/`
  (a lone `"/"` is allowed); and on `goto(`. Comment lines are exempt from the locator and route
  rules only, so the provenance header every spec file carries, and prose explaining these rules,
  never trip them. `not-testable.yaml` and `attestations.yaml` are not TypeScript and are skipped.
  Messages name the file and line.
- **generated** — runs whenever `tests/` exists. Passes with nothing to check when `tests/generated`
  does not exist yet (a project before `derive-tests`). Otherwise recomputes `generateTypes` from
  the live contract (`spec/contract/*.yaml`, `tests/seed/manifest.yaml`) and compares every file it
  produces against `tests/generated/*` byte for byte — a mismatch or a missing file fails. A
  contract that fails to load is reported as a failure with its load errors, the same errors
  `loadContract` itself would raise.
- **tests** — runs whenever `tests/` and `spec/criteria-index.json` both exist; a project that has
  not ratified anything yet has no accepted criteria for a spec file's header to be checked against.
  For every `tests/acceptance/<domain>/<file>.spec.ts`: the first two lines must be exactly
  `// criterion: @<ID> v<n>` and `// provenance: <blind|unverified>, spec@<sha>, derived
  <YYYY-MM-DD>`; the ID must name an `accepted` criterion in the index; the filename must be
  `<ID>.spec.ts` for the ID in its own header; a header version lower than the index's is a warning
  (`stale`, listed in `result.stale`), not a failure, and a version higher than the index's fails. A
  file sitting directly under `tests/acceptance/`, with no domain folder above it, fails (except the
  two exemption yaml files). `not-testable.yaml` entries must name an accepted criterion with a
  non-empty reason, and an entry for a criterion that also has a test file fails.

  Provenance is verified, not trusted: a header claiming `unverified` is unverified regardless of
  git. A header claiming `blind` is checked against `git log -1 --format=%s -- <file>` — a subject
  starting with `propose(G3): derive-tests-`, `stage(derive-tests)` or `merge: derive-tests-` is
  genuinely blind; anything else, or a file with no clean committed history at all (untracked or
  with uncommitted changes), is unverified — except when `SDLC_STAGE=derive-tests`, which is the
  stage's own post-check reading its output before it has committed. At LOW/STANDARD tier (the
  criterion's own `tier`, else `policy.default_tier`) an unverified file still passes with a
  matching entry in `attestations.yaml` naming the file and a `by`; at HIGH/CRITICAL it fails
  outright, attestation or not.

  `coverage(projectDir, domain)` (exported, not a check of its own) reports a domain's accepted
  criteria split into `covered`, `missing` and `notTestable` — `derive-tests`' post-check calls it
  for the domain it just worked, and `status` renders it as the coverage board.
- **egress** — every text-typed file git tracks, plus every one it neither tracks nor ignores
  (skipping `.sdlc/packs/`, and any path git still tracks but that is gone from disk), is scanned
  line by line for ticket-number patterns, private-notes-folder paths, references to a private
  notes location or a meeting or transcript, local home paths (`/home/<name>`, `/Users/<name>`,
  `C:\Users\<name>`), and any name in the egress name list. The untracked half is what makes this
  a check a stage can run on itself: a stage's own output is uncommitted at the moment its
  post-checks run, so a leak in the seed file `contract` has just written would be invisible to a
  tracked-only scan and would reach the commit unexamined. Ignored files stay out, so
  `node_modules`, `sources/` and the acceptance harness's own results are never read. A missing or empty name list is a warning, not a failure. The name list is
  read from `SDLC_EGRESS_NAMES`, then `<project>/.sdlc/egress.local.txt`, then
  `$XDG_CONFIG_HOME/agentic-sdlc/egress-names.txt` (defaulting to `~/.config`).

  Under `--self` one further pattern applies, case-insensitively, to every scanned file
  except those under `docs/specs/` and `docs/poster/`: the name of the application this
  pipeline was first built against. The pipeline is generic, and its code, tests, fixtures
  and stage documentation must not carry the name of one engagement; the design spec that
  records that engagement and the poster drawn from it are the two places it belongs.

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
- A file matching more than one egress pattern, or containing more than one listed name, reports
  one message per line per match.
- The ticket-number pattern (two to five capitals, a hyphen, two to five digits) also matches
  standards tokens written the same shape: an ISO date standard, an RFC number or a WCAG level
  written with a hyphen between the body's initials and its number all look exactly like a work
  item. The fix for a false positive is an allowlist of tokens that are known standards, not a
  weaker pattern — loosening the pattern to spare them is how a real ticket number gets through.
  (This page cannot spell those examples out, for the same reason.)

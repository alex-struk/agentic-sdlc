# Stage: `new`

## Purpose

Create a project repository from a configuration, either supplied directly or produced by an
onboarding interview, and install the pipeline into it. This is the only way a project
repository comes into existence.

## Inputs

One of:

- `sdlc new <dir> --from <config.yaml>` — a saved, schema-valid configuration file.
- `sdlc new <dir> --interactive` — runs the onboarding interview in a Claude Code session.
- `sdlc new <dir> --answers <brief.md>` — runs the same interview against a written stakeholder
  brief instead of a person, so no one needs to be present to answer questions.

`<dir>` must not already contain a `.sdlc` folder.

## Outputs

A new git repository at `<dir>` on branch `main`, containing:

- the `templates/project` tree, copied in;
- `.sdlc/config.yaml`, the validated configuration text;
- `constitution.md`, `spec/spec.md`, `spec/contract/openapi.yaml` and `plan/tasks.md`, with
  `{{PROJECT_NAME}}`, `{{DATE}}` and, for `spec/spec.md`, `{{DOMAIN_SECTIONS}}` (one `## <domain>`
  heading per configured domain) filled in;
- one commit containing all of the above.

`new` then calls `init` (see `docs/stages/init.md`), so its outputs — the lockfile, installed
skill packs, `.claude/settings.json`, `.sdlc/hooks/implement-guard.sh`, `.gitattributes`, the CI
caller workflow, and the machine-local egress name list — follow immediately in the same run, in
a second commit.

`constitution.md` keeps its project-article placeholders after `new`: the platform articles are
filled in, but the project's own articles are left as `{{placeholders}}` for the team to write.
Until they are filled, `sdlc checks` reports the constitution check red, which is the intended
state of a freshly created project rather than a fault.

## Workspace the agent sees

No agent, unless `--interactive` or `--answers` is given. In that case a `claude -p` session is
launched with the onboarding skill text and the configuration schema as its prompt, restricted to
the `Write` tool, and told to write the finished configuration to one file next to the target
directory (`<dir>.config.yaml`, not inside `<dir>`) and nothing else. It never sees the project
directory being created, and that scratch file is deleted once `new` has read it.

## Checks that block

- `<dir>/.sdlc` already existing aborts before anything is written.
- The supplied or interview-produced YAML is parsed and validated against
  `schema/config.schema.json`; any validation error aborts before the directory is created.

## Exit criterion

Exits 0 and prints `created <dir>` once the directory is a git repository with the initial commit
and `init` has completed.

## Re-run behaviour

Not re-runnable on the same directory: a second `sdlc new` against a directory that already has a
`.sdlc` folder throws immediately. To reproduce a project, run `sdlc new` again against a fresh
directory with the same `--from` configuration.

## Failure modes

- None of `--from`, `--interactive` or `--answers` given: throws before any file I/O.
- Invalid configuration: throws listing every schema error found.
- The onboarding session does not produce `<dir>.config.yaml`: throws "onboarding did not produce
  a config file". This includes the case where the nested `claude` process cannot run at all, for
  example because it is not signed in in that environment.

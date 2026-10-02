# 0090 · Verify spreads the suite across copies of the application

Status: accepted · 2026-10-02

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

Verify ran the acceptance suite one test at a time against one running copy of the new
application. A slice of about twenty criteria is about a hundred test cases, and at thirteen to
nineteen seconds each a verify took half an hour. Most of the machine sat idle while it ran.

Resetting the data before each test was measured at about three seconds of that. Faster resets
were set aside, because the time is in the tests themselves. The harness could already run several
workers, each with its own address, mail catcher and reset (`SDLC_*_<i>`), and calibration already
ran several copies of the oracle (`oracle.instances`). The new target's sandbox could start only one
copy.

## Decision

**A target can declare copies.** The settings are in `.sdlc/config.yaml`:

- `targets.<t>.instances`: how many copies to run.
- `targets.<t>.ports`: maps each port variable the compose file reads to copy 0's port.
- `targets.<t>.instance_port_step`: how far apart the copies' ports sit. The default is 100.

Copy 0 is the sandbox exactly as it was. Copy *i* is a compose project of its own,
`<project>-<i>`, with its own database. Compose is handed each port variable moved *i* steps along.
The pipeline moves every address the target declares on one of those ports with it:
`base_url`, `mail_api` and `depends_on`. Copy *i* has its own reset, which runs the seed service in
its own project.

**Verify starts every copy and hands the suite one of each.** Playwright runs one worker per copy,
and a worker keeps its copy for the whole run, so two tests running at once never share data.
`sandbox up` on its own starts copy 0 only. A sandbox someone drives by hand, or an adapter is bound
against, is one application. `sandbox down` stops every copy.

**The application publishes its ports through variables.** The stack profile has the compose file
read every published port, and every address that names one, from a variable that defaults to
today's value. With no variable set, nothing changes.

## Consequences

- A verify takes roughly the time of the slowest copy's share of the tests. Each copy costs the
  memory of one application.
- More than one copy needs `ports`. Without it the copies would collide on the same host ports, so
  more than one copy with no `ports` is refused by name. A compose file that does not yet read the
  variables is caught by `sandbox up`'s port check before anything starts.

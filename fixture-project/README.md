# fixture-project

A saved configuration for `permit-intake`, a deliberately unrelated two-domain
application (`applications`, `fees`) used only to exercise the pipeline end to
end in `test/fixture.test.mjs`, `test/fixture-spec.test.mjs` and
`test/fixture-1c.test.mjs`.

It exists to guard against a pipeline that only works for one particular
product: `newProject` creates a project from `fixture.config.yaml` in a temp
directory, the test fills the constitution placeholders, runs the checks,
opens and approves a proposal, and builds the state site. Nothing here is
run against a real service — `targets.new.base_url` points at localhost and
is never dialled, and no stage in these tests reaches the network.

## What is in here

- `fixture.config.yaml` — the saved configuration `sdlc new --from` reads.
- `old/` — a tiny stand-in for an old application (a README, two source
  routes and a test file the blindness rules say archaeology may never read),
  checked out read-only as `sources/old` by the `with-sources` workspace.
- `mock/` — one canned agent turn per stage, read by the mock executor
  (`SDLC_EXECUTOR=mock`) instead of spawning a session. Each file carries the
  `text` the stage's journal entry gets, and most also carry a `files` map the
  mock writes into the workspace, which is what the stage's post-checks then
  judge.

## The mock turns

| File | Stands in for | What it writes |
| --- | --- | --- |
| `probe.json` | `probe` | `app/PROBE.md`, the one file that stage's post-check looks for |
| `intent.json` | `intent` | the filled intent brief |
| `archaeology.json` | `archaeology` | `spec/domains/applications.md` with provisional criteria |
| `rule.json` | a persona's ruling turn | nothing — the verdict block its text carries is the whole answer |
| `contract.json` | `contract` | `spec/contract/` (surface, personas, observables, OpenAPI) and the synthetic seed with its manifest. No compose override: the fixture's oracle is short-circuited by `SDLC_ORACLE=mock`, so there is nothing for one to configure |
| `derive-tests.json` | `derive-tests` | one acceptance spec per testable criterion, plus the `not-testable` note for the one that has no observable |
| `bind-adapter.json` | `bind-adapter` | `tests/adapters/old/index.ts` and `bindings.yaml` binding every surface member |
| `calibrate.json` | the suite runner, not an agent | the result rows `SDLC_TEST_RUNNER=mock` returns instead of running Playwright — one row per criterion, including the failure calibration opens a proposal for |

`calibrate.json` is the odd one out: `calibrate` takes no agent turn, so the
mock it reads is the *result set* the suite would have produced, and the
oracle it would have run against is short-circuited separately by
`SDLC_ORACLE=mock`.

This directory holds only the configuration, the stand-in old application and
these canned turns; the project itself is generated fresh into a temp
directory each time a test runs.

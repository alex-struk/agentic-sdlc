# fixture-project

A saved configuration for `permit-intake`, a deliberately unrelated two-domain
application (`applications`, `fees`) used only to exercise the pipeline end to
end in `test/fixture.test.mjs`.

It exists to guard against a pipeline that only works for one particular
product: `newProject` creates a project from `fixture.config.yaml` in a temp
directory, the test fills the constitution placeholders, runs the checks,
opens and approves a proposal, and builds the state site. Nothing here is
run against a real service — `targets.new.base_url` points at localhost and
is never dialled.

This directory holds only the config and this note; the project itself is
generated fresh into a temp directory each time the test runs.

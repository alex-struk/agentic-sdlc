# Stage skill: calibrate

`calibrate` is deterministic: it runs no agent turn at all (`agent: false` in the stage
registry, the same as `ratify`), so there is no session for this skill to brief.

The stage runs the merged acceptance suite against a target, writes one row per criterion
to `tests/results/<target>/`, and opens a G1 proposal over every failure nobody has ruled
on yet. The judgement it needs — whether a failure is the application's fault, the spec's
or the test's — is the product owner's, made through that proposal in the calibration
grammar (`templates/project/.sdlc/personas/product-owner.md`, "Calibration rulings"), and
applied mechanically by the next run.

See `docs/stages/calibrate.md`.

# Verify one slice

Deterministic stage: the runner starts the sandbox from the open build proposal, runs the
acceptance tests for the criteria the slice claims, records the result on the proposal's
branch, and returns the proposal to `build` with each failing criterion when any fails.

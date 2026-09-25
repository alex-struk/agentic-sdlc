# 0059 · Calibrate's result file joins the scrubbed writers

Status: accepted · 2026-09-25

## Context

`0020` named every writer of agent-produced text into a committed file and had each call
`redactLocalPaths` at the point it writes: the journal, a proposal page, a ruling, verify's
result file and return gate, and the run record. `calibrate`'s own result file was not on
that list. Its rows carry a test's own error, the same as verify's do — and where the
target is the oracle, a reset that fails names the absolute path to this pipeline's own
`bin/sdlc.mjs` on the machine that ran it. That text went into `tests/results/<target>/`
unredacted, on every run, dated file and `latest.json` alike, because calibrate already
imported `redactLocalPaths` for the line it writes to the run record and stopped there.

A project egress check catches what a committed file already holds; it does not fix the
file. Where calibrate had already run against a target with reset trouble, the dated result
files on that project's `main` held the path from the day of the run, not just the day the
check happened to be run.

## Decision

**Calibrate redacts the whole result document at the one place it is serialised**, the same
`JSON.stringify` result written to both the dated file and `latest.json`, so neither needs
its own call and a row merged from a previous run through `--skip-suite` or `--domain`
carries the same guarantee as a row this run just produced.

**A project already holding an unredacted result file is fixed by rewriting it, committed by
the pipeline.** `sdlc scrub` reads every tracked file under `tests/results/` and any other
path rule E-2 flags, applies `redactLocalPaths`, and commits what changed as the pipeline —
the same authorship a calibration run itself commits under. It is generic across every rule
the egress check enforces, not specific to this defect, so a future writer with the same gap
is fixed by the same command rather than a new one.

## Consequences

`docs/decisions/0020` is the standing rule; this is the writer it missed, closed the same
way as the rest. A project with dated result files older than this fix still needs `sdlc
scrub` run once to clean its history — the fix alone only stops new rows from carrying a
path, it does not reach back into files already on `main`.

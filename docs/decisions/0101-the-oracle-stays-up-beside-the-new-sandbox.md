# 0101 · The oracle stays up beside the new target's sandbox

Status: accepted · 2026-10-04

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

The oracle and the new target's sandbox run on the same machine. When a binding of the new
target found its sandbox not up, `sdlc drive` took the oracle down first, whenever it was up,
and then started the sandbox (`docs/decisions/0078`). The two had been configured on the same
ports, so a sandbox started beside the oracle would have been refused them.

During the Build phase the oracle is wanted between slices: a contract revision is bound on the
oracle's target as well as the new one, and a missing test is run against it. Each time it had
been taken down for a binding of the new target, the next step that needed it brought it up
again, which builds its images, migrates its databases and loads the seed into every copy. On one
project that came to several minutes a slice. Where the oracle's ports and the sandbox's are
apart, taking it down buys nothing.

## Decision

**The oracle stays up while the new target's sandbox starts beside it.** A binding that finds the
sandbox not up starts it, runs once more and takes it down, as before, without touching the
oracle. Only a sandbox refused a host port this machine already holds, while the oracle is up, is
answered by taking the oracle down and starting the sandbox once more, the same answer a verify
refused a port is given. With the oracle not up, a refused port is something else's and a stop.

A project keeps the two apart by configuration: the oracle's `base_url` port, and the ports the
new target's copies publish (`targets.new.ports`, moved by a hundred for each copy).

## Consequences

- The oracle is built and seeded once for a run of slices, not once for every binding between
  them.
- The oracle's copies and the sandbox's run at the same time, so a project's memory has to hold
  both; how many copies of each it declares is sized for that.
- A project whose ports overlap pays one refused start before the oracle is taken down, and is
  otherwise answered as before.

# 0091 · A failure says where it was and what it saw

Status: accepted · 2026-10-02

The concepts these decisions use are defined in `docs/operating-model.md`.

## Context

A builder never sees the acceptance tests (`docs/decisions/0011-build-verify-review.md`). When
verify returns a build, each condition is all the builder learns about a failure: the criterion,
the case, the assertion's own words and the line it stopped at. For most failures that is enough.
For one kind it is not. A test that reads something off a page and gets nothing back fails with
`Received string: ""`. That names no page, no control and nothing the page showed.

A revision handed ten failures in that form spent its turn trying to reproduce them. It tried to
start the sandbox, which its shell does not allow, and to install a browser, which did not
unpack. It then fixed four guessed causes and said that none was confirmed. A revision handed one
failure that named the page and what it offered fixed that failure directly. Build turns grow with
how little a condition says, not with the size of the application.

An empty read is also the failure most often caused by the adapter rather than the application.
Calibration's adapter findings are mostly reads from the wrong part of a page. A builder cannot
see the page and cannot change the adapter, so a failure that is the adapter's comes back from
every revision unchanged.

## Decision

**1. The harness records what a test did, and leaves the page behind when it fails.** The fixture
that hands a test its surface records each member the test calls:

- its name, as the contract names it;
- what it was given, a persona by its id and a record by its fields;
- the page it ended on, as a path;
- what it read there, or what it threw.

The last twelve are kept. When a test fails, the fixture attaches those steps, the page's
accessible outline and a full-page picture. Nothing about recording changes what a test sees or
how it ends. The sandbox password is scrubbed from everything the harness writes.

**2. A condition carries the last steps and the page.** Verify adds the last four steps to each
failure it returns: `its last steps: <member>(<given>) at <path> read <value> → …`. The contract is
the builder's to read, so a member's name shows the builder nothing of the test. What the steps
add is where the test was when it stopped and what the application put in front of it.

Verify copies each failing test's picture and outline into `.sdlc/evidence/slice-<n>/`, named by
criterion, and the condition ends with their paths. The folder is in the required ignores, and
verify writes nothing there unless git ignores it. The files are retaken by every verify of the
slice, and a build revision's workspace is given them at the same path. The steps are committed
with the result; the pictures are not. A reader on another machine has the steps without the
pictures.

**3. An empty read is sorted before it reaches the builder.** A failing verify whose failures
include one that stopped on a read that came back with nothing is not returned by verify. The
result records every failure as the build would be told it (`sort.conditions`) and which were
empty reads (`sort.empty_reads`). The build stays open, and `next` hands it to its G3 ruler, as it
does any build that did not pass.

The ruler is shown each failure with the picture and outline of its page, and reads the adapter
member the last step names. It returns the build with each failure accounted for in one of two
ways:

- **The application's.** The page does not show what the criterion needs. The failure goes back
  as a condition, copied as verify wrote it.
- **The adapter's.** The page shows it and the adapter read somewhere else.
  `addressed-to bind-adapter: <id>: <what it read, and what the page shows instead>`, which
  files a request the next binding run for the new target takes up.

A person in the seat rules it the same way, from the same result file and the same pictures on the
machine.

The ruler's return of a build verify left to sort counts toward verify's return limit, as
verify's own return would have. A return that would reach the limit is verify's own escalation,
as before.

**4. The builder is told what it cannot run.** The build skill says plainly that its shell runs
`npm`, `npx`, `node`, `ls` and `mkdir`. It cannot start Docker or a browser, and should not try.
A revision is told that each failure ends with the steps its test took. Where verify kept them,
it is told the picture and the outline are in its workspace to open before changing anything.

**5. A quoted failure is not a request to change the test.** The guard that refuses a condition
naming a path the stage cannot deliver ignores two things a quoted failure carries as evidence:
the place in the test it stopped at (`at tests/acceptance/<d>/<file>:<line>`) and the evidence
files under `.sdlc/evidence/`. A condition that asks for the test itself to change is still
refused.

## Consequences

- `sdlc init` delivers the new fixture with the rest of the acceptance harness, and adds
  `.sdlc/evidence/` to `.gitignore`. A project whose fixture predates this has no steps, and its
  failures read as before.
- A failing verify with an empty read costs one ruling before the build goes back. A failure the
  ruler sends to the adapter costs one binding run instead of a build revision that cannot fix it.
- The outline is the browser's accessibility tree, so it names what a person using a screen
  reader would hear. That is also what the adapter's locators match against, which is what makes it
  useful for telling the two causes apart.

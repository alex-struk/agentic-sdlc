# 0023 · The ruler was shown everything except what the ruling turns on

Status: accepted · 2026-09-20

## Context

`0014` settled that a build ruling is shown the build: a proposal whose branch changes the
application carries it in the ruling diff, first, because a gate ruled on a summary of work
nobody read looks exactly like a gate that works. The principle was applied to the code. It
was not applied to the evidence, and four things follow from that, which are one thing.

**The verify result reached the ruler by accident.** A build proposal is ruled on what the
acceptance suite established about the application on its branch (`0011`), and `verify`
writes that to a result file: the verdict, a row per criterion the slice claims, and — where
the adapter could not bind something a test calls — the adapter's own account of what the
application did not provide, which is the only place in the pipeline that reason is written
down. `buildVerified` reads that file to decide whether an approval may be given at all. The
persona holding the gate was never handed it. It arrived, when it arrived, because the file
happens to be a changed file on the branch, in a diff ordered by something else and capped.

**The budget went to machine-written text.** `app/` ranked first at G3, which is right for
the application and wrong for everything a toolchain writes into it. On a real build slice a
120,000-character budget was exhausted at file 41 of 83, with a resolved dependency tree of
5,293 lines and a generated API client competing for it. What fell off the end was the
verify result and the whole of the acceptance suite — the two things the ruling turns on.

**The cut said how much was missing and not what.** `[<n> further changed file(s) not
shown]` tells a ruler that evidence is absent and gives it no way to decide whether the
ruling turned on it. The ruling turn can read any file on the branch; it cannot ask for a
file it was never told exists.

**And a brief could not be corrected after scaffolding.** The reviewer's brief gained a
section describing a condition form the runner had just learned to act on. A project
scaffolded before that carried a brief differing by exactly that block, and nothing brought
it current: `init` would have overwritten it, but `init` is not run again, and nothing
reported the gap. The stale brief still read as a complete brief, which is why nothing
signalled it. A pipeline whose existing projects can only receive a capability by being
created again is not reusable.

The brief was also, by then, asserting something untrue. It told the reviewer the acceptance
tests had already passed "and the runner would not have asked you otherwise". That was true
while the build-verified guard refused every ruling on an unpassed build; `0022` bound the
guard to the verdict instead, so a return or an escalation is now asked for on exactly the
results that are not a pass. The prose was not relaxed with the guard, and a ruler handed an
unbound or failed build was told the premise of its own question did not exist.

**The family is a gate given everything about a decision except the thing the decision turns
on.** Each of these was a sound rule that stopped one step short of the evidence: order the
diff, but rank the code above the result; exclude derived files, but not the machine-written
files that are committed; mark the cut, but not its contents; ship a brief, but only to
projects that do not exist yet.

## Decision

### 1 — A build ruling is shown the verify result, outside the diff's budget

A proposal named for a build slice carries the result in a section of its own, before the
diff: the verdict and what it means for the ruling, which proposal and which application
tree the result was recorded against, whether the branch has moved on since, a line per
criterion that did not pass carrying its own reason, and the passing criteria by id. A build
proposal with no result on its branch is told so in the same place.

The section is bounded by construction — reasons cut at a fixed length, the non-passing
criteria carrying reasons up to a limit and listed by id past it, the passing ones named up
to a limit and counted past it — so a suite of hundreds of criteria cannot spend the budget
the diff needs. Its file is then excluded from the diff, for the reason the proposal page
is: it is the same text a second time.

This is what `0014` says, applied to the evidence rather than to the code. A gate whose
evidence reaches it only when the diff happens to be small is a gate that works by luck.

### 2 — What a build ruling turns on outranks the application in the diff

G3's order is the verify results, the acceptance suite, the adapters, then `app/`, then the
evidence receipt. A builder who changed the tests being judged against him is the first
thing the ruler needs to see; the application is what the rest of the budget is for.

### 3 — A stack profile declares what its toolchain writes and the project commits

`ignore:` already declares what a toolchain writes and nobody commits, and `init` puts those
in `.gitignore` so they never reach a proposal. A second list in the same front matter,
`bulk:`, declares what it writes and everybody commits — a resolved dependency tree, a
generated client — which cannot be ignored and is never evidence about a change. Those files
are left out of the diff a persona is shown and named in the prompt, since they are on the
branch and a ruler may want one.

The pipeline holds no file names of its own here. The stack is what knows what its tools
write, exactly as with `ignore:`, and a project on a stack that declares nothing gets no
guesses — which is why the same defect is also closed generically: no single file takes more
than a quarter of the budget while other files are still waiting to be shown. The last file
in the order is exempt, since by then nothing is waiting.

### 4 — A cut names what was cut

A file shown in part says which file and how much of it is missing. A diff that ran out of
budget lists the paths it dropped, in the order they were dropped, and says they can be read
on the branch. The ruling turn holds read tools; told which file it has not seen, it can go
and read it, or return the proposal saying what it could not see.

### 5 — A brief is reconciled against a record of what was installed

`init` compares each persona brief with its template and tells apart the three states with a
digest of the text it last wrote, recorded per brief in the project's lockfile: the same
text as the template is *current*; different from the template and identical to what `init`
last wrote is *behind*, and the template is taken; different from both is *local*, and
nothing is written.

A `local` brief is named in a warning from `init`, in the `briefs` check — which runs in
`sdlc checks`, in `sdlc doctor`, and inside every ruling prompt, since the checks are part of
it — and stays named until somebody resolves it. `sdlc init --adopt-briefs` takes the
template for it, which is the operator saying in so many words that the edits are to be
discarded. A project with no record yet reads every differing brief as `local`: the safe way
to be wrong is to ask rather than to overwrite.

The check warns and never fails. A brief that is behind is the pipeline's own text going out
of date, not a fault in the project, and a brief a team wrote into is a choice the pipeline
has no standing to call wrong. What neither may do is go unsaid.

### 6 — The brief says what is actually true of a build ruling

The reviewer's brief states what each verdict means for the ruling, that an approval is
refused without a current pass, and that a return and an escalation are open whatever the
result says — which is the whole point of `0022`, and the reason a slice the suite could not
exercise is still rulable.

## Consequences

- A build ruling carries its evidence whatever the size of the diff, and the ruler is told
  when there is no evidence rather than left to infer it.
- A capability added to a persona brief reaches the projects that already exist, on their
  next `init`, without anybody having to know a brief changed — and a project that wrote its
  own instructions into one keeps them, and is told what it is missing.
- The prompt is smaller for a project whose stack declares its generated files, and the
  files are named rather than silently absent.
- A ruler that needed a file it was not shown can name it in a return, which makes the
  cut a fact about the ruling rather than an invisible gap in it.

## What was considered instead

**Raising the G3 budget again.** It buys one slice and loses the next. The budget was not
too small; it was being spent on text no ruler reads, and the file that overflowed it was
larger than the whole of it on its own.

**A pipeline-held list of generated file names.** Lockfile names, build directories, client
generators: the list is a list of other people's ecosystems, it goes stale, and a project
whose generator writes somewhere else is not covered by it. The stack profile already
declares this class of thing and is where the knowledge belongs.

**Having `init` keep overwriting the briefs.** It is the propagation path that already
existed, and it works right up to the first project that writes a sentence of its own into a
brief, at which point it destroys it without saying so. A ruler's instruction sheet is the
last file to take that risk with.

**Reporting a stale brief as a failing check.** A failing check stops work, and a brief that
is behind is not a reason the project's own state is wrong. It also puts the pipeline in the
position of failing a project for a choice the project made. A warning that is repeated in
four places and never goes away until it is dealt with is the pressure this needs.

// Naming and revision-source helpers every gated stage shares, kept out of registry.mjs
// so a stage module (`build.mjs`, and any later one) can reach them without importing the
// registry itself — registry.mjs imports every stage module, so a stage importing back
// from registry.mjs is a cycle whose evaluation order is not guaranteed.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";
import { git, gitOk, stagePaths, SDLC_AUTHOR } from "../lib/git.mjs";
import { escapeRe } from "./shared.mjs";
import { conditionsAreExecutable, splitConditionsByAddressee } from "../spec/criteria.mjs";
import { openFor, openOn, owedPath, settle } from "../spec/owed.mjs";
import { redactLocalPaths } from "../lib/redact.mjs";

// One sentence off the front of `text`, plus whatever is left after it. The terminator
// has to be followed by whitespace or the end of the string, so a dot inside a filename
// (`intent/brief.md`) or a version number does not end a sentence. Text with no
// terminator at all is one sentence.
function nextSentence(text) {
  const t = (text ?? "").trim();
  if (!t) return null;
  const m = t.match(/^[\s\S]*?[.!?](?=\s|$)/);
  if (!m) return { sentence: t, rest: "" };
  return { sentence: m[0].trim(), rest: t.slice(m[0].length) };
}

function capSentence(sentence) {
  return sentence.length > 200 ? `${sentence.slice(0, 200)}…` : sentence;
}

// The recommendation a proposal leads with, taken from the agent's own journal text
// rather than re-derived: whatever the agent decided to say first about its work is what
// the reader — and the ruling persona — sees first.
//
// Three rules decide which sentence that is. A stage skill asks the agent to finish with
// a journal entry, so when the text carries a `## Journal` heading the entry starts
// there and anything above it is a preamble, not the finding. The opening sentence is
// often bookkeeping rather than a claim — "Done." or "I've written the domain file." — so
// a sentence too short to carry one (under 15 characters), or one that opens by
// announcing that the work happened, is skipped for the sentence after it. What comes
// back is capped at 200 characters, since a recommendation is a line on a proposal page,
// not a paragraph.
//
// Text with no sentence terminator at all is one sentence; no text at all is reported as
// exactly that, rather than as an empty recommendation.
export function recommendationFrom(text) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "no journal text was recorded";
  const heading = /^#{1,6}[ \t]+Journal\b.*$/mi.exec(trimmed);
  const body = heading ? trimmed.slice(heading.index + heading[0].length) : trimmed;
  const first = nextSentence(body);
  if (!first) return "no journal text was recorded";
  if (first.sentence.length >= 15 && !/^(i'?ve|i have|done|finished)\b/i.test(first.sentence))
    return capSentence(first.sentence);
  const second = nextSentence(first.rest);
  return capSentence(second ? second.sentence : first.sentence);
}

// The highest number already used by a ruling in this family, counting the unnumbered
// first one as 1. Read as a maximum rather than as a count, because the numbers are not
// contiguous: a return recorded on `main` writes its own gate file, so a family can hold
// 1, 2, 3 and 6 with nothing at 4 or 5 — and a count would then hand back a name that is
// already taken. That is not hypothetical. A revision numbered itself 6 against a family
// whose highest was already 6, inherited that ruling's own gate file from `main`, and was
// skipped by `rule --pending` as already ruled.
export function highestRulingNumber(projectDir, stem) {
  const dir = join(projectDir, ".sdlc", "gates");
  if (!existsSync(dir)) return 0;
  const re = new RegExp(`^${escapeRe(stem)}(?:-(\\d+))?\\.yaml$`);
  let highest = 0;
  for (const f of readdirSync(dir)) {
    const m = re.exec(f);
    if (m) highest = Math.max(highest, m[1] ? Number(m[1]) : 1);
  }
  return highest;
}

// `<stem>` the first time, `<stem>-2` after that, counting the rulings already recorded
// under that stem. A stage whose proposal name is a fixed string can only ever be run once
// per project: the second run opens a proposal whose gate file already carries a verdict,
// so `rule --pending` does not see it as open and the work sits on a branch nobody can
// rule. That is not a hypothetical — three re-derivations worth $38 landed exactly there,
// finished and unrulable, before this existed.
export function nextProposalName(projectDir, stem) {
  const highest = highestRulingNumber(projectDir, stem);
  return highest === 0 ? stem : `${stem}-${highest + 1}`;
}

// The one ruling a `--revise` run reads and acts on: a `return` verdict on the named
// proposal, whose gate file has not (yet) landed on `main` — once it has, the return has
// already been recorded and dealt with, and there is nothing left to revise from under
// that name. A branch that never existed, or whose gate file `git show` cannot read, is
// not a candidate rather than an error: most domains have no returned ruling at all, and
// that is the ordinary case each stage's own revision-source pre-check reports, not this
// function's problem to raise. Shared by every stage with a `--revise` mode (archaeology,
// derive-tests, design, build) — none of them cares which gate it is being asked about,
// only whether the named proposal's own gate file, on its own branch, says `return`.
export function returnedRulingOn(projectDir, name, branch) {
  const gatePath = `.sdlc/gates/${name}.yaml`;
  let text;
  try { text = git(["show", `${branch}:${gatePath}`], projectDir); } catch { return null; }
  // A full rerun can reuse a proposal name. Only the same recorded ruling is spent,
  // not a newer return whose path happens to exist on main already.
  if (gitOk(["cat-file", "-e", `main:${gatePath}`], projectDir)
    && git(["show", `main:${gatePath}`], projectDir) === text) return null;
  const gate = parseYaml(text) ?? {};
  if (gate.verdict !== "return") return null;
  // A human ruling's free-text explanation is `note`; an agent's is `rationale`. Either
  // one is what a revise prompt needs to quote — the field name is an implementation
  // detail of who ruled, not something the prompt should have to know about. `conditions`
  // is only ever an agent ruling's own list of free-text lines (a human `rule --return`
  // records no such field at all) — `[]` for a human return, so a revise prompt can
  // always iterate it without checking who ruled first.
  return { rationale: gate.rationale ?? gate.note ?? "", ...splitRulingConditions(gate, name) };
}

// Whether a named proposal is open right now: its branch exists and nobody has ruled it
// at all, on the branch or on `main`. A `--revise` pre-check needs this apart from
// `returnedRulingOn`'s `null`, which also covers a name that never existed and one whose
// ruling was something other than `return` (approved, escalated) — three different
// situations, and only this one means "a ruling is pending, go rule it" rather than
// "there is nothing here to revise from".
export function openProposalOn(projectDir, name, branch) {
  if (!gitOk(["rev-parse", "--verify", branch], projectDir)) return false;
  const gatePath = `.sdlc/gates/${name}.yaml`;
  return !gitOk(["cat-file", "-e", `${branch}:${gatePath}`], projectDir)
    && !gitOk(["cat-file", "-e", `main:${gatePath}`], projectDir);
}

// A ruling's conditions as the stage being asked to revise should receive them:
// `conditions` are the ones it is to act on, and `addressedElsewhere` accounts by stage
// for the ones it is not. A stage handed a condition addressed to another stage either
// fails at it or finds a way, and in the plain case it is asked for a file outside the
// overlay its workspace even holds.
//
// Where the conditions are a closed grammar — ratification and calibration at G1, the
// reviewer's triage page — nothing is taken out. The stage that owns the grammar reads
// every line, and a verb read out of those same lines would come off a ruling that
// grammar may yet declare unreadable.
export function splitRulingConditions(gate, name) {
  const all = gate?.conditions ?? [];
  if (conditionsAreExecutable(gate?.gate, name)) return { conditions: all, addressedElsewhere: [] };
  const { mine, elsewhere } = splitConditionsByAddressee(all);
  return { conditions: mine, addressedElsewhere: elsewhere };
}

// The bullet list of conditions a revise prompt asks the stage to meet.
export function revisionConditionList(ctx) {
  return (ctx.revision?.conditions ?? []).map((c) => `- ${c}`).join("\n");
}

// Everything a revise prompt is accountable for naming and is not carrying out, in two
// paragraphs that fire independently. A stage shown a shorter list with nothing to explain
// it cannot tell a ruling that asked less of it from one whose other halves it was never
// given, and it has no way to reason about the gap between what it can read on the branch
// and the work it has been set. So both kinds of gap are named, with whose words they are.
//
// The first is the conditions on the ruling being revised from that went to another stage.
// The second is the requests addressed to THIS stage that this run is not answering — a
// revision driven by a returned ruling answers that ruling, while an ask filed against the
// same stage from somewhere else is open the whole time and is no part of it.
//
// Empty — no paragraph at all — where there is neither, so an ordinary revision's prompt
// reads exactly as it always has.
export function addressedElsewhereNote(ctx) {
  return [elsewhereConditionsPart(ctx), openRequestsPart(ctx)].filter(Boolean).join("\n\n") || null;
}

function elsewhereConditionsPart(ctx) {
  const away = ctx.revision?.addressedElsewhere ?? [];
  if (!away.length) return null;
  return `${away.length} condition${away.length === 1 ? "" : "s"} on that ruling ${away.length === 1 ? "is" : "are"} addressed to another stage and `
    + `${away.length === 1 ? "is" : "are"} not yours to carry out. ${away.length === 1 ? "It has" : "They have"} been filed where that stage reads `
    + `${away.length === 1 ? "it" : "them"}, and ${away.length === 1 ? "is" : "are"} named here so the list above is not silently shorter than the ruling:\n\n`
    + `${away.map((a) => `- to ${a.stage}: ${a.text}`).join("\n")}\n\n`
    + "Leave each of those alone. Doing one of them here would change work this proposal is not answerable for, and the stage it was addressed to would then be asked for it again.";
}

function openRequestsPart(ctx) {
  const open = ctx.revision?.openRequests ?? [];
  if (!open.length) return null;
  return `${open.length} request${open.length === 1 ? "" : "s"} addressed to this stage ${open.length === 1 ? "is" : "are"} open and no part of this revision. `
    + `This run answers the ruling above; ${open.length === 1 ? "that one stays" : "those stay"} open until a run takes ${open.length === 1 ? "it" : "them"} up, and `
    + `${open.length === 1 ? "is" : "are"} named here so the work in front of you is not silently narrower than what is asked of this stage:\n\n`
    + `${open.map((r) => `- from ${r.from} (${r.gate}, ${r.by}): ${r.why}`).join("\n")}\n\n`
    + "Do not go past what the ruling above asks for on account of them. A request is answered by the run that takes it up, and this run has not.";
}

// The side effect every `--revise` pre-check performs, on a real run only, once it has
// found the returned ruling to work from: the gate file and the proposal page that
// recorded the return are copied from the spent branch onto `main` and committed there.
// This is what makes the return visible to `readRulings`/`followUpState` (a `return` gate
// file on `main` counts as "ruled" for follow-up numbering, so the next follow-up
// continues past it rather than reusing its number) and to the state site, and it is what
// frees the name for the fresh proposal this run is about to open. Run from each stage's
// own revision-source pre-check, guarded there to a real run — a dry run only needs the
// rationale to print, never this commit.
//
// The gate file always exists on the branch (a caller would not have named it otherwise),
// but the proposal page can be missing — a human ruling made straight from the CLI, with
// no page ever opened for it. `git show` on that path is guarded rather than left to
// throw, so a branch in that shape still records the gate file that matters and says, in
// the commit message, that there was no page to carry over.
//
// What happens to the spent branch differs by gate: archaeology's `--revise` (G1) has
// nowhere left to read the old evidence from once it is recorded, so the branch is
// deleted; a later gate's `--revise` rewrites its output from what the branch already
// carries, and that content exists nowhere else, so its branch is renamed to
// `returned/<name>` instead — every commit kept, just out of the `proposal/*` namespace a
// fresh run needs clear. `keepBranch` picks between the two; `gate` only shapes the commit
// subject (`record(G1): …` vs `record(G3): …`).
export function recordReturnOnMain(projectDir, { name, branch }, { gate = "G1", keepBranch = false } = {}) {
  const gateRel = `.sdlc/gates/${name}.yaml`;
  const proposalRel = `.sdlc/proposals/${name}.md`;
  writeText(join(projectDir, gateRel), `${git(["show", `${branch}:${gateRel}`], projectDir)}\n`);
  const staged = [gateRel];
  let proposalFound = true;
  try {
    writeText(join(projectDir, proposalRel), `${git(["show", `${branch}:${proposalRel}`], projectDir)}\n`);
    staged.push(proposalRel);
  } catch {
    proposalFound = false;
  }
  stagePaths(projectDir, staged);
  const subject = proposalFound ? `record(${gate}): ${name} returned` : `record(${gate}): ${name} returned (no proposal page found on ${branch})`;
  git([...SDLC_AUTHOR, "commit", "-q", "-m", subject], projectDir);
  if (keepBranch) git(["branch", "-m", branch, `returned/${name}`], projectDir);
  else git(["branch", "-D", branch], projectDir);
}

// The returned proposal whose return `commit` recorded on `main`, or `null`. A revision's
// pre-check records the return it answers (`recordReturnOnMain`) and the revision's branch is
// cut from that commit, since nothing commits to `main` while a stage runs, so a revision's
// branch point names the proposal it revised: the one gate file that commit added, ruled
// `return`.
function returnRecordedAt(projectDir, commit) {
  let added;
  try {
    added = git(["diff-tree", "--no-commit-id", "--name-only", "--diff-filter=A", "-r", commit, "--", ".sdlc/gates"], projectDir)
      .split("\n").filter((p) => p.endsWith(".yaml"));
  } catch { return null; }
  if (added.length !== 1) return null;
  let doc;
  try { doc = parseYaml(git(["show", `${commit}:${added[0]}`], projectDir)); } catch { return null; }
  if (doc?.verdict !== "return") return null;
  return added[0].slice(".sdlc/gates/".length, -".yaml".length);
}

// The proposals of one line of work that an approved proposal rests on, newest first: the
// approved proposal itself (`name`, its branch tip `tip`, the commit it was cut from `base`),
// then each returned proposal it revised, and the one that one revised, back to a proposal no
// return led to. Each comes with the tip its branch holds (`returned/<name>`, else
// `proposal/<name>`) and the commit that branch was cut from, so a caller can read what each
// run wrote on its own branch against what it was handed. A proposal `sameLine` refuses, or
// one whose branch no longer exists, ends the line.
export function revisionLine(projectDir, { name, tip, base, sameLine = () => true }) {
  const line = [{ name, tip, base }];
  const seen = new Set([name]);
  let at = base;
  for (;;) {
    const prev = returnRecordedAt(projectDir, at);
    if (!prev || seen.has(prev) || !sameLine(prev)) break;
    const ref = [`returned/${prev}`, `proposal/${prev}`].find((r) => gitOk(["rev-parse", "--verify", "-q", `${r}^{commit}`], projectDir));
    if (!ref) break;
    const prevTip = git(["rev-parse", ref], projectDir);
    const prevBase = git(["merge-base", prevTip, at], projectDir);
    line.push({ name: prev, tip: prevTip, base: prevBase });
    seen.add(prev);
    at = prevBase;
  }
  return line;
}

// A revision read off a returned ruling, plus the requests addressed to the same stage that
// are open while it runs. That revision answers the ruling and no part of those, so the
// prompt names them (`addressedElsewhereNote`) rather than letting a stage be handed less
// than what is asked of it with nothing to say so. They are not taken up: a request is
// spent by the run that answers it, and nothing here can tell an ask the return already
// covers from one about something else entirely.
export function withOpenRequests(projectDir, stage, revision) {
  const openRequests = openFor(projectDir, stage, { kinds: ["request"] });
  return openRequests.length ? { ...revision, openRequests } : revision;
}

// A revision read off a returned ruling, plus every condition an earlier ruling in the same
// line of work attached and nobody has since closed. The ruler of this revision is shown
// that list as owed (`accountingNote` in `src/runner/persona.mjs`) and judges the proposal
// against it; a stage handed only the ruling that returned it is asked for less than its
// ruler will expect, and is returned again for something nobody asked it to do.
//
// Read from `main` through the same `openOn` the ruler's prompt and the
// ruling guard read, so the stage and its ruler are shown one list. The family is the
// caller's, because naming it takes the stage registry (`proposalFamily`), which a stage
// module cannot import; every ledger row carries the family its ruling computed. The
// returning ruling's own rows are left out: they are the conditions the prompt already
// lists as what the revision must now do.
//
// A revision with no name (one opened by requests rather than by a return) or no family
// belongs to no line of work in the ledger's sense and is returned as it came.
export function withOwedConditions(projectDir, revision, family) {
  if (!revision?.name || !family) return revision;
  const owed = openOn(projectDir, "condition").filter((c) => c.family === family && c.from !== revision.name);
  return owed.length ? { ...revision, owedConditions: owed } : revision;
}

// The paragraph a revise prompt carries for `owedConditions`, each condition by the
// reference a ruler closes it with and in its ruler's own words. Nothing where there are
// none, so a revision with nothing else owed reads exactly as it would without this.
export function owedConditionsNote(ctx) {
  const owed = ctx.revision?.owedConditions ?? [];
  if (!owed.length) return null;
  const one = owed.length === 1;
  const indent = (text) => String(text ?? "").trim().split("\n").map((l) => `  ${l}`).join("\n");
  return [
    `${one ? "A condition" : `${owed.length} conditions`} an earlier ruling on this same line of work attached ${one ? "is" : "are"} still open: `
      + `no ruling since has said ${one ? "it was" : "they were"} met or withdrawn, so ${one ? "it is" : "they are"} owed by this revision as much as anything the ruling above asks for.`,
    owed.map((c) => `- \`${c.ref}\`, attached by ${c.by ?? "?"} when it ruled ${c.from ?? "?"} at ${c.gate ?? "?"}:\n\n${indent(c.text)}`).join("\n\n"),
    one
      ? "The ruling that reads this revision will be shown it as owed, by its reference, and will expect it met or accounted for. "
        + "Meet it here. If it cannot be met in this run, say why in your journal entry, by its reference."
      : "The ruling that reads this revision will be shown each of these as owed, by its reference, and will expect each one met or accounted for. "
        + "Meet each one here. Where one cannot be met in this run, say which and why in your journal entry, by its reference.",
  ].join("\n\n");
}

// The requests addressed to one stage that nothing has taken up, as the round a `--revise`
// run answers: all of them, oldest first, with the ones a single ruling filed kept together.
//
// Grouping is what a ruler means by routing two conditions to one stage. They are halves of
// one observation — the work downstream showed something about this artifact, and both
// halves describe it — so an artifact that answers one of them alone can be consistent with
// neither. Between groups the order is the order they were filed in, because a request older
// than another was asked about an artifact that has since been approved again, and reading it
// first is what puts the two in the sequence they happened.
export function revisionRound(projectDir, stage) {
  const groups = new Map();
  for (const r of openFor(projectDir, stage, { kinds: ["request"] })) {
    const key = `${r.from ?? ""}\u0000${r.gate ?? ""}\u0000${r.by ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()].flat();
}

// The other thing a `--revise` run can start from: the requests filed by rulings elsewhere
// that named this stage (`addressed-to <stage>: <why>`). What that stage last produced was
// approved and merged, so there is no returned proposal to revise from and, until this, no
// way to open the artifact at all — which left a pipeline whose gates only move forward
// unable to record what the work downstream of a decision discovers about it.
//
// Every open request addressed to the stage, not the head of the list. A ruler who routes
// two conditions to one stage means them together, and a run handed the first of them alone
// answers half an ask, marks half a round and opens a proposal the addressed stage's own
// gate reads as answering all of it.
//
// Reopening is not accepting. The requests make the stage runnable again and nothing else:
// the revision they produce is a fresh proposal at that stage's own gate, ruled by the
// holder of that gate, so an upstream artifact is never changed on the say-so of a
// downstream reviewer alone.
//
// This reads and writes nothing. The round is spent where the run delivers
// (`settleRequestedRevision`), so a run refused by a later check, one whose agent turn was
// lost and one that was never started all leave every request exactly where they found it.
export function requestedRevision(projectDir, stage) {
  const requests = revisionRound(projectDir, stage);
  if (!requests.length) return null;
  return { name: null, branch: null, requests, rationale: "", conditions: [], addressedElsewhere: [] };
}

// Whether this revision was opened by requests rather than by a ruling returning the
// stage's own proposal. Asked of the round, so there is nothing for a caller to read a
// single entry out of.
export function isReopening(ctx) {
  return Boolean(ctx?.revision?.requests?.length);
}

// The one thing a run may say about a request it was given and could not answer, written
// in its journal on a line of its own, numbered as the prompt numbered it:
//
//     deferred-request 2: <why it cannot be answered here>
//
// Read as a map of number to reason. A list marker or blockquote in front of the line is
// allowed, since a journal entry is prose and the line will be written inside it; a reason
// is required, because a deferral with no account of itself leaves the next run reading the
// same ask with nothing more than it had.
export function deferredRequestNumbers(text) {
  const out = new Map();
  for (const m of String(text ?? "").matchAll(/^[ \t>*+-]*deferred-request[ \t]+(\d+)[ \t]*:[ \t]*(\S.*)$/gim)) {
    out.set(Number(m[1]), m[2].trim());
  }
  return out;
}

// What the round costs, paid where the run delivers: every request the run answered is
// marked taken, in one write and one commit on `main`, and every one it said it could not
// answer keeps its place on the list, open, with the reason recorded against it.
//
// Marked here rather than when the round was read, because a request is spent by work, and
// until a proposal is opened there is no work — a run refused by a later pre-check, one
// whose agent turn failed its post-checks, one interrupted mid-session all end with the ask
// still unanswered, and an ask marked answered is one nothing will raise again.
//
// A number the prompt never issued defers nothing: the run that wrote it named something
// this round does not hold, and guessing which request it meant is how a request nobody
// answered gets marked. It is reported in the commit instead.
export function settleRequestedRevision(projectDir, stage, ctx, agentText, proposalName = null) {
  const requests = ctx?.revision?.requests ?? [];
  if (!requests.length) return null;
  const deferrals = deferredRequestNumbers(agentText);
  const unknown = [...deferrals.keys()].filter((n) => n < 1 || n > requests.length).sort((a, b) => a - b);
  const taken = [];
  const deferred = [];
  requests.forEach((request, i) => {
    const why = deferrals.get(i + 1);
    if (why) deferred.push({ request, why, proposal: proposalName ?? "" });
    else taken.push(request);
  });
  if (!settle(projectDir, "request", { close: taken, defer: deferred.map((d) => ({ entry: d.request, why: d.why, proposal: d.proposal })), proposal: proposalName })) {
    return { taken: [], deferred: [], unknown, written: false };
  }
  const noun = (n) => `${n} revision request${n === 1 ? "" : "s"}`;
  const by = proposalName ? ` by ${proposalName}` : "";
  const subject = deferred.length
    ? `record(${stage}): ${taken.length} of ${noun(requests.length)} taken up${by}`
    : `record(${stage}): ${noun(taken.length)} taken up${by}`;
  const body = [
    ...deferred.map((d) => `deferred, still open: ${d.request.from} (${d.request.gate}) — ${d.why}`),
    ...unknown.map((n) => `deferred-request ${n} names no request in this round`),
  ].join("\n");
  stagePaths(projectDir, [owedPath("request")]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", subject, ...(body ? ["-m", redactLocalPaths(body, projectDir)] : [])], projectDir);
  return { taken, deferred, unknown, written: true };
}

// Where a revision came from, in the prompt's own words: ordinarily the ruling that
// returned this stage's own proposal, and for a reopening the rulings at other gates that
// asked for it. Both carry the ruler's text verbatim, because a stage sent back to work
// with no account of what was wrong does the same work again.
//
// The reopening block says which proposal, which gate and which seat each request came
// from, since none of that is anywhere the stage can see, and it says where the result
// goes: a stage told only to change something could otherwise read a request as the
// decision it is not.
//
// Every request is numbered and quoted, and the round is stated as one: the stage answers
// all of them in the run, and the number is what a run says back when it cannot.
export function revisionRulingBlock(ctx) {
  const requests = ctx.revision?.requests ?? [];
  if (!requests.length) return `The ruling that returned it:\n\n${ctx.revision?.rationale ?? ""}`;
  const one = requests.length === 1;
  return [
    `This revision was not asked for by a ruling on a proposal of your own. What this stage last produced was approved, and `
      + `${one ? "a condition ruled elsewhere is" : `${requests.length} conditions ruled elsewhere are`} addressed to this stage: `
      + `the work downstream of yours showed something about it that could not have been known when it was ruled.`,
    one ? null
      : "They are one round and every one of them is here. Answer all of them in this run and make the result consistent with all of them at once: conditions routed to the same stage were meant together, and an artifact that answers one of them on its own can end up consistent with neither.",
    `What ${one ? "that ruling asked" : "each of them asks"} for, in ${one ? "its" : "their"} own words:\n\n`
      + requests.map((r, i) => `${i + 1}. ${r.from} — ruled at ${r.gate} by ${r.by}:\n\n${r.why}`).join("\n\n"),
    `If ${one ? "it cannot" : "one of them cannot"} be answered in this run, say so in your journal entry on a line of its own, with the number it has above:\n\n`
      + "deferred-request <n>: <why it cannot be answered here>\n\n"
      + "A request you defer stays open and is asked again. Every one you do not defer is recorded as taken up by this run, whether or not the gate accepts what you did with it.",
    `Change only what ${one ? "it names" : "they name"} and leave everything else exactly as you found it. What you produce is a fresh proposal at this stage's own gate, and that gate decides whether the change is accepted — the ${one ? "ruling" : "rulings"} that asked for it ${one ? "does" : "do"} not.`,
  ].filter(Boolean).join("\n\n");
}

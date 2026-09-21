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
import { REVISION_REQUESTS_PATH, openRevisionRequestsFor, takeRevisionRequest } from "../spec/revisions.mjs";

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

// What a revise prompt says about the conditions on the same ruling that are not in that
// list. A stage shown a shorter list with nothing to explain it cannot tell a ruling that
// asked less of it from one whose other halves it was never given, and it has no way to
// reason about the gap between the ruling it can read on the branch and the work it has
// been set. So each one is named with the stage it went to and the ruler's own words.
//
// Empty — no paragraph at all — where nothing was addressed elsewhere, so an ordinary
// revision's prompt reads exactly as it always has.
export function addressedElsewhereNote(ctx) {
  const away = ctx.revision?.addressedElsewhere ?? [];
  if (!away.length) return null;
  return `${away.length} condition${away.length === 1 ? "" : "s"} on that ruling ${away.length === 1 ? "is" : "are"} addressed to another stage and `
    + `${away.length === 1 ? "is" : "are"} not yours to carry out. ${away.length === 1 ? "It has" : "They have"} been filed where that stage reads `
    + `${away.length === 1 ? "it" : "them"}, and ${away.length === 1 ? "is" : "are"} named here so the list above is not silently shorter than the ruling:\n\n`
    + `${away.map((a) => `- to ${a.stage}: ${a.text}`).join("\n")}\n\n`
    + "Leave each of those alone. Doing one of them here would change work this proposal is not answerable for, and the stage it was addressed to would then be asked for it again.";
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

// The other thing a `--revise` run can start from: a request filed by a ruling elsewhere
// that named this stage (`addressed-to <stage>: <why>`). What that stage last produced was
// approved and merged, so there is no returned proposal to revise from and, until this,
// no way to open the artifact at all — which left a pipeline whose gates only move forward
// unable to record what the work downstream of a decision discovers about it.
//
// Reopening is not accepting. The request makes the stage runnable again and nothing else:
// the revision it produces is a fresh proposal at that stage's own gate, ruled by the
// holder of that gate, so an upstream artifact is never changed on the say-so of a
// downstream reviewer alone.
//
// Taken up on a real run only, in a commit of its own on `main` — a dry run is asking what
// would happen, and taking the request would be an answer that changed the question. The
// entry is marked rather than removed, so what was asked for, by whom and from which
// proposal stays readable long after the revision is merged.
export function requestedRevision(projectDir, stage, ctx) {
  const [request] = openRevisionRequestsFor(projectDir, stage);
  if (!request) return null;
  if (!ctx.dryRun && takeRevisionRequest(projectDir, request)) {
    stagePaths(projectDir, [REVISION_REQUESTS_PATH]);
    git([...SDLC_AUTHOR, "commit", "-q", "-m", `record(${stage}): ${request.from} asks ${stage} to revise`], projectDir);
  }
  return { name: null, branch: null, request, rationale: "", conditions: [], addressedElsewhere: [] };
}

// Where a revision came from, in the prompt's own words: ordinarily the ruling that
// returned this stage's own proposal, and for a reopening the ruling at another gate that
// asked for it. Both carry the ruler's text verbatim, because a stage sent back to work
// with no account of what was wrong does the same work again.
//
// The reopening block says which proposal, which gate and which seat, since none of that
// is anywhere the stage can see, and it says where the result goes: a stage told only to
// change something could otherwise read the request as the decision it is not.
export function revisionRulingBlock(ctx) {
  const r = ctx.revision?.request;
  if (!r) return `The ruling that returned it:\n\n${ctx.revision?.rationale ?? ""}`;
  return [
    `This revision was not asked for by a ruling on a proposal of your own. What this stage last produced was approved, and ${r.from} — ruled at ${r.gate} by ${r.by} — carried a condition addressed to this stage: the work downstream of yours showed something about it that could not have been known when it was ruled.`,
    `What that ruling asked for, in its own words:\n\n${r.why}`,
    "Change only what it names and leave everything else exactly as you found it. What you produce is a fresh proposal at this stage's own gate, and that gate decides whether the change is accepted — the ruling that asked for it does not.",
  ].join("\n\n");
}

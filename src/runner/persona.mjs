import { join } from "node:path";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { readText } from "../lib/fsx.mjs";
import { git, gitOk } from "../lib/git.mjs";
import { deliveredBy, stageForProposal } from "../stages/registry.mjs";
import { ADDRESSED_CONDITION_FORM, CONDITION_MET_FORM, CONDITION_WITHDRAWN_FORM, MISSING_TEST_CONDITION_FORM, approvableConditionForms, conditionsAreExecutable, returnOnlyConditionForms } from "../spec/criteria.mjs";
import { openOn } from "../spec/owed.mjs";
import { missingTestRef, openMissingTestsAt } from "../spec/missing-tests.mjs";
import { blocksOnMissingTests } from "../config/policy.mjs";
import { readSlice } from "../stages/slices.mjs";
import { stackBulk } from "../lib/stack.mjs";
import { configSection, rulingConfig } from "./ruling-config.mjs";
import { runChecks } from "../checks/index.mjs";
import { formatChecks } from "../commands/checks.mjs";
import { formatTypecheckEvidence } from "./typecheck.mjs";
import { buildSliceOf, readVerifyResult, verifyResultPath, formatVerifyEvidence } from "./verify-evidence.mjs";
import { criteriaEvidenceFor } from "./criteria-evidence.mjs";

// The diff of files outside app/ is the reviewer's evidence, not a transcript to
// reproduce in full: a proposal that touches a lot of generated or vendored text would
// otherwise blow the prompt budget for no gain, so it is capped and the cut is marked.
const DIFF_CAP = 60000;

// G3 rules on a whole acceptance suite or a whole adapter at once — one spec file per
// criterion, and a domain has tens of them — so the default cap falls inside the very
// files the ruling is about. The gate's own cap is twice as large; every other gate keeps
// the default.
const DIFF_CAP_BY_GATE = { G3: 120000 };

function diffCapFor(gate) {
  return DIFF_CAP_BY_GATE[gate] ?? DIFF_CAP;
}

// Paths whose diff is never evidence for a ruling. `site/` is the regenerated state
// site, `.sdlc/runs/` the run record and `.sdlc/journal/` the stage's own journal entry
// — all three are derived from the very work being ruled on, all three change on every
// run, and between them they can be larger than everything the persona actually needs to
// read. `.sdlc/proposals/` holds the proposal page itself, which is quoted in full higher
// up in the prompt, so its diff is the same text a second time. Excluded by pathspec so
// none of them enter the budget at all. `app/` is excluded for a different reason: the
// personas that hold the spec-side gates rule on the spec, not on an implementation.
const DIFF_EXCLUDE = [":!site", ":!.sdlc/runs", ":!.sdlc/journal", ":!.sdlc/proposals"];

// No single file takes more than this share of the budget while other files are still
// waiting to be shown. A diff is evidence about a change, and one file of it — a
// resolved dependency tree, a generated client, a data baseline nobody wrote by hand —
// can be larger than the whole budget on its own, which leaves the ruler the opening
// hunks of one machine-written file and nothing else at all. The last file in the order
// is exempt: by then nothing is waiting, so the rest of the budget is its to use.
const FILE_SHARE = 0.25;

// `app/` is evidence exactly when the proposal is about it. A spec-side proposal — a
// domain file, a derived suite, an adapter — never touches the application, so leaving it
// out there costs its persona nothing and keeps an implementation out of a ruling on the
// spec. A build proposal IS `app/`, and ruling one without it is ruling on the builder's
// own summary of work nobody read.
function excludesFor(projectDir, branch, omit = []) {
  const touchesApp = git(["diff", `main...${branch}`, "--name-only", "--", "app"], projectDir);
  const app = touchesApp ? [] : [":!app"];
  return [...app, ...DIFF_EXCLUDE, ...omit.map((p) => `:!${p}`)];
}

// The stage's own output, first — the whole point of the ruling. Without this the diff
// is ordered however git lists paths (alphabetically), so a G1 archaeology proposal
// whose domain file sorts late could have that file, the one thing being ruled on, cut
// off by the cap while `.gitattributes` and a contract stub made it in. Longest prefix
// wins, so `spec/domains/` outranks `spec/` rather than tying with it.
const PRIORITY_PATHS = {
  G0: ["intent/"],
  G1: ["spec/domains/", "spec/"],
  // G3 holds both the spec-side derivations and the build. What a build ruling turns on
  // is what the acceptance suite established and what the slice was asked to satisfy, so
  // the suite result, the tests and the adapter that drove them come before the
  // application: a builder who changed the tests he is judged against is the first thing
  // the ruler needs to see, and the application is what the rest of the budget is for.
  G3: ["tests/results/", "tests/acceptance/", "tests/adapters/", "app/", "evidence/"],
};

// Orders `files` so that anything under one of `prefixes` comes first, in the order the
// prefixes are given, and everything else keeps the order git listed it in.
export function orderDiffPaths(files, prefixes = []) {
  const rank = (f) => {
    let best = prefixes.length;
    for (let i = 0; i < prefixes.length; i++) if (f.startsWith(prefixes[i])) { best = Math.min(best, i); }
    return best;
  };
  return files
    .map((f, i) => ({ f, i, r: rank(f) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.f);
}

// A cut says what was cut. A count alone — "3 further changed file(s) not shown" — tells
// the ruler that evidence is missing and gives it no way to decide whether the ruling
// turns on it; the paths are cheap, and with them the ruler can read the one file it
// needs on the branch or return the proposal saying which file it could not see.
const NAMED_CUTS = 25;

function cutNotice(cut) {
  const named = cut.slice(0, NAMED_CUTS).join(", ");
  const rest = cut.length > NAMED_CUTS ? `, and ${cut.length - NAMED_CUTS} more` : "";
  return `[${cut.length} changed file(s) not shown, in the order they were dropped: ${named}${rest}. Read them on the branch if the ruling turns on one of them.]`;
}

// The diff, one file at a time in `orderDiffPaths` order, concatenated until the cap is
// reached. Per file rather than in one `git diff` call because git orders its own output
// by path and ignores the order of the pathspec it was given, and the order is the whole
// point: the cap has to fall on the least important file, not on whichever one happens to
// sort last. A file whose own diff would overflow its share is still started, so the
// reader sees its header and its opening hunks rather than nothing at all, and every cut
// is marked with what was left out of it.
function orderedDiff(projectDir, branch, gate, omit = []) {
  const range = `main...${branch}`;
  const listed = git(["diff", range, "--name-only", "--", ".", ...excludesFor(projectDir, branch, omit)], projectDir);
  const files = orderDiffPaths(listed ? listed.split("\n").filter(Boolean) : [], PRIORITY_PATHS[gate] ?? []);
  const cap = diffCapFor(gate);
  const perFile = Math.floor(cap * FILE_SHARE);
  const parts = [];
  const cut = [];
  let used = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (used >= cap) { cut.push(f); continue; }
    const one = git(["diff", range, "--", f], projectDir);
    if (!one) continue;
    const room = cap - used;
    const limit = i === files.length - 1 ? room : Math.min(room, perFile);
    if (one.length <= limit) { parts.push(one); used += one.length; }
    else {
      parts.push(`${one.slice(0, limit)}\n[truncated: ${f} — ${one.length - limit} of ${one.length} characters of this file's diff are not shown. Read the file on the branch if the ruling turns on the rest.]`);
      used += limit;
    }
  }
  if (cut.length) parts.push(cutNotice(cut));
  return parts.join("\n");
}

// Read from `main`, not from the working tree. A ruling has the proposal's own branch
// checked out, and that branch carries the briefs as they stood on the day it was opened
// — so without this a correction to a persona never reaches the proposals that were
// already open when it was made, and an old branch silently rules by retired
// instructions. The brief is the ruler's own instruction sheet, not part of the proposal
// being ruled, which is why it does not belong to the branch. The working tree is the
// fallback for a project whose `main` has no brief committed yet.
export function readPersonaBrief(projectDir, persona) {
  const rel = `.sdlc/personas/${persona}.md`;
  if (gitOk(["cat-file", "-e", `main:${rel}`], projectDir)) return git(["show", `main:${rel}`], projectDir);
  const p = join(projectDir, rel);
  if (!existsSync(p)) throw new Error(`no persona brief for ${persona}`);
  return readText(p);
}

// The gates a persona will not rule alone, declared in a YAML front-matter block at the
// top of its brief (`escalates: [G-POL]`) rather than inferred from the brief's prose.
// The prose still says why, for the agent that reads it; this is what the runner acts on.
export function personaEscalates(brief) {
  const m = brief.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return [];
  let front;
  try { front = parseYaml(m[1]); } catch { return []; }
  const v = front?.escalates;
  return Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [];
}

// The brief as the persona reads it: the front matter is the runner's business, and
// leaving it in the prompt invites an agent to reason about a field it cannot act on.
export function briefBody(brief) {
  return brief.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

// What the stage this proposal goes back to can actually change, put in front of the ruler
// before the ruling is written rather than after. A condition naming anything else is
// refused when the verdict is recorded, and a refusal is a worse way to learn this than a
// sentence: the ruling turn has already been paid for by then.
//
// Left out entirely for a proposal that goes back to no stage — its conditions are read in a
// closed grammar, or its return is a person's to take up — so an ordinary ruling prompt
// reads exactly as it always has.
function deliverabilityNote(name) {
  const stage = stageForProposal(name);
  if (!stage) return [];
  const delivers = deliveredBy(stage);
  if (!delivers.length) return [];
  return [
    "## What a condition may ask for",
    "",
    `A return sends this proposal back to \`${stage}\`, whose workspace is writable only where it is `
      + `collected: it delivers ${delivers.join(", ")} and nothing else. Every other path it is given is `
      + "there to be read.",
    "",
    `A condition naming a path outside that list is refused when the verdict is recorded. Where the work `
      + `belongs to another stage, say so in the condition itself: \`${ADDRESSED_CONDITION_FORM}\`. That files a `
      + "request the named stage reads on its own next revision, and this proposal is ruled on what it is "
      + "answerable for.",
    "",
  ];
}

// Which condition forms each verdict may carry, put in front of the ruler before the ruling
// is written rather than discovered when it is refused. Generated from
// `CONDITION_FORM_RULES` (`src/spec/criteria.mjs`), which is the table the guards that
// refuse the verdict read — the same arrangement the deliverability note below has, and for
// the same reason: a rule stated in one place and enforced from another drifts, and the
// ruler is the one who pays for the drift, because a refusal costs the turn that reached
// the ruling.
//
// Left out where the proposal's conditions are read in a closed grammar. These verbs are
// not read out of one at all, so stating a rule about them there would describe a check
// that never runs on the lines this ruler is about to write.
//
// The closing line is the part that matters most. Unlike every other condition defect,
// this one is not a line to rewrite: the ruler has reached two positions at once, and what
// it is being asked for is which of the two it means.
function conditionFormsNote(name, gate) {
  if (conditionsAreExecutable(gate, name)) return [];
  const entry = (r) => `- \`${r.form}\` — it ${r.because}.`;
  return [
    "## Which condition forms a verdict may carry",
    "",
    "A condition line is read for the forms below, and the form decides which verdicts may carry it.",
    "A verdict carrying a form it may not is refused when the ruling is recorded, and the ruling turn",
    "has been spent by then.",
    "",
    "**Either verdict** may carry these, and free-text lines besides:",
    "",
    ...approvableConditionForms().map(entry),
    "",
    "**A return only** may carry these:",
    "",
    ...returnOnlyConditionForms().map(entry),
    "",
    "Where you would approve and attach one of the return-only forms, that is two positions at once and",
    "the pipeline records neither: return the proposal and keep the condition, or approve and leave it off.",
    "Which you mean is the ruling, so decide it here rather than leaving it to be refused.",
    "",
    "A free-text line on an approval is kept on the gate file and owed by nobody: no stage reads it, and",
    "nothing asks after it again. Where you approve and something is still owed, say so in a form that",
    `records it — a clause of a criterion no test asserts is \`${MISSING_TEST_CONDITION_FORM}\` — or return.`,
    "",
  ];
}

// What a ruler does about an instruction an earlier ruling left owed, and which ones those
// are. The two lines that close one are what is missing from a brief, and not writing
// either leaves the instruction open.
//
// Read from `main` and quoted here rather than pointed at. The ledger lives on `main` —
// a return files its conditions there because a branch nobody merges is a record nobody
// reads — so the copy on a proposal's own branch is whatever had been filed the day the
// branch was opened, and the checks section above reads that copy. The guard that refuses
// a ruling for closing a reference nothing has open reads `main`'s, so a ruler working
// from the branch's list can write a reference the guard will not take, or pass over one
// nobody has accounted for, and learn either only when the turn has been spent.
//
// A person in this seat is handed no prompt and reads the same list out of
// `sdlc checks` on `main`, with the same two lines in it: this is how an agent is given
// what a person would go and read, and both seats close a condition with the identical
// line.
function accountingNote(open) {
  if (!open.length) return [];
  const quote = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  return [
    "## Instructions an earlier ruling left owed",
    "",
    "These are open on `main`, which is where the ledger lives and what a ruling is checked against:",
    "",
    ...open.map((c) => `- \`${c.ref}\` — "${quote(c.text)}" (asked of ${c.stage ?? "?"}, ruled at ${c.gate ?? "?"} on ${c.from ?? "?"})`),
    "",
    "Where this proposal settles one, say so in a condition of your own — on an approval as readily",
    "as on a return:",
    "",
    `- \`${CONDITION_MET_FORM}\``,
    `- \`${CONDITION_WITHDRAWN_FORM}\``,
    "",
    "A reference you do not account for stays open and is put to whoever rules next, which is the right",
    "answer where this proposal does not settle it. What must not happen is an approval that passes over",
    "one in silence: the instruction then reads as done to everything that comes after.",
    "",
  ];
}

// The tests the proposal's criteria are owed, and the ones its stage owes, read from `main` the
// way the condition ledger is. A build slice's ruler is shown every item naming a criterion the
// slice claims, and whether the project's policy refuses an approval past them; the ruler of any
// other stage's proposal is shown what that stage owes, which is what its proposal may have
// supplied or handed on. A person in the seat reads the same list from `sdlc checks`, and both
// seats withdraw an item with the same line.
function missingTestsNote(projectDir, name, { slice, verify, config }) {
  const open = openMissingTestsAt(projectDir, "main");
  if (!open.length) return [];
  const stage = stageForProposal(name);
  const claimed = slice ? new Set([...(readSlice(projectDir, slice)?.criteria ?? []), ...(verify?.rows ?? []).map((r) => r?.id)]) : new Set();
  const shown = open.filter((e) => claimed.has(e.item) || (stage && e.stage === stage));
  if (!shown.length) return [];
  const quote = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  const blocks = slice && blocksOnMissingTests(config) && shown.some((e) => claimed.has(e.item));
  return [
    "## Tests these criteria are owed",
    "",
    "Each of these was recorded as untestable, in whole or in one clause, and is owed a test that runs. It stays",
    "open until a result row shows its test ran at the criterion's current version, and where it names a clause,",
    "until a test asserting that clause is derived; a ruling cannot say it was met.",
    "",
    ...shown.map((e) => `- \`${missingTestRef(e.item)}\` — owed by ${e.stage}${e.clause ? ` for the clause "${quote(e.clause)}", which no test asserts` : ""}: "${quote(e.why)}"`),
    "",
    ...(blocks ? [
      "This project's policy.gates.G3.block_on_missing_tests is true: an approval of this slice is refused while an",
      "item above names one of its criteria, unless the ruling withdraws it.",
      "",
    ] : []),
    "Where no test is owed for one after all, withdraw it in a condition of your own, with the reason:",
    "",
    `- \`${CONDITION_WITHDRAWN_FORM}\``,
    "",
  ];
}

export async function buildPersonaPrompt(projectDir, name, persona, { tier, gate = null, typecheck = null, escalation = null }) {
  const brief = readPersonaBrief(projectDir, persona);
  const proposalPath = join(projectDir, ".sdlc", "proposals", `${name}.md`);
  const proposal = readText(proposalPath);

  const branch = `proposal/${name}`;
  const stat = git(["diff", `main...${branch}`, "--stat"], projectDir);

  // The slice's verify result is quoted in a section of its own below, so its diff would
  // be the same text a second time — the same reason the proposal page is left out.
  const slice = buildSliceOf(name);
  const verify = slice ? readVerifyResult(projectDir, branch, slice) : null;

  // The configuration the ruling reasons from: `main`'s, except where this proposal
  // changes a block or the block is the policy it was made under
  // (`./ruling-config.mjs`). Everything below that reads a configured value reads it from
  // here rather than off the checkout, which carries the day the branch was opened.
  const resolved = rulingConfig(projectDir, branch);

  // What the stack profile declares its toolchain writes and the project commits. The
  // files exist on the branch and are named here rather than silently dropped, so a
  // ruler who wants one knows it is there and that nothing tried to hide it.
  const bulk = stackBulk({ stack: resolved.config?.stack ?? null });
  const bulkListed = bulk.length
    ? git(["diff", `main...${branch}`, "--name-only", "--", ...bulk], projectDir)
    : "";
  const bulkFiles = bulkListed ? bulkListed.split("\n").filter(Boolean) : [];

  const outside = orderedDiff(projectDir, branch, gate, [...bulk, ...(slice ? [verifyResultPath(slice)] : [])]);

  // The text of the criteria this proposal touches, resolved from the proposal rather than
  // from the gate it sits at. Which gates get it is decided by the proposals themselves and
  // is not a list kept anywhere: a proposal that derives, assigns or claims criteria names
  // them, and one that does not — an intent, a policy article — names none and gets no
  // section at all. In practice that is the plan gate and the gates that hold the derived
  // suite, the adapters and the build, which are exactly the rulings made by comparing
  // something against a criterion nobody quoted.
  const criteria = criteriaEvidenceFor(projectDir, branch, proposal);

  // `criteria-index` is skipped here: it compares the live domain files on this
  // proposal's own branch against `spec/criteria-index.json`, which only `ratify`
  // regenerates. An archaeology proposal legitimately adds fresh `D-` criteria no
  // `ratify` run has seen yet, so once any domain in the project has been ratified once
  // — the point at which the index file starts existing at all — every later
  // archaeology proposal would show it as stale for criteria that were never meant to
  // be in it, a false failure that has nothing to do with whether this proposal is
  // sound (see `runChecks`'s own comment on `opts.skip`).
  const results = await runChecks(projectDir, { skip: ["criteria-index"] });
  const checksText = formatChecks(results);

  return [
    `# Ruling request: ${name}`,
    "",
    "You are ruling on this proposal as the persona described below. Read the proposal, the",
    "diff and the checks, then rule.",
    "",
    `## Persona brief: ${persona}`,
    "",
    briefBody(brief).trim(),
    "",
    "## Proposal",
    "",
    proposal.trim(),
    "",
    // An escalation is ruled by its target with the escalating persona's own account in
    // front of it: the proposal alone does not say why the gate's holder would not rule.
    ...(escalation ? [
      "## The escalation you are ruling",
      "",
      `${escalation.by} holds this gate and escalated it to you rather than ruling. Its account:`,
      "",
      escalation.rationale,
      "",
      "Rule on the proposal itself, taking that account into it. If the reason it could not be",
      "ruled is that the pipeline cannot do what the proposal needs, escalate: that stops the run",
      "for the person who owns the pipeline.",
      "",
    ] : []),
    "## Tier",
    "",
    tier,
    "",
    ...configSection(resolved),
    // The evidence a build ruling turns on comes before the diff and is never inside its
    // budget: it is what an approval is refused without, and it is the only place the
    // adapter's account of what it could not bind is written down.
    ...(slice ? [
      formatVerifyEvidence({ result: verify, slice, branchAppTree: git(["rev-parse", `${branch}:app`], projectDir) }),
      "",
    ] : []),
    // On the same grounds and in the same place: what the work is judged against belongs in
    // front of the ruler, not inside a budget that decides whether it arrives.
    ...(criteria ? [criteria, ""] : []),
    `## Diff summary (main...${branch})`,
    "",
    stat || "(no changes)",
    "",
    "## Diff of the proposal's own output",
    "",
    "The stage's own output comes first. The generated state site, the run record, the journal",
    "and the proposal page are left out — they are derived from the work being ruled on, or",
    "quoted above already, not evidence about it. A proposal that does not touch the",
    "application leaves `app/` out on the same grounds.",
    ...(bulkFiles.length ? [
      "",
      `Left out as machine-generated, on the project's stack profile: ${bulkFiles.join(", ")}. These files are on the branch and can be read there.`,
    ] : []),
    ...(slice && verify ? [
      "",
      `The verify result (\`${verifyResultPath(slice)}\`) is quoted above rather than shown here as a diff.`,
    ] : []),
    "",
    outside || "(no changes to show)",
    "",
    "## Checks",
    "",
    checksText,
    "",
    ...(typecheck ? [
      "## Runner-owned typecheck evidence",
      "",
      formatTypecheckEvidence(typecheck),
      "",
      "This report was collected by the runner on the proposal checkout, not by the authoring agent.",
      "The blind derive-tests workspace has no installed node_modules and gives its agent no shell.",
      "Dependencies present in this review checkout were not necessarily present in that scratch workspace.",
      "Use the report as compiler evidence; a failed or unavailable check is not a pass.",
      "Do not send a requirement to execute the compiler back to a blind writer that cannot run it.",
      "The writer can fix reported TypeScript errors; the runner owns executing the check.",
      "",
    ] : []),
    ...accountingNote(openOn(projectDir, "condition")),
    ...missingTestsNote(projectDir, name, { slice, verify, config: resolved.config }),
    ...conditionFormsNote(name, gate),
    ...deliverabilityNote(name),
    `Finish with one fenced \`\`\`json block: {"verdict": "approve"|"return"|"escalate", "rationale": "...", "conditions": [...]}. Nothing after the block.`,
  ].join("\n");
}

export function parseVerdict(text) {
  const re = /```json\s*([\s\S]*?)```/g;
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (last === null) throw new Error("no verdict block in persona reply");
  let parsed;
  try { parsed = JSON.parse(last); } catch (e) { throw new Error(`bad verdict block: ${e.message}`); }
  if (!["approve", "return", "escalate"].includes(parsed.verdict)) throw new Error(`bad verdict: ${parsed.verdict}`);
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
  if (!rationale.trim()) throw new Error("verdict has no rationale");
  return { verdict: parsed.verdict, rationale, conditions: parsed.conditions ?? [] };
}

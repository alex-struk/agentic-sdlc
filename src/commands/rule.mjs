import { join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { git, gitOk, assertCleanTree, porcelainStatus, stagePaths, stageSite, currentBranch, enterBranch, leaveBranch, SDLC_AUTHOR } from "../lib/git.mjs";
import { readText, writeText } from "../lib/fsx.mjs";
import { redactLocalPaths } from "../lib/redact.mjs";
import { loadConfig, parseConfig } from "../config/load.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { buildPersonaPrompt, parseVerdict, readPersonaBrief, personaEscalates } from "../runner/persona.mjs";
import { runAgent, endedBecause, preflightAuth, turnsFor, DEFAULT_MAX_TURNS } from "../runner/executor.mjs";
import { acceptanceTypecheck, formatTypecheckEvidence } from "../runner/typecheck.mjs";
import { writeJournal } from "../runner/journal.mjs";
import { stallReason } from "../runner/escalation.mjs";
import { buildSite } from "./status.mjs";
import { ADDRESSED_CONDITION_FORM, ADDRESSED_VERB, CONDITION_MET_FORM, CONDITION_WITHDRAWN_FORM, OVERREACH_CONDITION_FORM, OVERREACH_VERB, accountedConditions, addressedConditions, conditionFormRule, conditionGrammarFor, conditionsAreExecutable, malformedAccountedConditions, malformedAddressedConditions, malformedOverreachConditions, overreachConditions, splitConditionsByAddressee } from "../spec/criteria.mjs";
import { close as closeOwed, conditionRef, open as openOwed, openOn, owedPath } from "../spec/owed.mjs";
import { MISSING_TEST, blockingMissingTests, missingTestRef, openMissingTestsAt, parseMissingTestRef, syncMissingTests, withdrawMissingTest } from "../spec/missing-tests.mjs";
import { readSlice } from "../stages/slices.mjs";
import { loadIndex } from "../checks/tests.mjs";
import { proposalFamily, revisableStages, stageForProposal, undeliverableConditions } from "../stages/registry.mjs";
import { COMMANDS } from "../cli.mjs";
import { printNextBlock } from "./next.mjs";
import { heldByFor } from "../lib/seat.mjs";
import { approvesUnasserted, blocksOnMissingTests, escalateTiers } from "../config/policy.mjs";
import { proposedPolicyChange } from "../runner/ruling-config.mjs";

// Which grammar a proposal's conditions are read in is a property of the conditions, so it
// is defined with them; `rule` is what applies it, and is where a caller reaches it.
export { conditionGrammarFor, conditionsAreExecutable };

function mergeApproved(projectDir, branch, message) {
  git(["checkout", "-q", "main"], projectDir);
  try {
    git([...SDLC_AUTHOR, "merge", "-q", "--no-ff", "-m", message, branch], projectDir);
  } catch (e) {
    // A failed merge leaves main mid-merge, which is the worst place to stop: the
    // ruling is recorded, main is unbuildable, and nothing says why. Unwind it and name
    // the files a person has to reconcile. Where the caller is left standing is not
    // decided here — `leaveRuling` gives the borrowed branch back for every ruling that
    // throws, and a message here claiming a branch would be claiming one of two places.
    const conflicted = gitOk(["diff", "--name-only", "--diff-filter=U"], projectDir)
      ? git(["diff", "--name-only", "--diff-filter=U"], projectDir) : "";
    git(["merge", "--abort"], projectDir);
    const files = conflicted ? `\nconflicted files:\n  ${conflicted.split("\n").join("\n  ")}` : "";
    throw new Error(`merging ${branch} into main failed; main was left unchanged and the ruling stays on ${branch}.${files}\n${e.message}`);
  }
}

// A literal block scalar's indentation is normally inferred from its first non-blank
// line, which breaks the moment a rationale's own first line starts with whitespace:
// the parser reads that whitespace as part of the declared indentation, then a later
// line indented less than that (including a plain 2-space continuation line) falls
// outside the block and is parsed as a sibling of `rationale:` — invalid YAML. `|2-`
// pins the indentation to exactly the two spaces this function adds and strips the
// scalar's own trailing newline, so the parsed value is always exactly `text` back,
// regardless of what its first line looks like.
function blockScalar(text) {
  return text.split("\n").map((l) => (l ? `  ${l}` : "")).join("\n");
}

// Two turns' worth of cost, turns and session folded into one figure rather than the
// second overwriting the first — the same shape `finishStage`'s own fix turn already
// folds (`src/runner/finish-stage.mjs`). A ruling that needed a second turn to reach its
// verdict spent both of them, and a gate file or a caller told about only the last one is
// told less than the ruling actually cost: the turn that got refused or failed is still a
// turn that was paid for. The session named is the first turn's — the transcript a person
// would go back and read is the one the ruling started as, not whichever turn happened to
// answer last.
function sumMetrics(a, b) {
  return { cost: (a?.cost ?? 0) + (b?.cost ?? 0), turns: (a?.turns ?? 0) + (b?.turns ?? 0), session: a?.session || b?.session || "" };
}

// The gate file's body differs by who ruled and how: a human writes a free-text
// `note`; an agent approving or returning writes a `rationale` block plus the
// `conditions` it attached to the verdict; an escalation (mandatory or agent-decided)
// writes a `rationale` and an `escalate_to`, with no conditions. Building the text in
// one place keeps all three shapes consistent (same key order, same block-scalar
// convention) without any caller knowing about another's fields.
//
// `metrics` is what a ruling turn cost — the same three numbers a stage's journal entry
// records, so the state site can total what the pipeline spent on rulings alongside
// what it spent on stages. Every agent path passes it, including a mandatory escalation
// that never asked the persona anything (cost 0, no session); a human ruling has no
// turn to measure and the keys are left out of its file entirely.
function gateFileText({ gate, verdict, by, heldBy, note, rationale, conditions, unparsed, escalateTo, stalled, metrics, reprompt }) {
  let text = `gate: ${gate}\nverdict: ${verdict}\nby: ${by}\nheld_by: ${heldBy}\n`;
  if (escalateTo !== undefined) text += `escalate_to: ${escalateTo ?? ""}\n`;
  // Written only on an escalation that hands the question to the role that raised it
  // (`src/runner/escalation.mjs`). `escalate_to` stays as the verdict named it, because
  // that is what was ruled; this is the line that stops the pair reading as a hand-off.
  if (stalled) text += `stalled: ${JSON.stringify(stalled)}\n`;
  if (rationale !== undefined) text += `rationale: |2-\n${blockScalar(rationale)}\n`;
  else text += `note: ${JSON.stringify(note ?? "")}\n`;
  // Written only where a guard refused the first reply and the persona was asked again
  // (`ruleByAgent`'s `askOnce` called a second time over the same defect) — what the first
  // attempt got wrong, in the persona's own words. This is the ruling's own record that it
  // took two turns to reach what it says, which nothing else on disk carries: the verdict
  // and conditions below are already the corrected reply, and without this line they read
  // as if the persona wrote them right the first time.
  if (reprompt) text += `reprompt: |2-\n${blockScalar(reprompt)}\n`;
  // Conditions are written wherever a ruler attached any, which is what lets a person in
  // a gate seat return a proposal with the same structured list an agent in that seat
  // returns it with. Every stage that acts on a return reads `conditions`, so a seat that
  // could only record one free-text line was a seat that could not rule the same ruling.
  if (conditions !== undefined) {
    const list = conditions ?? [];
    text += list.length ? `conditions:\n${list.map((c) => `  - ${JSON.stringify(c)}`).join("\n")}\n` : `conditions: []\n`;
    // Written only when there are some. A gate file carrying this key is a ruling whose
    // conditions the grammar for its own proposal could not read even after the persona
    // was asked again — the lines are kept verbatim so a person can see exactly what was
    // meant and correct it in place, and `ratify` refuses to act on a ruling carrying any.
    if (unparsed?.length) text += `unparsed_conditions:\n${unparsed.map((c) => `  - ${JSON.stringify(c)}`).join("\n")}\n`;
  }
  if (metrics) {
    const { cost = 0, turns = 0, session = "" } = metrics;
    text += `cost: ${cost}\nturns: ${turns}\nsession: ${JSON.stringify(session)}\n`;
  }
  text += `at: ${new Date().toISOString()}\n`;
  return text;
}

// The state site is a tracked artifact of `main` and of nothing else: every page is
// regenerated whole from the whole project, so a site carried on a proposal branch
// conflicts with every other open proposal's on the way in. Stages that hold a gate
// therefore build no site (`src/runner/finish-stage.mjs`), and rulings own it.
//
// An approval has already merged onto `main` by the time this runs, so the rebuilt site
// is folded into that merge commit with `--amend` rather than trailing behind it as a
// second commit or an uncommitted diff. The site it produces reflects `main`'s complete
// gate history, this ruling included.
function amendSiteOntoMergeCommit(projectDir) {
  buildSite(projectDir);
  stageSite(projectDir);
  git([...SDLC_AUTHOR, "commit", "-q", "--amend", "--no-edit"], projectDir);
}

// A return or an escalation leaves its ruling commit on the proposal branch, where it
// belongs — nothing about it has been accepted. The site still gets regenerated, on
// `main`, so the pages stay current with whatever `main` actually holds; when that turns
// out to be unchanged, nothing is committed. The caller is put back on the branch it was
// on, so a returned proposal is still checked out for whoever has to act on it.
function regenerateSiteOnMain(projectDir, reason) {
  const branch = currentBranch(projectDir);
  if (branch !== "main") git(["checkout", "-q", "main"], projectDir);
  try {
    buildSite(projectDir);
    stageSite(projectDir);
    if (git(["diff", "--cached", "--name-only"], projectDir)) {
      git([...SDLC_AUTHOR, "commit", "-q", "-m", `chore(site): regenerate after ${reason}`], projectDir);
    }
  } finally {
    if (branch !== "main") git(["checkout", "-q", branch], projectDir);
  }
}

// The words for each of the three fixable line defects below, shared between the throw
// that refuses a ruling over one and the re-prompt in `ruleByAgent` that tries to head the
// throw off first: the persona reads the identical sentence either way, whether it is
// being asked to fix the line before anything is spent on refusing it, or being told why
// it was refused after a second try still had it wrong.
function overreachGuidance(line) {
  return `${JSON.stringify(line)} carries no reason. Write it as \`${OVERREACH_CONDITION_FORM}\`:`
    + " the reason is what the next derive-tests run is given in place of the test it is replacing, and a request without one produces the same test again.";
}
function addressedGuidance(line) {
  return `${JSON.stringify(line)} carries no reason. Write it as \`${ADDRESSED_CONDITION_FORM}\`:`
    + " the stage it is addressed to sees none of the evidence this ruling was made on, so the reason is the whole of what reaches it.";
}
function deliverableGuidance(found) {
  const delivers = found.delivers.length ? found.delivers.join(", ") : "nothing";
  const remedy = found.deliverableBy.length
    ? `${found.deliverableBy.join(" or ")} delivers it. Address the condition there instead:\n`
      + `  ${ADDRESSED_VERB} ${found.deliverableBy[0]}: <what that stage has to change, and what showed it>`
    : "no stage in this pipeline delivers it, so no ruling can ask for it; say what this proposal must do instead,"
      + " and take the rest up outside the pipeline.";
  return `${JSON.stringify(found.line)} asks for ${found.path}, which ${found.stage} cannot deliver —`
    + ` ${found.stage} delivers ${delivers}, and everything else its workspace carries is there to be read.`
    + ` A condition it cannot carry out is one it either fails at or finds a way round, and the second is reported as done.`
    + ` ${remedy}`;
}

const collapse = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

function accountedGuidance(line) {
  return `${JSON.stringify(line)} carries no reason. Write it as \`${CONDITION_MET_FORM}\` or \`${CONDITION_WITHDRAWN_FORM}\`:`
    + " closing an instruction while recording nothing about why is the state this ledger exists to end.";
}
// The words for an approval carrying a form only a return may carry, taken from the same
// table the ruling prompt states the rule from (`CONDITION_FORM_RULES`,
// `src/spec/criteria.mjs`). Unlike the three defects above this is not a line to rewrite:
// the verdict and the condition are two positions at once, and what is asked for is which
// of them the ruler means. Both ways out are named, because both are rulings and neither
// is the pipeline's to pick.
function approvalFormGuidance(verb, line) {
  const rule = conditionFormRule(verb);
  return `${JSON.stringify(line)} is a \`${verb}\` condition, which ${rule.because}. An approval may not carry it:`
    + " return the proposal and keep the condition, or approve and leave it off. Which you mean is the ruling.";
}

// The words for an approval the branch holds no current passing verify result for, taken
// from `buildVerified`'s own account of what is missing. Like the pairing above this is not
// a line to rewrite: the evidence is a fact about the branch rather than about how the
// ruling was written down, and what is asked for is which ruling the ruler means now that
// an approval is not one of them. Both remaining verdicts are named, and both were already
// open to it whatever the evidence said (`0022`).
function approvalEvidenceGuidance(reason) {
  return `${reason}. An approval is recorded only against a current passing verify result, so this one cannot be:`
    + " return the proposal and keep your findings as its conditions, or escalate."
    + " Which you mean is the ruling.";
}

// A missing test is closed by a test that runs and by nothing a ruler writes, so the one
// accounting line it takes is a withdrawal. The open items are listed the way the conditions
// are, so the line can be written again against what is actually owed.
function missingTestRefGuidance(ref, verb, open) {
  if (verb === "met") {
    return `${JSON.stringify(ref)} is a missing test, and a missing test is closed only by a test that runs: a result row for`
      + " its criterion at the current version that passed or failed. No ruling can say it was met. Where no test is owed after all,"
      + ` withdraw it with \`${CONDITION_WITHDRAWN_FORM}\` and say why.`;
  }
  const list = open.length
    ? `The missing tests still open are: ${open.map((e) => `${missingTestRef(e.item)} (owed by ${e.stage})`).join("; ")}.`
    : "No missing test is open in this project, so there is nothing here to withdraw.";
  return `${JSON.stringify(ref)} is not an open missing test. ${list}`;
}

// The first accounting line naming a missing test that cannot be recorded: `condition-met` on
// one, or a reference to an item nothing has open on `main`.
function missingTestAccountDefect(projectDir, conditions) {
  const lines = accountedConditions(conditions).filter((a) => parseMissingTestRef(a.ref));
  if (!lines.length) return null;
  const met = lines.find((a) => a.outcome === "met");
  if (met) return { ref: met.ref, verb: "met", open: [] };
  const open = openMissingTestsAt(projectDir, "main");
  const ids = new Set(open.map((e) => e.item));
  const unknown = lines.find((a) => !ids.has(parseMissingTestRef(a.ref)));
  return unknown ? { ref: unknown.ref, verb: "withdrawn", open } : null;
}

// The criteria a ruling withdraws the missing tests of.
function withdrawnMissingTests(conditions) {
  return accountedConditions(conditions).filter((a) => a.outcome === "withdrawn").map((a) => parseMissingTestRef(a.ref)).filter(Boolean);
}

function unknownRefGuidance(ref, open) {
  const list = open.length
    ? `The conditions still open are: ${open.map((c) => `${c.ref} (${JSON.stringify(collapse(c.text))})`).join("; ")}.`
    : "No condition is open in this project, so there is nothing here to close.";
  return `${JSON.stringify(ref)} is not an open condition. ${list}`;
}

// What a refusal here must not cost a second time. None of the three throws below has
// written anything by the time it fires — no gate file, no proposal section, no commit —
// so this message is the only place left holding a ruling that may have cost a full agent
// turn (two, where a re-prompt was already tried and the line still came back wrong). The
// verdict and every condition it carried are appended, not only the one line that sank it,
// so a person reading the refusal can act on the rest of the ruling by hand rather than
// paying for the turn again to find out what it said.
function withRulingPreserved(message, verdict, conditions) {
  const list = (conditions ?? []).length
    ? conditions.map((c) => `  - ${JSON.stringify(c)}`).join("\n")
    : "  (none)";
  return `${message}\n\nNothing is recorded — the guard refuses before anything is written. What this ruling produced:\n`
    + `  verdict: ${verdict}\n  conditions:\n${list}`;
}

// The two things a `test-overreaches` condition may never be, checked before a ruling
// writes anything at all — no gate file, no commit, nothing filed — so a refused line
// leaves the proposal exactly as open as it was.
//
// A line with no reason is refused because the reason is the whole of what this form
// carries: `derive-tests` is handed it in place of the test it is replacing, and a request
// that says only "write this one again" produces the same test again. Whitespace is not a
// reason.
//
// An approval may not carry it because this verdict asks for a test to be re-derived and
// asserts nothing about the criterion. The criterion stays unverified until a regenerated
// test binds and passes, and a route that let an approval carry it would be a route by
// which a criterion nothing can exercise is signed off with a note about its test.
export function assertOverreachRulable(name, verdict, conditions) {
  const bad = malformedOverreachConditions(conditions);
  if (bad.length)
    throw new Error(withRulingPreserved(`rule ${name}: ${overreachGuidance(bad[0])}`, verdict, conditions));
  const carried = (conditions ?? []).find((l) => overreachConditions([l]).length);
  if (verdict === "approve" && carried)
    throw new Error(withRulingPreserved(`rule ${name}: ${approvalFormGuidance(OVERREACH_VERB, carried.line)}`, verdict, conditions));
}

// The two things an `addressed-to` condition may never be, checked in the same place and
// for the same reasons as the pair above, before a ruling writes anything at all.
//
// A line with no reason is refused because the reason is the whole of what travels. The
// stage the request reaches sees none of the evidence the ruling was made on — not the
// proposal, not the diff, not the result the ruler read — so a request that says only
// "change this" arrives as the fact that somebody was unhappy and nothing else.
//
// An approval may not carry it because the condition says an artifact this pipeline is
// building on is wrong. A verdict that accepts the proposal while asking another stage to
// redo what this one was built against would put both claims on the record at once, and
// merge the work on the strength of the first.
export function assertAddressedRulable(name, verdict, conditions) {
  const bad = malformedAddressedConditions(conditions);
  if (bad.length)
    throw new Error(withRulingPreserved(`rule ${name}: ${addressedGuidance(bad[0])}`, verdict, conditions));
  const carried = (conditions ?? []).find((l) => addressedConditions([l]).length);
  if (verdict === "approve" && carried)
    throw new Error(withRulingPreserved(`rule ${name}: ${approvalFormGuidance(ADDRESSED_VERB, carried.line)}`, verdict, conditions));
}

// The one thing a plain condition may never be: an instruction to change a path the stage
// receiving it has no way to deliver. Checked in the same place and for the same reasons as
// the two above, before a ruling writes anything at all.
//
// A stage's workspace is writable only where it is collected, so a condition naming anything
// else asks for work that is either refused mid-run or done and then dropped. The ruler is
// the only person who can put it right — by the time a `--revise` run reads the condition the
// ruling is history, and the stage reading it has no standing to re-address it — so the
// refusal happens here, while the ruler is still at the keyboard and the correction is one
// line. `addressed-to <stage>` is that line, and the message hands it over ready to paste.
//
// Only a return is checked. An approval's conditions are commentary that no `--revise` run
// reads, and the verdicts that may not carry a cross-stage request at all are refused above.
export function assertDeliverableRulable(name, verdict, conditions) {
  if (verdict !== "return") return;
  const [first] = undeliverableConditions(name, conditions ?? []);
  if (!first) return;
  throw new Error(withRulingPreserved(`rule ${name}: ${deliverableGuidance(first)}`, verdict, conditions));
}

// The two things an accounting line may never be, checked in the same place and for the
// same reasons as the three above, before a ruling writes anything at all.
//
// A line with no reason is refused because the reason is the whole of what the entry gains:
// `condition-met` with nothing after the colon records that somebody closed an instruction
// and nothing about what was done, which leaves the ledger saying exactly as little as it
// said before this existed.
//
// A reference nothing open matches is refused because it closes nothing and reads as though
// it closed something. It is a typo or a guess at a name, and both seats are handed the list
// of what is actually open so the line can be written again.
//
// Unlike the other two verbs this is checked on every verdict. A revision that satisfied a
// condition is ordinarily approved, and that approval is exactly where a ruler should be
// able to say so; a rule that only a return may account for earlier work would make the
// commonest case the one the ledger cannot record.
export function assertAccountedRulable(projectDir, name, verdict, conditions) {
  const bad = malformedAccountedConditions(conditions);
  if (bad.length) throw new Error(withRulingPreserved(`rule ${name}: ${accountedGuidance(bad[0])}`, verdict, conditions));
  const missing = missingTestAccountDefect(projectDir, conditions);
  if (missing) throw new Error(withRulingPreserved(`rule ${name}: ${missingTestRefGuidance(missing.ref, missing.verb, missing.open)}`, verdict, conditions));
  const open = openOn(projectDir, "condition");
  const refs = new Set(open.map((c) => c.ref));
  const unknown = accountedConditions(conditions).find((a) => !parseMissingTestRef(a.ref) && !refs.has(a.ref));
  if (unknown) throw new Error(withRulingPreserved(`rule ${name}: ${unknownRefGuidance(unknown.ref, open)}`, verdict, conditions));
}

// The first defect in a ruling's conditions that a second turn can answer, checked in the
// order the hard asserts below apply them and reporting only the first, so the re-prompt
// always names the line the refusal would have named.
//
// Two kinds of defect are read here and they are answered differently. Most are formatting
// slips — a verb used without its reason, a plain line naming a path outside the stage's
// workspace, a reference to a condition nothing has open — and the second turn is asked to
// rewrite one line and leave the rest alone.
//
// An approval carrying a form only a return may carry is the other kind. It is the verdict
// and the condition disagreeing about what was just ruled, and the ruler's position behind
// it can be entirely coherent: the artifact in front of it is right, and a different
// artifact has to change. What the pipeline cannot do is record both claims, so the second
// turn is asked which of the two it means. The ruling is not re-opened — both ways out
// were already the ruler's to take, and neither is picked for it — and the guard below is
// unchanged, so a reply that comes back with the same pairing is refused exactly as it
// always was.
function firstFixableConditionDefect(projectDir, name, verdict, conditions) {
  const overreach = malformedOverreachConditions(conditions)[0];
  if (overreach) return { kind: "overreach", line: overreach };
  const carriedOverreach = verdict === "approve" && (conditions ?? []).find((l) => overreachConditions([l]).length);
  if (carriedOverreach) return { kind: "approval-form", verb: OVERREACH_VERB, line: carriedOverreach };
  const addressed = malformedAddressedConditions(conditions)[0];
  if (addressed) return { kind: "addressed", line: addressed };
  const carriedAddressed = verdict === "approve" && (conditions ?? []).find((l) => addressedConditions([l]).length);
  if (carriedAddressed) return { kind: "approval-form", verb: ADDRESSED_VERB, line: carriedAddressed };
  const accounted = malformedAccountedConditions(conditions)[0];
  if (accounted) return { kind: "accounted", line: accounted };
  // A reference to a condition nothing has open is the same kind of slip: the persona was
  // shown the open list and wrote a name that is not on it, which a rewrite fixes and a
  // refusal only throws a ruling away over.
  const missing = missingTestAccountDefect(projectDir, conditions);
  if (missing) return { kind: "missing-test-ref", ...missing };
  const open = openOn(projectDir, "condition");
  const refs = new Set(open.map((c) => c.ref));
  const unknown = accountedConditions(conditions).find((a) => !parseMissingTestRef(a.ref) && !refs.has(a.ref));
  if (unknown) return { kind: "unknown-ref", ref: unknown.ref, open };
  if (verdict === "return") {
    const [undeliverable] = undeliverableConditions(name, conditions);
    if (undeliverable) return { kind: "deliverable", ...undeliverable };
  }
  return null;
}

// Every defect a second turn can answer, in the order the refusals below apply them, so the
// re-prompt always names what the refusal would have named.
//
// One re-prompt covers all of them together rather than one apiece. A ruling gets a second
// turn, not a second turn per guard: that is the ceiling the unparsed-conditions path set
// and the reason it set it — a reply that gets it wrong twice is no longer making a slip,
// and a batch running unattended must not turn one stuck proposal into an unbounded retry.
//
// The conditions are read only where they are free text. Where a closed grammar owns them
// the stage that owns the grammar is what reads them, and `grammar.unparsed` above has
// already had its own turn on them.
function firstRepromptableDefect(projectDir, name, verdict, conditions, { executable, onEscalation, config }) {
  const condition = executable ? null : firstFixableConditionDefect(projectDir, name, verdict, conditions);
  if (condition) return condition;
  // The evidence an approval stands on, read here for the same reason the pairing above is:
  // the ruler produced a verdict, a rationale and a set of conditions, and refusing throws
  // all of it away over a fact the ruler can be told and answer in one more turn. What is
  // quoted back is the evidence, and what is asked for is a verdict the evidence supports.
  // An approval on a standing escalation is exempt here exactly as it is in the guard: the
  // absent result is what the escalation was raised about.
  if (verdict === "approve" && !onEscalation) {
    const verified = buildVerified(projectDir, name, config);
    if (!verified.ok) return { kind: "approval-evidence", reason: verified.reason };
  }
  // And the tests the slice's criteria are owed, on the same footing: a fact about the
  // record, quoted back with every way out still open to the ruler.
  if (verdict === "approve") {
    const blocking = missingTestsBlocking(projectDir, name, conditions, config);
    if (blocking.length) return { kind: "missing-tests", blocking };
  }
  return null;
}

// The sentence a persona is asked to fix, in the same words the throw would have used.
function defectGuidance(defect) {
  if (defect.kind === "overreach") return overreachGuidance(defect.line);
  if (defect.kind === "addressed") return addressedGuidance(defect.line);
  if (defect.kind === "accounted") return accountedGuidance(defect.line);
  if (defect.kind === "unknown-ref") return unknownRefGuidance(defect.ref, defect.open);
  if (defect.kind === "approval-form") return approvalFormGuidance(defect.verb, defect.line);
  if (defect.kind === "approval-evidence") return approvalEvidenceGuidance(defect.reason);
  if (defect.kind === "missing-test-ref") return missingTestRefGuidance(defect.ref, defect.verb, defect.open);
  if (defect.kind === "missing-tests") return missingTestsGuidance(defect.blocking);
  return deliverableGuidance(defect);
}

// The re-prompt itself, built the same way the unparsed-conditions one above is: the
// original prompt, the persona's own verdict quoted back, the offending line, and what
// would have been read instead.
//
// The closing instruction differs by what is wrong. A misshapen line has a rewrite, and the
// rest of the ruling is to be left untouched. An approval carrying a return-only form has
// no rewrite — the two ways out are two verdicts — so that reply is asked to choose, and
// told that leaving the pairing as it stands ends the ruling with nothing recorded.
const REPROMPT_CLOSING = {
  rewrite: [
    "Rule again. Keep the conditions that were fine exactly as they were, rewrite this one as shown above,",
    "and finish with the JSON block as before.",
  ],
  choose: [
    "Rule again, and say which of the two you mean. Keep everything else exactly as it was, and finish with",
    "the JSON block as before. A reply that approves and still carries the condition is refused, and nothing",
    "of the ruling is recorded.",
  ],
  evidence: [
    "Rule again, and give the verdict you mean. Keep the rest of the ruling exactly as it was, and finish",
    "with the JSON block as before. A reply that approves again is refused, and nothing of the ruling is",
    "recorded.",
  ],
  missing: [
    "Rule again. Return or escalate the slice, or, for each item you judge is owed no test at all, withdraw it",
    "in a condition of its own with the reason. Keep the rest of the ruling exactly as it was, and finish with",
    "the JSON block as before. A reply that approves with an item still open is refused, and nothing of the",
    "ruling is recorded.",
  ],
};

// The heading the second turn reads, the closing it is given, and the line a person watching
// a batch sees. A defect with a rewrite is one line to fix and the rest of the ruling to
// leave alone; a verdict at odds with a condition form or with the evidence has no rewrite,
// because the two ways out are two verdicts.
const REPROMPT_SHAPE = {
  "approval-form": {
    closing: "choose",
    heading: "Your previous reply approved and asked for another artifact to be changed",
    said: "the first reply approved and asked for another artifact to be changed",
  },
  "approval-evidence": {
    closing: "evidence",
    heading: "Your previous reply approved a proposal with no passing verify result",
    said: "the first reply approved with no passing verify result",
  },
  "missing-tests": {
    closing: "missing",
    heading: "Your previous reply approved a slice whose criteria are still owed a test",
    said: "the first reply approved a slice whose criteria are still owed a test",
  },
};
const REWRITE_SHAPE = {
  closing: "rewrite",
  heading: "Your previous reply had a condition this stage cannot carry out",
  said: "the first reply's condition could not be carried out",
};
const repromptShape = (defect) => REPROMPT_SHAPE[defect.kind] ?? REWRITE_SHAPE;

function defectReprompt(prompt, verdict, defect) {
  const shape = repromptShape(defect);
  return [
    prompt,
    "",
    `## ${shape.heading}`,
    "",
    `You ruled ${verdict}. ${defectGuidance(defect)}`,
    "",
    ...REPROMPT_CLOSING[shape.closing],
  ].join("\n");
}

// Files the revisions a ruling's `addressed-to` conditions ask for onto
// `.sdlc/revision-requests.yaml`, where the addressed stage's own `--revise` run reads them.
//
// On `main`, and in its own commit, for the reason `fileOverreachRequests` below gives: the
// ruling belongs to the proposal branch and the request does not, and a copy of it on a
// branch nobody merges would never be read by the stage it is addressed to.
//
// A stage with no revision mode is not filed for and comes back in `unroutable`: a request
// nothing can take up would sit on the list for ever, and the ruler is told which name
// could not be placed rather than left to assume it was.
function fileAddressedRequests(projectDir, { name, gate, by, conditions }) {
  const asked = addressedConditions(conditions ?? []);
  if (!asked.length) return { addressed: [], unroutable: [] };
  const revisable = new Set(revisableStages());
  const branch = currentBranch(projectDir);
  if (branch !== "main") git(["checkout", "-q", "main"], projectDir);
  try {
    const at = new Date().toISOString();
    const entries = [];
    const unroutable = [];
    for (const a of asked) {
      if (!revisable.has(a.stage)) { unroutable.push(a.stage); continue; }
      entries.push({ stage: a.stage, why: a.text, from: name, gate, by, at });
    }
    const { path, added } = openOwed(projectDir, "request", entries);
    const addressed = added.map((e) => e.stage);
    if (path) {
      stagePaths(projectDir, [path]);
      git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} asks ${addressed.join(", ")} to revise`], projectDir);
    }
    return { addressed, unroutable };
  } finally {
    if (branch !== "main") git(["checkout", "-q", branch], projectDir);
  }
}

// The redo entries a ruling's `test-overreaches` conditions ask for, built against the
// contract the project actually holds. The version is the one the criterion carries now, the
// same version `test-wrong` records, so the writer and the person reading the list afterwards
// both know which statement the test was judged to have reached past.
//
// `verb` is on these entries and not on a `test-wrong` one, and the difference is the point
// rather than an inconsistency: both ask for the same test to be written again, and they say
// different things about why. `test-wrong` says the test got the criterion wrong; this says
// the test asked for more than the criterion, which is an instruction about what the
// replacement must *not* do. `derive-tests` words the two differently, and an entry with no
// verb on it is the unmarked kind.
//
// An id the contract does not hold is not filed at all and comes back in `unfiled`: a request
// naming a criterion nothing can derive would sit on the list for ever, since only a run that
// derives that id ever closes it.
export function overreachRedoEntries(projectDir, conditions) {
  const index = loadIndex(projectDir);
  const byId = new Map(((index && !index.parseError ? index.criteria : null) ?? []).map((c) => [c.id, c]));
  const entries = [];
  const unfiled = [];
  for (const { id, text } of overreachConditions(conditions)) {
    const c = byId.get(id);
    if (!c) { unfiled.push(id); continue; }
    entries.push({ id, version: c.version, why: text, verb: OVERREACH_VERB });
  }
  return { entries, unfiled };
}

// Files the criteria a ruling's `test-overreaches` conditions name onto
// `tests/acceptance/redo.yaml`, where `derive-tests --domain <d> --stale` reads them.
//
// On `main`, and in its own commit. The ruling itself lives on the proposal branch, which
// is right — nothing about the proposal has been accepted — but the request is not part of
// the proposal: it is the pipeline's own bookkeeping, and a copy of it sitting on a branch
// nobody merges would never be read by the stage it is addressed to. `regenerateSiteOnMain`
// steps onto `main` and back for the same reason, and the caller is left on the branch it
// was on either way.
//
// An id already on the list is not filed a second time — the first reason recorded is the
// one somebody wrote about — and `filed` names only what this ruling actually added, so a
// replayed ruling reports nothing rather than claiming a request it did not make.
function fileOverreachRequests(projectDir, { name, gate, conditions }) {
  if (!overreachConditions(conditions ?? []).length) return { filed: [], unfiled: [] };
  const branch = currentBranch(projectDir);
  if (branch !== "main") git(["checkout", "-q", "main"], projectDir);
  try {
    const { entries, unfiled } = overreachRedoEntries(projectDir, conditions);
    const { path, added } = openOwed(projectDir, "redo", entries);
    const filed = added.map((e) => e.id);
    if (path) {
      stagePaths(projectDir, [path]);
      git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} sends ${filed.join(", ")} back to derive-tests`], projectDir);
    }
    return { filed, unfiled };
  } finally {
    if (branch !== "main") git(["checkout", "-q", branch], projectDir);
  }
}

// The ledger side of a ruling: the plain conditions this return is putting on the record as
// owed, and the earlier ones this ruling accounts for. Both go to `.sdlc/conditions.yaml` on
// `main`, in one commit, for the reason `fileAddressedRequests` gives — the ruling belongs to
// the proposal branch and this does not, and a copy on a branch nobody merges is a ledger
// nothing ever reads.
//
// Which conditions are filed is decided by what a condition is rather than by who wrote it.
// A **return's plain conditions** are instructions the stage it goes back to is meant to
// carry out, and they are the ones nothing followed. `addressed-to` and `test-overreaches`
// lines are left out — each has a ledger of its own that already follows it from filing to
// consumption — and so are the accounting lines, which are about this ruling rather than
// work for anybody. An **approval's** conditions are left out too: no `--revise` run reads
// them, so there is nothing to be owed.
//
// A ruling in a closed grammar (`ratify` and `calibrate` at G1, the reviewer's triage page)
// files nothing either. Those conditions are applied by a stage through a fixed vocabulary
// and are followed by that stage's own records; filing them here would be a second ledger
// for work already tracked, and one nobody would close.
function recordConditions(projectDir, { name, gate, by, verdict, conditions, executable }) {
  const lines = conditions ?? [];
  const { accounted } = splitConditionsByAddressee(lines);
  const stage = stageForProposal(name);
  const owed = verdict === "return" && !executable && stage
    ? lines.map((line, i) => ({ line, i })).filter(({ line }) => splitConditionsByAddressee([line]).mine.length)
      .map(({ line, i }) => ({ ref: conditionRef(name, i), text: line, from: name, family: proposalFamily(name), gate, stage, by, at: new Date().toISOString() }))
    : [];
  if (!owed.length && !accounted.length) return { opened: [], closed: [] };
  const branch = currentBranch(projectDir);
  if (branch !== "main") git(["checkout", "-q", "main"], projectDir);
  try {
    const opened = openOwed(projectDir, "condition", owed).path ? owed.map((o) => o.ref) : [];
    const closed = [];
    const paths = new Set(opened.length ? [owedPath("condition")] : []);
    for (const a of accounted) {
      const id = parseMissingTestRef(a.ref);
      if (id) {
        if (a.outcome === "withdrawn" && withdrawMissingTest(projectDir, id, { why: a.text, by })) {
          closed.push({ ref: a.ref, outcome: a.outcome });
          paths.add(owedPath(MISSING_TEST));
        }
        continue;
      }
      if (closeOwed(projectDir, "condition", (c) => c.ref === a.ref, { outcome: a.outcome, why: a.text, by })) {
        closed.push({ ref: a.ref, outcome: a.outcome });
        paths.add(owedPath("condition"));
      }
    }
    if (opened.length || closed.length) {
      const said = [opened.length ? `owes ${opened.join(", ")}` : "", closed.length ? `closes ${closed.map((c) => `${c.ref} ${c.outcome}`).join(", ")}` : ""]
        .filter(Boolean).join("; ");
      stagePaths(projectDir, [...paths]);
      git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} ${said}`], projectDir);
    }
    return { opened, closed };
  } finally {
    if (branch !== "main") git(["checkout", "-q", branch], projectDir);
  }
}

// Shared by the human path and the agent-approve/return path: write the gate file,
// append the run record, stage exactly those paths (plus the proposal page when the
// caller already appended a `## Ruling` section to it), commit, merge on approve, and
// fold the rebuilt site into that same commit.
function commitRuling(projectDir, { name, branch, gate, verdict, by, heldBy, note, rationale, conditions, unparsed, metrics, proposalPath, proposalAppended, executable, reprompt }) {
  const gatePath = join(".sdlc", "gates", `${name}.yaml`);
  // A ruling's rationale and conditions are an agent's own prose, and its typecheck
  // evidence is a compiler's output: both routinely quote a path on the machine the
  // ruling ran on. The gate file is committed and read straight into the state site, so
  // rule E-2's redaction applies here for the same reason it applies to the journal and
  // the proposal page (`src/lib/redact.mjs`).
  writeText(join(projectDir, gatePath),
    redactLocalPaths(gateFileText({ gate, verdict, by, heldBy, note, rationale, conditions, unparsed, metrics, reprompt }), projectDir));
  const runPath = appendRun(projectDir, `rule ${name} ${verdict} at ${gate} by ${by} (${heldBy})`);
  const paths = [gatePath, relative(projectDir, runPath)];
  if (proposalAppended) paths.push(relative(projectDir, proposalPath));
  stagePaths(projectDir, paths);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} ${verdict} by ${by}`], projectDir);
  // After the ruling commit, never before it: if filing the request fails, the ruling is
  // still recorded and the proposal is still returned. An approval never carries this
  // form at all (`assertOverreachRulable`).
  const requests = verdict === "approve" || executable
    ? { filed: [], unfiled: [], addressed: [], unroutable: [] }
    : { ...fileOverreachRequests(projectDir, { name, gate, conditions }),
      ...fileAddressedRequests(projectDir, { name, gate, by, conditions }) };
  // After the request ledgers and for the same reason they run after the ruling commit: the
  // ruling is recorded and the proposal is returned whatever happens here.
  const ledger = recordConditions(projectDir, { name, gate, by, verdict, conditions, executable });
  let missingTests = null;
  if (verdict === "approve") {
    mergeApproved(projectDir, branch, `merge: ${name} approved at ${gate} by ${by}`);
    missingTests = recordMissingTests(projectDir, { name, gate, by });
    amendSiteOntoMergeCommit(projectDir);
  } else {
    regenerateSiteOnMain(projectDir, `${name} ${verdict}`);
  }
  return { ...requests, ...ledger, ...(missingTests ? { missingTests } : {}) };
}

// What an approval changes about the tests the project is owed, staged into the merge commit:
// an item for every untestable record the merge brought onto `main` (and for any record already
// there that nothing had written down), an item moved where the merge rewrote its record's owner,
// and an item closed where the merge brought a result showing its test ran
// (`src/spec/missing-tests.mjs`). `main` is checked out and the merge is `HEAD`, so the commit
// before it is what `main` held when the ruling began.
function recordMissingTests(projectDir, { name, gate, by }) {
  const { config } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  const before = git(["rev-parse", "HEAD^1"], projectDir);
  const r = syncMissingTests(projectDir, { before, from: name, stage: stageForProposal(name), gate, by, config });
  if (!r.path) return null;
  stagePaths(projectDir, [owedPath(MISSING_TEST)]);
  return { opened: r.opened, readdressed: r.readdressed, closed: r.closed };
}

// An escalation, whether the persona ruled one or the brief and the tier made it mandatory.
//
// Both paths come through here, which is where a verdict that hands the question to the
// role the seat itself holds is caught: the check is the same two names either way, and a
// mandatory escalation at a gate whose holder is its own escalation target is as circular
// as one a persona reasoned its way to. The stall is recorded rather than refused, and the
// rationale, the metrics and the target the verdict named are all written exactly as they
// would have been — what is added is the sentence saying the proposal has not moved.
//
// Returns the stall's reason, or `null`, so the caller can say it on the terminal in the
// turn it happened rather than leaving an operator to read the gate file.
function writeEscalation(projectDir, { name, gate, by, escalateTo, rationale, metrics, reprompt }) {
  const stalled = stallReason({ by, escalateTo });
  const gatePath = join(".sdlc", "gates", `${name}.yaml`);
  writeText(join(projectDir, gatePath),
    redactLocalPaths(gateFileText({ gate, verdict: "escalated", by, heldBy: "agent", escalateTo, stalled, rationale, metrics, reprompt }), projectDir));
  const runPath = appendRun(projectDir, `rule ${name} escalated at ${gate} to ${escalateTo ?? "?"} by ${by}`
    + (stalled ? ` — stalled: ${stalled}` : ""));
  stagePaths(projectDir, [gatePath, relative(projectDir, runPath)]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} ${stalled ? "stalled" : `escalated to ${escalateTo ?? "?"}`}`], projectDir);
  regenerateSiteOnMain(projectDir, stalled ? `${name} stalled` : `${name} escalated`);
  return stalled;
}

// What a refused ruling leaves behind. A refusal writes no gate file — that is the point of
// it — and until this it wrote nothing else either, so a ruling that spent a turn (two, where
// a re-prompt was tried) left the project looking exactly like one nobody had ruled, with the
// reasoning the turn reached gone along with the session it was reached in.
//
// On `main`, in a commit of its own, for the reason `fileAddressedRequests` gives: a refused
// ruling belongs to no branch — the proposal is still open, and may be ruled again or
// abandoned — and a record on a branch nobody merges is a record nobody reads. `main` is also
// what the state site reads its costs from, so a turn spent on a refusal is counted in the
// project's total rather than missing from it.
//
// Two entries, because they answer different questions. The run record's line is the one a
// person scanning what happened to this proposal reads; the journal entry beside it holds the
// verdict, the rationale and every condition the ruling produced, which is what an operator
// needs to act on the rest of a ruling by hand instead of paying for the turn again.
//
// Best-effort and silent about its own failures: the refusal is what the caller is owed and
// has to reach them whatever happens here.
function recordRefusal(projectDir, { name, gate, by, heldBy, produced, reason, metrics }) {
  // A tampered tree records nothing at all. `git checkout main` carries uncommitted changes
  // across wherever the file is identical on both branches, so switching branches to record
  // would put whatever the turn wrote onto `main` under a commit about a refused ruling, and
  // what a turn wrote has to stay where it was made so it is still visible there.
  if (porcelainStatus(projectDir)) return;
  const word = produced ? "refused" : "unanswered";
  // The guard's own sentence without the copy of the ruling `withRulingPreserved` appends to
  // it: the run record is one line per outcome, and the whole of the ruling is in the journal
  // entry written beside it.
  const headline = String(reason ?? "").split("\n\n")[0].trim();
  const body = [
    "## Nothing was ruled",
    "",
    `The ruling was ${word}, so no gate file was written and the proposal is still open at ${gate}.`,
    "",
    String(reason ?? "").trim(),
    ...(produced ? [
      "",
      "## What the ruling produced",
      "",
      `**Verdict:** ${produced.verdict}`,
      `**By:** ${by}`,
      "",
      produced.rationale?.trim() || "No rationale accompanied the verdict.",
      "",
      "**Conditions:**",
      (produced.conditions ?? []).length ? (produced.conditions ?? []).map((c) => `- ${c}`).join("\n") : "none",
    ] : []),
    "",
  ].join("\n");
  const branch = currentBranch(projectDir);
  try {
    if (branch !== "main") git(["checkout", "-q", "main"], projectDir);
    const journalPath = writeJournal(projectDir, { stage: "rule", title: `${name} ${word} at ${gate}`, body, metrics });
    const runPath = appendRun(projectDir, `rule ${name} ${word} at ${gate} by ${by} (${heldBy}): ${headline}`);
    stagePaths(projectDir, [relative(projectDir, journalPath), relative(projectDir, runPath)]);
    // The journal and the runs page are both built into the site, so the site goes into the
    // same commit — otherwise the next `status` or ruling rebuilds it, finds it changed, and
    // fails its clean-tree check on a diff this refusal left behind.
    buildSite(projectDir);
    stageSite(projectDir);
    git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} ${word}`], projectDir);
  } catch { /* nothing here may replace the refusal the caller is being handed */ }
  finally { if (currentBranch(projectDir) !== branch) gitOk(["checkout", "-q", branch], projectDir); }
}

function appendRulingSection(text, { verdict, by, rationale, conditions = [], typecheck = null }) {
  const cond = conditions.length ? conditions.map((c) => `- ${c}`).join("\n") : "none";
  const evidence = typecheck ? `\n### Runner-owned typecheck evidence\n\n${formatTypecheckEvidence(typecheck)}\n` : "";
  return `${text}\n## Ruling\n\n**Verdict:** ${verdict}\n**By:** ${by}\n\n${rationale}\n\n**Conditions:**\n${cond}\n${evidence}`;
}

// Gives the proposal's branch back when a ruling did not finish.
//
// A ruling borrows a branch: `openGate` checks it out to read the proposal, the config and
// the briefs off it, and every successful path hands it back to the place its own verdict
// belongs — an approval ends on `main` with the merge, a return and an escalation end on
// the proposal branch for whoever has to act on it. A ruling that throws was handing it
// back nowhere, and the caller was left standing on the proposal branch, where the next
// `sdlc run` refuses `assertOnMain` for a reason that has nothing to do with its own input.
// `fileOverreachRequests` and `regenerateSiteOnMain` in this file restore through `finally`
// for the same reason; this is the same contract for the borrow that wraps all of them.
//
// The failure that got here is always what comes out of here. A tree the ruling left dirty
// keeps HEAD on the branch that dirtied it, because `git checkout` carries uncommitted
// changes across and residue has to stay visible where it was made; a checkout that fails
// outright is a second fact rather than a replacement for the first. Both are said on
// stderr and only the original is thrown, the way `sandbox` and `verify` unwind their own
// branch borrows.
function leaveRuling(projectDir, start, branch, failure) {
  let dirty = "";
  try { dirty = leaveBranch(projectDir, start); }
  catch (err) {
    console.error(`rule ${branch}: HEAD could not be put back on ${start} and is still on ${branch};`
      + ` check it out by hand once the cause below is dealt with. The checkout said: ${err.message}`);
    return failure;
  }
  if (dirty) {
    console.error(`rule ${branch}: the working tree was left dirty on ${branch}, so HEAD is still there.`
      + ` Inspect and clean it, then check out ${start}:\n${dirty}`);
  }
  return failure;
}

// The proposal's branch, checked out, with everything a ruling reads off it. `enterBranch`
// records where HEAD was so `leaveRuling` can put it back; the refusals raised below are
// about the proposal rather than about the branch, and must not cost the caller its place
// either.
function openGate(projectDir, name) {
  const branch = `proposal/${name}`;
  if (!gitOk(["rev-parse", "--verify", branch], projectDir)) throw new Error(`no proposal branch ${branch}`);
  const start = enterBranch(projectDir, branch, "rule");
  try {
    const proposalPath = join(projectDir, ".sdlc", "proposals", `${name}.md`);
    const proposalText = existsSync(proposalPath) ? readText(proposalPath) : null;
    const gateMatch = proposalText ? proposalText.match(/^gate:\s*(\S+)/m) : null;
    if (!gateMatch) throw new Error(`proposal ${name} has no gate line`);
    const gate = gateMatch[1];
    const { config: branchConfig, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
    if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);
    const governed = governingConfig(projectDir, branch, name, gate, branchConfig);
    if (governed.refusal) throw new Error(governed.refusal);
    const { config } = governed;
    const g = config.policy.gates[gate];
    if (!g) throw new Error(`gate ${gate} is not in policy`);
    return { branch, start, proposalPath, proposalText, gate, g, config };
  } catch (e) {
    throw leaveRuling(projectDir, start, branch, e);
  }
}

// The configuration a ruling acts on, and whether the proposal may be ruled at `gate` at all.
// Ordinarily it is the branch's own (`0013`, `0038`). A proposal that changes the `policy`
// block is ruled at G-POL and nowhere else, and under the policy on `main`: the policy it
// proposes is its subject, and a change that could name who rules it would be ruled by
// whoever it named (`0043`). The same for both seats, since both reach it through here or
// through `rulePending`.
function governingConfig(projectDir, branch, name, gate, branchConfig) {
  const change = proposedPolicyChange(projectDir, branch);
  if (!change.changed) return { config: branchConfig, refusal: null };
  if (gate !== "G-POL") {
    return { config: branchConfig, refusal: `proposal ${name} changes the policy block of .sdlc/config.yaml and is at ${gate}; a change to policy is ruled only at G-POL. Withdraw it and propose the policy change at G-POL on its own` };
  }
  return { config: { ...branchConfig, policy: change.mainPolicy }, refusal: null };
}

// `conditions` is what a person in a gate seat attaches to a verdict, and it is the same
// list an agent in that seat attaches: one line per thing that has to change, read back by
// whichever stage acts on the return. Left out entirely — the ordinary approval — the gate
// file carries the free-text `note` alone, exactly as it always has.
export function rule(projectDir, name, verdict, { by, note = "", conditions } = {}) {
  projectDir = resolve(projectDir);
  if (!["approve", "return"].includes(verdict)) throw new Error("verdict must be approve or return");
  if (!by) throw new Error("rule needs --by <role or agent:persona>");
  assertCleanTree(projectDir, "rule");
  const { branch, start, gate, g, config } = openGate(projectDir, name);
  try {
    const allowed = [g.holder, g.escalate_to].filter(Boolean);
    if (!allowed.includes(by)) throw new Error(`${by} is not a holder of ${gate} (allowed: ${allowed.join(", ")})`);
    const executable = conditionsAreExecutable(gate, name);
    // Derived through the same mapping the site reads it back with, so what is written and
    // what is displayed cannot drift apart (`src/lib/seat.mjs`). Gate holders are roles or
    // `agent:<persona>`, so a person is what a bare role means here — but the derivation is
    // total over anything it is handed, because the one reading a default must never reach
    // is the human one.
    const heldBy = heldByFor(by);
    // The same evidence the seat's persona is held to, so that sitting in the seat is the
    // whole of what changes when a person takes it. A build with no passing result is
    // returnable here and unapprovable here, exactly as it is on the agent path; the one
    // approval that goes through without one is the escalation target's, which the
    // escalation already on the branch is the record of.
    //
    // And recorded the same way when it is refused. No turn was spent on this seat, so there
    // is no cost to account for and nothing of the person's own typing is at risk — but what
    // happened to the proposal is the same fact from either seat, and a record that carries
    // it from one and not the other is a record of which seat ruled rather than of what was
    // ruled.
    const escalation = standingEscalation(projectDir, name);
    try {
      if (!executable) {
        assertOverreachRulable(name, verdict, conditions ?? []);
        assertAddressedRulable(name, verdict, conditions ?? []);
        assertDeliverableRulable(name, verdict, conditions ?? []);
        assertAccountedRulable(projectDir, name, verdict, conditions ?? []);
      }
      assertApprovalEvidence(projectDir, name, verdict,
        Boolean(escalation) && by === g.escalate_to && escalation.by !== by, conditions ?? [], config);
      assertNoMissingTests(projectDir, name, verdict, conditions ?? [], config);
    } catch (e) {
      recordRefusal(projectDir, { name, gate, by, heldBy, reason: e.message, metrics: {},
        produced: { verdict, rationale: note, conditions: conditions ?? [] } });
      throw e;
    }
    const requests = commitRuling(projectDir, { name, branch, gate, verdict, by, heldBy, note, conditions, executable });
    return { gate, verdict, heldBy, note, conditions: conditions ?? [], ...requests };
  } catch (e) {
    throw leaveRuling(projectDir, start, branch, e);
  }
}

// What to say a ruling turn failed for. The turn's own text when it has any; otherwise
// the CLI's account of how the session ended (`endedBecause` — "hit the turn cap", say),
// and only then a fixed line, so a failure is never reported as an empty string.
function rulingFailure(result) {
  if (result.text?.trim()) return result.text.trim();
  const ended = endedBecause(result.raw);
  return ended ? `the ruling turn reported failure with no output; the session ${ended}`
    : "the ruling turn reported failure with no output";
}

// How many turns a ruling turn may take. Most rulings read a proposal and a diff and
// answer, so a dozen turns is plenty and keeps a runaway persona cheap. A G1 ruling is
// different in kind: it has to read a whole domain file and rule on every criterion in
// it, one condition line each, and a domain of fifty criteria whose citations the
// persona wants to check does not fit in twelve turns — the ruling then fails at the
// cap having written nothing. It runs with the stage default instead. Either ceiling is
// overridden by `policy.turns.rule`, read the same way a stage's turn ceiling is.
// A triage proposal is ruled at G3 but reads like a G1 one: a page of failures, each needing
// its own verdict and evidence read against the adapter, so it gets the same budget.
export function rulingTurns(config, gate, name = "") {
  return turnsFor(config, "rule", gate === "G1" || name.startsWith("calibrate-triage-") ? DEFAULT_MAX_TURNS : 12);
}

// Whether a role is played by an agent in this project. Read from the policy rather than
// configured separately: a project that gives the role a gate of its own as
// `agent:<role>` has already said it simulates that role, and one that names the role
// bare has said a person holds it. The first run of a project is simulated end to end
// (every holder an agent), and this is what lets an escalation stay inside that run
// instead of stopping it for a person nobody asked to take part.
export function simulatedRole(config, role) {
  if (!role) return false;
  return Object.values(config?.policy?.gates ?? {}).some((g) => g?.holder === `agent:${role}`);
}

// The escalation standing on a proposal, read from the gate file on its branch, or null.
// The branch must already be checked out (`openGate` does that); `rulePending` reads the
// same file out of the branch without checking it out, through `escalationOn`.
function standingEscalation(projectDir, name) {
  const path = join(projectDir, ".sdlc", "gates", `${name}.yaml`);
  return existsSync(path) ? escalationIn(readText(path)) : null;
}

function escalationIn(text) {
  let doc;
  try { doc = parseYaml(text); } catch { return null; }
  if (doc?.verdict !== "escalated") return null;
  return { by: doc.by ?? "", rationale: String(doc.rationale ?? "").trim() };
}

function escalationOn(projectDir, branch, name) {
  try { return escalationIn(git(["show", `${branch}:.sdlc/gates/${name}.yaml`], projectDir)); } catch { return null; }
}

// The verify verdicts an approval may be given on: a slice whose every claimed criterion was
// asserted against the application and met, and one where nothing failed and something was
// never asserted (`src/testrun/results.mjs`) — the second only where the project's policy
// lets G3 approve on it (`policy.gates.G3.approve_unasserted`, true by default).
const APPROVABLE_VERDICTS = new Set(["pass", "pass-unasserted"]);

// The four conditions that make a verify result count as current, shared by `buildVerified`
// (the working tree, read off disk once the branch is checked out) and `rulePending`'s
// branch check below (read with `git show`, before the branch is ever checked out) — kept
// in one place so the two paths cannot disagree about what "verified" means.
function verifiedResult(text, name, slice, appTree, next, config) {
  let r;
  try { r = JSON.parse(text); } catch { return { ok: false, reason: `tests/results/new/slice-${slice}.json does not parse; ${next}` }; }
  if (r.proposal !== name) return { ok: false, reason: `the verify result on this branch is for ${r.proposal}; ${next}` };
  // `notPassed` separates the two ways a build can be short of evidence: the suite ran
  // against this tree and the result was not a pass, or there is no current result at all.
  // Both refuse an approval; only the first is a proposal somebody is waiting on a ruling
  // for, which is what `rulePending` says out loud rather than skipping in silence.
  // Both passing verdicts clear this. `pass-unasserted` is a slice where nothing failed and
  // a criterion was never put to the application at all; the ruler is shown which ones and
  // why, in the verify section of the prompt, and decides there whether the slice can be
  // accepted on that footing. Refusing it here would make that a pipeline policy nobody
  // chose, and would take the decision away from the seat that exists to make it.
  if (!APPROVABLE_VERDICTS.has(r.verdict)) return { ok: false, notPassed: true, reason: `${name} did not pass verify` };
  // A project may narrow what G3 approves on: where it has, a slice carrying a criterion
  // nobody asserted is not approvable by either seat, and is returned or escalated instead.
  if (r.verdict === "pass-unasserted" && !approvesUnasserted(config)) {
    const ids = (r.unasserted ?? []).map((u) => u.id).filter(Boolean);
    return { ok: false, notPassed: true,
      reason: `${name} passed verify with ${ids.length ? ids.join(", ") : "criteria"} never asserted against the application, and this project's policy.gates.G3.approve_unasserted is false` };
  }
  if (r.app_tree !== appTree) return { ok: false, reason: `the application changed since it was verified; ${next}` };
  return { ok: true, reason: "" };
}

// A build proposal is ruled on the application it contains having been run against the
// acceptance tests for its criteria (spec §5.12: the reviewer reads the verify results).
// The result counts only for the application as it stands on the branch: a result for an
// earlier tree is evidence about code that is no longer there.
export function buildVerified(projectDir, name, config = null) {
  const m = /^build-slice-(\d+)(?:-\d+)?$/.exec(name);
  if (!m) return { ok: true, reason: "" };
  const path = join(projectDir, "tests", "results", "new", `slice-${m[1]}.json`);
  const next = `run sdlc run verify --slice ${m[1]} first`;
  if (!existsSync(path)) return { ok: false, reason: `${name} has not been verified; ${next}` };
  return verifiedResult(readText(path), name, m[1], git(["rev-parse", "HEAD:app"], projectDir), next, config);
}

// Same check, read off a not-yet-checked-out proposal branch: `rulePending` uses this to
// leave an unverified build proposal out of a batch silently, rather than letting it reach
// `ruleByAgent` and fail loudly there.
export function buildVerifiedOnBranch(projectDir, branch, name, config) {
  const m = /^build-slice-(\d+)(?:-\d+)?$/.exec(name);
  if (!m) return { ok: true, reason: "" };
  const next = `run sdlc run verify --slice ${m[1]} first`;
  let text;
  try { text = git(["show", `${branch}:tests/results/new/slice-${m[1]}.json`], projectDir); }
  catch { return { ok: false, reason: `${name} has not been verified; ${next}` }; }
  return verifiedResult(text, name, m[1], git(["rev-parse", `${branch}:app`], projectDir), next, config);
}

// The evidence an approval turns on, checked against the verdict rather than against the
// seat. A build proposal is approved only where a current verify result says the
// application on its branch passed; a return or an escalation asserts nothing about the
// application, needs no evidence to be true, and is held to none — which is what keeps a
// slice the suite could not bind, or could not run at all, rulable in the one direction
// that is correct for it.
//
// Reading the verdict is the whole of it: a person typing `--by` and the persona holding
// the gate are refused the same approval, for the same reason, in the same words. A guard
// that binds a seat instead of a verdict stops the true failure being recorded, and stops
// it on whichever seat it is enforced on.
//
// The exception is the ruling on a standing escalation. There an approval without a
// passing result is a decision somebody took rather than a check that was skipped, and
// the branch carries both halves of it: the escalation names who raised it and why, and
// the ruling commit on top names who overrode it and why. An escalation is also the only
// way a slice that has exhausted the verify retry ceiling can ever be finished, since a
// fourth build is exactly what that ceiling exists to stop.
//
// Called once the verdict is in hand and before anything about the ruling is written, so
// a refusal leaves the proposal exactly as open as it was.
function assertApprovalEvidence(projectDir, name, verdict, onEscalation, conditions, config) {
  if (verdict !== "approve" || onEscalation) return;
  const verified = buildVerified(projectDir, name, config);
  if (!verified.ok)
    throw new Error(withRulingPreserved(`rule ${name}: ${approvalEvidenceGuidance(verified.reason)}`, verdict, conditions));
}

// The criteria a build slice claims: the plan's list for it, and every criterion its verify
// result has a row for.
function claimedBySlice(projectDir, slice) {
  const ids = new Set(readSlice(projectDir, slice)?.criteria ?? []);
  for (const r of verifyRows(projectDir, slice)) if (r?.id) ids.add(r.id);
  return [...ids];
}

function verifyRows(projectDir, slice) {
  const path = join(projectDir, "tests", "results", "new", `slice-${slice}.json`);
  if (!existsSync(path)) return [];
  try { return JSON.parse(readText(path)).rows ?? []; } catch { return []; }
}

// The missing tests an approval of this build slice would pass over: every item open on `main`
// naming a criterion the slice claims, less those this ruling withdraws and those whose test the
// slice's verify result shows ran. Empty for anything but a build slice, and where the project's
// policy lets G3 approve past them (`policy.gates.G3.block_on_missing_tests`).
function missingTestsBlocking(projectDir, name, conditions, config) {
  const m = /^build-slice-(\d+)(?:-\d+)?$/.exec(name);
  if (!m || !blocksOnMissingTests(config)) return [];
  return blockingMissingTests(projectDir, {
    claimed: claimedBySlice(projectDir, m[1]),
    withdrawn: withdrawnMissingTests(conditions),
    rows: verifyRows(projectDir, m[1]),
  });
}

function missingTestsGuidance(blocking) {
  const one = blocking.length === 1;
  return `${one ? "A criterion" : `${blocking.length} criteria`} this slice claims ${one ? "is" : "are"} owed a test that runs: `
    + `${blocking.map((e) => `${missingTestRef(e.item)} (owed by ${e.stage}: ${JSON.stringify(String(e.why ?? "").replace(/\s+/g, " ").trim())})`).join("; ")}.`
    + " This project's policy.gates.G3.block_on_missing_tests is true, so an approval is recorded only once none is open."
    + ` Return the slice, escalate it, or withdraw each item no test is owed for with \`${CONDITION_WITHDRAWN_FORM}\`, saying why.`;
}

// Refuses an approval of a build slice that would pass over a missing test, for either seat and
// in the same words. Unlike the verify evidence above, a standing escalation does not lift it:
// the item is withdrawn on the record, with its reason, by whoever rules, and an approval that
// passes over one without saying so is the omission this exists to stop.
function assertNoMissingTests(projectDir, name, verdict, conditions, config) {
  if (verdict !== "approve") return;
  const blocking = missingTestsBlocking(projectDir, name, conditions, config);
  if (blocking.length)
    throw new Error(withRulingPreserved(`rule ${name}: ${missingTestsGuidance(blocking)}`, verdict, conditions));
}

// The agent path: no human types --by approve|return. A persona brief is handed to a
// short-lived agent turn along with the proposal, the diff and the checks, and the
// verdict it comes back with is trusted the same way a human's --by is trusted — phase 0
// has no authentication either way (see docs/decisions/0003).
export async function ruleByAgent(projectDir, name, { persona }) {
  projectDir = resolve(projectDir);
  assertCleanTree(projectDir, "rule");
  const { branch, start, proposalPath, proposalText, gate, g, config } = openGate(projectDir, name);
  // What a refusal below has to be able to record, held out here because the catch is where
  // it is recorded from. `turnCost` is what the ruling turns have spent, set whether or not
  // one of them answered; `produced` is the reply the guards are about to be run against, and
  // stays null where nothing was read out of a turn at all; `recorded` says the ruling has
  // reached the point of writing itself down, after which a failure is no longer a refusal
  // and must not be reported as one.
  let turnCost = null;
  let produced = null;
  let recorded = false;
  try {
    const by = `agent:${persona}`;
    // A persona rules the gate it holds. The one other ruling an agent may make is on an
    // escalation, and only where the project plays the escalation's target by an agent
    // too (`simulatedRole`) — a project whose tech lead is a person gets the escalation,
    // as before. A persona never rules its own escalation: that one waits for a person.
    const escalation = standingEscalation(projectDir, name);
    const ruleEscalation = g.holder !== by && Boolean(escalation) && g.escalate_to === persona
      && simulatedRole(config, persona) && escalation.by !== by;
    if (g.holder !== by && !ruleEscalation) {
      const allowed = [g.holder, simulatedRole(config, g.escalate_to) ? `agent:${g.escalate_to} (on an escalation)` : null].filter(Boolean);
      throw new Error(`${by} is not a holder of ${gate} (allowed: ${allowed.join(", ")})`);
    }
    // An agent-held gate with nowhere to escalate is a broken policy, not a ruling this
    // agent can be trusted with — checked before the persona brief is even read, since
    // every path below (mandatory escalation, an `escalate` verdict) needs `escalate_to`.
    if (!g.escalate_to) throw new Error(`gate ${gate} has an agent holder but no escalate_to`);

    const brief = readPersonaBrief(projectDir, persona);
    const tierMatch = proposalText.match(/^tier:\s*(\S+)/m);
    const tier = tierMatch ? tierMatch[1] : config.policy.default_tier;

    // Mandatory escalation happens before the persona is ever asked: an item at a tier the
    // policy names (`policy.escalate_tiers`, HIGH and CRITICAL by default),
    // or a persona whose brief always defers on this gate, never gets a chance to rule.
    // Declared in the brief's front matter (`escalates: [G-POL]`), never read out of its
    // prose. A brief is written for the agent that reads it, so a sentence scoped to one
    // kind of item — "a platform-article change is escalated, never ruled here" — is
    // indistinguishable to a phrase search from a rule covering every gate, and a persona
    // matched that way is switched off entirely without anything saying so.
    const mandatoryReason = escalateTiers(config).includes(tier) ? `tier ${tier}`
      : personaEscalates(brief).includes(gate) ? `${persona} does not rule ${gate} alone`
        : null;

    if (mandatoryReason) {
      const rationale = `mandatory escalation: ${mandatoryReason}`;
      // No persona turn ran, so the ruling cost nothing — recorded as zero rather than
      // omitted, so every agent-held gate file carries the same three keys.
      const stalled = writeEscalation(projectDir, { name, gate, by, escalateTo: g.escalate_to, rationale, metrics: { cost: 0, turns: 0, session: "" } });
      return { verdict: "escalate", rationale, escalated: true, stalled, gate, escalateTo: g.escalate_to };
    }

    // Whether this machine can sign in at all, asked before the ruling turn rather than
    // discovered inside it — the same question `run` asks before it starts a stage
    // (`src/commands/run.mjs`), asked here because a gate seat spends a paid turn too, and
    // spends it twice: a ruling turn that fails is retried once, so a credential too old to
    // refresh is paid for at both attempts before anything says why. The one-turn check runs
    // against the same config home, the same binary and the same flags the ruling turn will
    // use, so it exercises the credential the ruling will actually authenticate with rather
    // than a proxy for it, and it costs a fraction of a cent. Under the mock executor it is
    // skipped, which `preflightAuth` decides for itself, so neither caller has to know.
    //
    // Nothing is recorded for a refusal here, unlike the ones below: no turn was spent, so
    // there is no cost to account for, and no ruling was produced, so there is nothing to
    // preserve. The proposal is left exactly as open as it was, for the same ruling to be
    // made once the sign-in is good again.
    await preflightAuth();

    const typecheck = await acceptanceTypecheck(projectDir, {
      name, gate, revision: git(["rev-parse", "HEAD"], projectDir),
    });
    assertCleanTree(projectDir, "rule: typecheck modified the working tree");
    const prompt = await buildPersonaPrompt(projectDir, name, persona, { tier, gate, typecheck, escalation: ruleEscalation ? escalation : null });
    // A ruling reads and answers; it never writes. The tool list says so up front rather
    // than relying on the clean-tree check below to catch a turn that wrote anyway: the
    // read-only git commands are there because a persona legitimately wants to look
    // further into the branch than the diff the prompt already carries.
    //
    // A ruling turn is read-only and cheap, and a failed one is often transient — a
    // dropped connection, a rate limit — so one automatic retry is attempted before the
    // whole ruling is abandoned. Only one: a turn that fails twice is failing for a reason
    // retrying will not fix, and `rule --pending` running a batch must not turn one broken
    // proposal into an unbounded loop.
    const runRuling = (text) => runAgent({ cwd: projectDir, prompt: text, stage: "rule", maxTurns: rulingTurns(config, gate, name),
      allowedTools: ["Read", "Grep", "Glob", "Bash(git diff*)", "Bash(git log*)", "Bash(git status*)"] });

    // One turn, its failure retried once, and the verdict read out of whatever came back.
    // The clean-tree check sits inside this rather than after it: a ruling is a read-only
    // turn, and a verdict text that looks fine must not be allowed to mask files the turn
    // left behind. The edit is left in place (not reset) so the tampering stays visible.
    const askOnce = async (text) => {
      let result = await runRuling(text);
      // A failed turn still spent whatever it spent before it failed, so its cost and
      // turns are carried into the retry's rather than dropped: a session that hit the
      // turn cap once before answering costs what both turns cost, not what the second
      // one alone did.
      let spent = { cost: result.cost, turns: result.turns, session: result.sessionId };
      if (!result.ok) {
        console.warn(`warning: the ruling turn for ${name} failed (${rulingFailure(result)}); retrying once`);
        result = await runRuling(text);
        spent = sumMetrics(spent, { cost: result.cost, turns: result.turns, session: result.sessionId });
      }
      // Accumulated before the three throws below rather than after them: a turn that failed,
      // wrote to the tree, or came back in a shape the protocol could not be read out of spent
      // exactly what a turn that answered spent, and a refusal that cannot say so is the
      // silence this is here to end.
      turnCost = turnCost ? sumMetrics(turnCost, spent) : spent;
      // A turn that reports failure has no verdict to read, and its own text is the only
      // account of why — except when it has no text at all, which is exactly when a person
      // most needs one, so the CLI's own account of how the session ended stands in.
      // Checked before `parseVerdict`, whose "no verdict block in persona reply" would
      // otherwise be the error a person sees for what is actually a failed session.
      if (!result.ok) throw new Error(`ruling agent turn failed after one retry: ${rulingFailure(result)}`);
      assertCleanTree(projectDir, "rule: the ruling agent modified the working tree");
      return { ...parseVerdict(result.text), metrics: spent };
    };

    let { verdict, rationale, conditions, metrics } = await askOnce(prompt);
    // Set the moment a guard's re-prompt fires, and carried through to whichever exit this
    // ruling takes: an approval or return's gate file, an escalation's, or (had the second
    // reply still been wrong) the refusal thrown below. `null` for the ordinary ruling that
    // never needed a second turn, which is most of them.
    let reprompt = null;

    // At G1 a condition is not commentary, it is an instruction `ratify` will execute
    // against the domain file, so a line the ratification grammar cannot read is a silently
    // dropped ruling on a criterion. The persona is asked again, once, with its own
    // unreadable lines quoted back and the grammar restated — which is the whole fix in the
    // ordinary case, since these are formatting slips rather than disagreements. Anything
    // still unreadable after that is written to the gate file under `unparsed_conditions`
    // and the ruling proceeds: the verdict was reached and the reasoning is worth keeping,
    // and `ratify` refuses to act on that gate file until a person fixes the lines.
    const grammar = conditionGrammarFor(name);
    // Read as instructions at G1, and at G3 only for a triage proposal: every other G3 ruling's
    // conditions are free-text notes to a writer, not something a stage executes.
    const executable = conditionsAreExecutable(gate, name);
    let unparsed = executable && verdict !== "escalate" ? grammar.unparsed(conditions) : [];
    if (unparsed.length) {
      const why = `${unparsed.length} condition line(s) did not match the ${grammar.label} grammar: `
        + `${unparsed.map((c) => JSON.stringify(c)).join(", ")}`;
      console.log(`${name}: re-asking once — the first reply's conditions could not be read. ${why}`);
      const again = [
        prompt,
        "",
        "## Your previous reply had conditions I could not read",
        "",
        `You ruled ${verdict}. These condition lines do not match the ${grammar.label} grammar, so nothing`,
        "would be applied for them:",
        "",
        ...unparsed.map((c) => `- ${JSON.stringify(c)}`),
        "",
        grammar.text,
        "",
        "Rule again. Keep the conditions that were fine exactly as they were, rewrite these in the",
        "grammar above, and finish with the JSON block as before.",
      ].join("\n");
      const next = await askOnce(again);
      metrics = sumMetrics(metrics, next.metrics);
      reprompt = `The first reply ruled ${verdict}. ${why}. Asked again in the ${grammar.label} grammar.`;
      ({ verdict, rationale, conditions } = next);
      unparsed = verdict === "escalate" ? [] : grammar.unparsed(conditions);
      if (unparsed.length) console.warn(`warning: ${name}: ${unparsed.length} condition line(s) still unreadable after one re-prompt; recorded as unparsed_conditions`);
    }

    if (verdict === "escalate") {
      recorded = true;
      const stalled = writeEscalation(projectDir, { name, gate, by, escalateTo: g.escalate_to, rationale, metrics, reprompt });
      return { verdict, rationale, escalated: true, stalled, gate, escalateTo: g.escalate_to, reprompted: Boolean(reprompt) };
    }

    // The same check a person's ruling is held to, in the same place in the sequence:
    // before anything is written. A `test-overreaches` line is an instruction a stage will
    // carry out rather than commentary a writer reads, so — unlike an unreadable free-text
    // condition, which is kept verbatim because the reasoning is still worth having — one
    // that would file an unactionable request refuses the ruling instead. Nothing has been
    // committed at this point, and the turn is read-only, so the proposal is left open for
    // a corrected ruling.
    //
    // Before the refusal, one more turn: the checks below read a defect a second turn can
    // answer — a verb with no reason, a plain line naming a path the returned-to stage
    // cannot deliver, an approval carrying a form only a return may carry — the same way
    // `grammar.unparsed` above reads an unreadable G1 condition, and get the same one
    // re-prompt. The persona is told both rules in its own prompt before it rules
    // (`conditionFormsNote` and `deliverabilityNote`, `src/runner/persona.mjs`) and can
    // still land on one of them; refusing outright throws away a verdict, a rationale and
    // every other condition over a single line. A reply that rules `escalate` this time is
    // handled the same way it would have been had it done so first.
    const defect = firstRepromptableDefect(projectDir, name, verdict, conditions ?? [], { executable, onEscalation: ruleEscalation, config });
    if (defect) {
      const guidance = defectGuidance(defect);
      // The console line a person watching a batch run needs, the moment the re-prompt
      // fires rather than only afterward: what the first reply got wrong, in the same
      // words the persona is being asked to fix.
      console.log(`${name}: re-asking once — ${repromptShape(defect).said}. ${guidance}`);
      const next = await askOnce(defectReprompt(prompt, verdict, defect));
      metrics = sumMetrics(metrics, next.metrics);
      reprompt = `You ruled ${verdict}. ${guidance}`;
      ({ verdict, rationale, conditions } = next);
      if (verdict === "escalate") {
        recorded = true;
        const stalled = writeEscalation(projectDir, { name, gate, by, escalateTo: g.escalate_to, rationale, metrics, reprompt });
        return { verdict, rationale, escalated: true, stalled, gate, escalateTo: g.escalate_to, reprompted: true };
      }
    }
    produced = { verdict, rationale, conditions: conditions ?? [] };
    // The final word, whether or not a re-prompt was tried: a defect still present here —
    // the same one, or a different one the rewrite introduced — refuses the ruling, exactly
    // as it always did. Nothing about what these five refuse has changed; only the chance to
    // answer what would otherwise sink an honest ruling has been added in front of them.
    if (!executable) {
      assertOverreachRulable(name, verdict, conditions ?? []);
      assertAddressedRulable(name, verdict, conditions ?? []);
      assertDeliverableRulable(name, verdict, conditions ?? []);
      assertAccountedRulable(projectDir, name, verdict, conditions ?? []);
    }
    // Here rather than before the persona is asked, because the verdict is what decides
    // whether it applies at all. By this point the typecheck has run and the ruling turn has
    // answered, both read-only against a tree asserted clean; no gate file, no proposal page,
    // no commit and no merge has been written for this ruling.
    assertApprovalEvidence(projectDir, name, verdict, ruleEscalation, conditions ?? [], config);
    assertNoMissingTests(projectDir, name, verdict, conditions ?? [], config);

    // The ruling has to land in the proposal page's own commit, not a follow-up one, so
    // it is appended and written before `commitRuling` stages and commits.
    recorded = true;
    writeText(proposalPath, redactLocalPaths(appendRulingSection(proposalText, { verdict, by, rationale, conditions, typecheck }), projectDir));
    const requests = commitRuling(projectDir, { name, branch, gate, verdict, by, heldBy: "agent", rationale, conditions, unparsed, metrics, proposalPath, proposalAppended: true, executable, reprompt });
    return { verdict, rationale, conditions, unparsed, escalated: false, gate, escalateTo: null, reprompted: Boolean(reprompt), ...requests, ...metrics };
  } catch (e) {
    // Recorded only where a turn was spent and the ruling had not yet begun writing itself
    // down. Before the first turn there is nothing to account for — a seat that does not hold
    // the gate, a policy with nowhere to escalate — and after `recorded` the failure is a
    // ruling that could not be committed rather than one that was refused.
    if (turnCost && !recorded) {
      recordRefusal(projectDir, { name, gate, by: `agent:${persona}`, heldBy: "agent", produced, reason: e.message, metrics: turnCost });
    }
    throw leaveRuling(projectDir, start, branch, e);
  }
}

// How much of a rationale is shown at the terminal before it is pointed at rather than
// quoted whole. A rationale can run to a paragraph or more, and the gate file this line
// names is where the rest of it already lives; a condition gets no such cap, because a
// return's conditions are instructions a later run acts on, and summarising the
// actionable part would defeat the reason this function exists.
const RATIONALE_SHOWN = 400;

function pointedAt(text, gatePath) {
  const t = (text ?? "").trim();
  if (!t) return "";
  return t.length <= RATIONALE_SHOWN ? t : `${t.slice(0, RATIONALE_SHOWN)}… (see ${gatePath} for the rest)`;
}

// What `sdlc rule` prints once a ruling is recorded — the verdict alone used to be the
// whole of it, which is the defect three operators reported independently: an operator
// who does not know to go and open the gate file has no way to tell "approved, no
// conditions" apart from "approved, and I was never shown any." Every condition is shown
// in full here, never summarised, because a return's conditions are instructions the next
// run acts on rather than commentary; the rationale behind them is pointed at instead,
// since the gate file this line names already carries the whole of it.
//
// Redacted the same way the gate file itself is (`redactLocalPaths`) — an agent's own
// prose can carry a path off the machine it ran on, and a terminal is not exempt from the
// rule the committed file is held to.
function formatRuling(projectDir, name, { gate, verdict, conditions, rationale, note, escalateTo, stalled, reprompted, opened, closed, missingTests }) {
  const gatePath = join(".sdlc", "gates", `${name}.yaml`);
  const recordedOn = verdict === "approve" ? "main (merged)" : `proposal/${name}`;
  const lines = [`${name}: ${verdict} at ${gate}`];
  if (escalateTo) lines.push(`  escalated to: ${escalateTo}`);
  // Said in the turn it happened, not left for whoever opens the gate file: an escalation
  // to the role that raised it looks identical to a hand-off on every other line here.
  if (stalled) lines.push(`  stalled: ${stalled}`);
  if (reprompted) lines.push(`  re-asked once: the first reply was refused; see "reprompt" in the gate file for what it got wrong`);
  const text = pointedAt(rationale || note, gatePath);
  if (text) lines.push(`  rationale: ${text}`);
  if (verdict !== "escalate") {
    const list = conditions ?? [];
    lines.push(list.length ? "  conditions:" : "  conditions: none");
    for (const c of list) lines.push(`    - ${c}`);
  }
  // What this ruling put on the condition ledger and what it took off it. Printed for the
  // reason the conditions themselves are: an operator who is not told a reference was opened
  // has no way to tell a return that owes something from one that owes nothing, and the
  // reference is what a later ruling needs in order to close it.
  if (opened?.length) lines.push(`  now owed: ${opened.join(", ")} (close with \`${CONDITION_MET_FORM}\`)`);
  for (const c of closed ?? []) lines.push(`  closed: ${c.ref} ${c.outcome}`);
  // The same for the tests this approval left owed, moved or saw run.
  if (missingTests?.opened?.length) lines.push(`  tests now owed: ${missingTests.opened.map(missingTestRef).join(", ")}`);
  for (const m of missingTests?.readdressed ?? []) lines.push(`  test re-addressed: ${missingTestRef(m.id)} from ${m.from} to ${m.to}`);
  if (missingTests?.closed?.length) lines.push(`  test ran, closed: ${missingTests.closed.map(missingTestRef).join(", ")}`);
  lines.push(`  recorded: ${gatePath} on ${recordedOn}`);
  return redactLocalPaths(lines.join("\n"), projectDir);
}

// `sdlc rule --pending`: every open proposal branch whose gate is agent-held, ruled in
// the order its branch was created, with no human invocation needed per proposal.
export async function rulePending(projectDir) {
  projectDir = resolve(projectDir);
  // Checked before any branch is opened, so that dirt found later in the loop can only
  // have come from a ruling turn. Without this the batch adopts whatever the caller left
  // behind — generated output a stale branch's `.gitignore` does not cover is enough —
  // fails the first ruling's own clean-tree check, and stops holding a branch it never
  // should have opened, blaming an agent that had not yet run.
  assertCleanTree(projectDir, "rule --pending");
  const branches = gitOk(["for-each-ref", "--format=%(refname:short)", "--sort=creatordate", "refs/heads/proposal/*"], projectDir)
    ? git(["for-each-ref", "--format=%(refname:short)", "--sort=creatordate", "refs/heads/proposal/*"], projectDir).split("\n").filter(Boolean)
    : [];
  const results = [];
  for (const branch of branches) {
    const name = branch.slice("proposal/".length);
    // Already ruled: the ruling commit put a gate file on this branch regardless of
    // verdict (approve, return or escalate), so its presence is the "still open" test —
    // except for an escalation, which is still open for its target to rule when that
    // target is itself an agent (checked below, once the config is read).
    const ruled = gitOk(["cat-file", "-e", `${branch}:.sdlc/gates/${name}.yaml`], projectDir);
    const escalation = ruled ? escalationOn(projectDir, branch, name) : null;
    if (ruled && !escalation) continue;
    // A build proposal not yet ruled at all (never an escalation, which is already a
    // ruling of a kind) is left out of the batch when its own branch has no passing verify
    // result for the application as it stands. A batch rules on the merits, and the merits
    // are the suite's result: before it exists there is nothing to rule, and the slice is
    // skipped with no failure line and no run record, since there is nothing wrong with
    // the proposal itself to report.
    //
    // Where the suite did run against this tree and did not pass, the skip is said out
    // loud. A proposal that never appears in a batch it is eligible for reads as one
    // nothing is waiting on, and this one is waiting: the ruling that fits it is a return
    // or an escalation, both of which `sdlc rule <name>` reaches by naming it. What a
    // batch must not do is reach them by itself — an automatic return sends the builder to
    // rebuild an application that may be sound, and spends one of the three attempts the
    // retry ceiling counts.
    let configText;
    try { configText = git(["show", `${branch}:.sdlc/config.yaml`], projectDir); } catch { continue; }
    const { config: branchConfig, errors } = parseConfig(configText);
    if (errors.length) continue;
    let proposalText;
    try { proposalText = git(["show", `${branch}:.sdlc/proposals/${name}.md`], projectDir); } catch { continue; }
    const gateMatch = proposalText.match(/^gate:\s*(\S+)/m);
    if (!gateMatch) continue;
    const governed = governingConfig(projectDir, branch, name, gateMatch[1], branchConfig);
    if (governed.refusal) {
      console.log(`${name}: left open — ${governed.refusal}`);
      continue;
    }
    const { config } = governed;
    const verified = escalation ? { ok: true } : buildVerifiedOnBranch(projectDir, branch, name, config);
    if (!verified.ok) {
      if (verified.notPassed) console.log(`${name}: left open — ${verified.reason}; rule it by name to return or escalate it`);
      continue;
    }
    const g = config.policy.gates[gateMatch[1]];
    if (!g) continue;
    let persona;
    if (escalation) {
      // An escalation is ruled here only by a simulated target that did not raise it; any
      // other escalation is waiting for a person, and a batch leaves it alone.
      if (!simulatedRole(config, g.escalate_to) || escalation.by === `agent:${g.escalate_to}`) continue;
      persona = g.escalate_to;
    } else {
      if (!g.holder?.startsWith("agent:")) continue;
      persona = g.holder.slice("agent:".length);
    }
    // One proposal's agent turn misbehaving (a bad verdict block, an escalation with no
    // target) must not take the rest of the batch down with it: the failure is recorded
    // — printed here and written to the run record — and the loop moves on to the next
    // branch rather than throwing out of `rulePending` entirely. A *tampered working
    // tree* is different: `git checkout -q main` succeeds even with uncommitted changes
    // present whenever the file is identical on both branches, so switching branches
    // here would carry the tampering onto `main` silently, and every later proposal in
    // the batch would then fail its own `assertCleanTree` with a message that points at
    // the wrong ruling. So when the tree is left dirty, the batch stops instead: no
    // checkout, no run-record commit (there is nothing clean to commit it onto), just
    // the failure already pushed above plus a `stopped` marker on the returned summary,
    // leaving the caller on the offending proposal branch with the tampering visible.
    // This is the one way a batch can end off `main`: every other way out of the loop
    // below returns to it before `rulePending` hands control back.
    try {
      const r = await ruleByAgent(projectDir, name, { persona });
      results.push({ name, ...r });
      if (r.escalated && escalation && !r.stalled) console.log(`${name}: escalated again by agent:${persona}; waiting for a person`);
      console.log(formatRuling(projectDir, name, {
        gate: r.gate ?? gateMatch[1], verdict: r.escalated ? "escalate" : r.verdict,
        conditions: r.conditions, rationale: r.rationale, escalateTo: r.escalateTo, stalled: r.stalled,
        reprompted: r.reprompted, opened: r.opened, closed: r.closed, missingTests: r.missingTests,
      }));
    } catch (e) {
      results.push({ name, failed: true, error: e.message });
      console.log(`${name}: failed — ${e.message}`);
      if (porcelainStatus(projectDir)) {
        // The branch is named because the caller is left standing on it, and every
        // command that follows — `init`, `run`, a plain `git log` — reads that tree
        // instead of `main` and reports what it finds there as the project's state.
        const stopped = `${name}: working tree dirty after the ruling agent's turn; inspect and clean before continuing.`
          + `\nthe repository is left on ${branch}, not main: commit or discard the changes, then \`git checkout main\``;
        console.log(stopped);
        results.stopped = stopped;
        return results;
      }
      gitOk(["checkout", "-q", "main"], projectDir);
      try {
        const runPath = appendRun(projectDir, `rule --pending ${name}: failed — ${e.message}`);
        stagePaths(projectDir, [relative(projectDir, runPath)]);
        // The run record just gained a line, and the site's runs page is built from it,
        // so the site goes into the same commit — otherwise the next `status` or ruling
        // rebuilds it, finds the page changed, and fails its clean-tree check on a diff
        // this failure left behind.
        buildSite(projectDir);
        stageSite(projectDir);
        if (git(["diff", "--cached", "--name-only"], projectDir)) {
          git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(--pending): ${name} failed`], projectDir);
        }
      } catch { /* the failure is already in `results` and printed; recording it is best-effort */ }
    }
  }
  // A `return` or `escalate` ruling ends its own turn back on the proposal branch (see
  // `regenerateSiteOnMain`), which is right for a single `sdlc rule <name>` but wrong
  // for a batch: the next `sdlc run` requires `main` (`assertOnMain`), and there is no
  // reason a batch that ruled ten proposals should fail that check just because the
  // last one happened to be a return rather than an approve. The ruling itself is not
  // at risk by switching away — a return's or an escalation's commit lives on its own
  // branch and stays reachable there regardless of what the working tree is checked out
  // to next.
  if (currentBranch(projectDir) !== "main") git(["checkout", "-q", "main"], projectDir);
  return results;
}

COMMANDS.rule = async (args) => {
  try {
    return await ruleCli(args);
  } finally {
    printNextBlock(process.cwd());
  }
};

async function ruleCli({ pos, flags }) {
  // A batch that stopped early exits non-zero: it is holding a proposal branch open and
  // has not ruled the proposals behind it, which a zero exit reports as a finished batch.
  if (flags.pending) { const r = await rulePending(process.cwd()); return r.stopped ? 1 : 0; }
  if (typeof flags.by === "string" && flags.by.startsWith("agent:")) {
    // An agent rules through its own turn, not a typed verdict: a verdict positional
    // alongside an `agent:` holder is refused rather than quietly dispatched to the
    // agent path with the typed verdict discarded.
    if (pos[1]) throw new Error("an agent holder rules through its own turn; omit the verdict, or rule as a human role");
    const r = await ruleByAgent(process.cwd(), pos[0], { persona: flags.by.slice("agent:".length) });
    console.log(formatRuling(process.cwd(), pos[0], {
      gate: r.gate, verdict: r.escalated ? "escalate" : r.verdict,
      conditions: r.conditions, rationale: r.rationale, escalateTo: r.escalateTo, reprompted: r.reprompted,
      opened: r.opened, closed: r.closed, missingTests: r.missingTests,
    }));
    return 0;
  }
  // `--condition` may be given more than once, and each occurrence is one condition line.
  // Anything else (the flag with no value after it) is not a condition and is left out
  // rather than written to the gate file as `true`.
  const conditions = flags.condition === undefined ? undefined
    : [flags.condition].flat().filter((c) => typeof c === "string");
  const r = rule(process.cwd(), pos[0], pos[1], { by: flags.by, note: flags.note ?? "", conditions });
  console.log(formatRuling(process.cwd(), pos[0], { gate: r.gate, verdict: r.verdict, conditions: r.conditions, note: r.note, opened: r.opened, closed: r.closed, missingTests: r.missingTests }));
  if (r.filed?.length) console.log(`${pos[0]}: ${r.filed.join(", ")} filed for re-derivation — run sdlc run derive-tests --domain <domain> --stale`);
  for (const id of r.unfiled ?? []) console.warn(`warning: ${pos[0]}: ${id} is not an accepted criterion; nothing was filed for it`);
  return 0;
}

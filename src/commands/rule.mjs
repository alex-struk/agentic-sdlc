import { join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { git, gitOk, assertCleanTree, porcelainStatus, stagePaths, stageSite, currentBranch, SDLC_AUTHOR } from "../lib/git.mjs";
import { readText, writeText } from "../lib/fsx.mjs";
import { redactLocalPaths } from "../lib/redact.mjs";
import { loadConfig, parseConfig } from "../config/load.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { buildPersonaPrompt, parseVerdict, readPersonaBrief, personaEscalates } from "../runner/persona.mjs";
import { runAgent, endedBecause, turnsFor, DEFAULT_MAX_TURNS } from "../runner/executor.mjs";
import { acceptanceTypecheck, formatTypecheckEvidence } from "../runner/typecheck.mjs";
import { buildSite } from "./status.mjs";
import { CALIBRATE_GRAMMAR, CONDITION_GRAMMAR, OVERREACH_CONDITION_FORM, OVERREACH_VERB, TRIAGE_GRAMMAR, malformedOverreachConditions, overreachConditions, unparsedCalibrateConditions, unparsedConditions, unparsedTriageConditions } from "../spec/criteria.mjs";
import { REDO_PATH, addRedo, overreachRedoEntries, readRedo } from "../spec/redo.mjs";
import { COMMANDS } from "../cli.mjs";

function mergeApproved(projectDir, branch, message) {
  git(["checkout", "-q", "main"], projectDir);
  try {
    git([...SDLC_AUTHOR, "merge", "-q", "--no-ff", "-m", message, branch], projectDir);
  } catch (e) {
    // A failed merge leaves main mid-merge, which is the worst place to stop: the
    // ruling is recorded, main is unbuildable, and nothing says why. Unwind it, put the
    // caller back on the proposal branch, and name the files a person has to reconcile.
    const conflicted = gitOk(["diff", "--name-only", "--diff-filter=U"], projectDir)
      ? git(["diff", "--name-only", "--diff-filter=U"], projectDir) : "";
    git(["merge", "--abort"], projectDir);
    git(["checkout", "-q", branch], projectDir);
    const files = conflicted ? `\nconflicted files:\n  ${conflicted.split("\n").join("\n  ")}` : "";
    throw new Error(`merging ${branch} into main failed; main was left unchanged and you are back on ${branch}.${files}\n${e.message}`);
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
function gateFileText({ gate, verdict, by, heldBy, note, rationale, conditions, unparsed, escalateTo, metrics }) {
  let text = `gate: ${gate}\nverdict: ${verdict}\nby: ${by}\nheld_by: ${heldBy}\n`;
  if (escalateTo !== undefined) text += `escalate_to: ${escalateTo ?? ""}\n`;
  if (rationale !== undefined) text += `rationale: |2-\n${blockScalar(rationale)}\n`;
  else text += `note: ${JSON.stringify(note ?? "")}\n`;
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
    throw new Error(`rule ${name}: ${JSON.stringify(bad[0])} carries no reason. Write it as \`${OVERREACH_CONDITION_FORM}\`:`
      + " the reason is what the next derive-tests run is given in place of the test it is replacing, and a request without one produces the same test again.");
  if (verdict === "approve" && overreachConditions(conditions).length)
    throw new Error(`rule ${name}: a \`${OVERREACH_VERB}\` condition asks for a criterion's test to be written again, which an approval cannot carry —`
      + " the criterion stays unverified until a regenerated test binds and passes; return the proposal instead.");
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
    const already = new Set(readRedo(projectDir).map((r) => r?.id));
    const filed = entries.filter((e) => !already.has(e.id)).map((e) => e.id);
    if (addRedo(projectDir, entries)) {
      stagePaths(projectDir, [REDO_PATH]);
      git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} sends ${filed.join(", ")} back to derive-tests`], projectDir);
    }
    return { filed, unfiled };
  } finally {
    if (branch !== "main") git(["checkout", "-q", branch], projectDir);
  }
}

// Shared by the human path and the agent-approve/return path: write the gate file,
// append the run record, stage exactly those paths (plus the proposal page when the
// caller already appended a `## Ruling` section to it), commit, merge on approve, and
// fold the rebuilt site into that same commit.
function commitRuling(projectDir, { name, branch, gate, verdict, by, heldBy, note, rationale, conditions, unparsed, metrics, proposalPath, proposalAppended, executable }) {
  const gatePath = join(".sdlc", "gates", `${name}.yaml`);
  // A ruling's rationale and conditions are an agent's own prose, and its typecheck
  // evidence is a compiler's output: both routinely quote a path on the machine the
  // ruling ran on. The gate file is committed and read straight into the state site, so
  // rule E-2's redaction applies here for the same reason it applies to the journal and
  // the proposal page (`src/lib/redact.mjs`).
  writeText(join(projectDir, gatePath),
    redactLocalPaths(gateFileText({ gate, verdict, by, heldBy, note, rationale, conditions, unparsed, metrics }), projectDir));
  const runPath = appendRun(projectDir, `rule ${name} ${verdict} at ${gate} by ${by} (${heldBy})`);
  const paths = [gatePath, relative(projectDir, runPath)];
  if (proposalAppended) paths.push(relative(projectDir, proposalPath));
  stagePaths(projectDir, paths);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} ${verdict} by ${by}`], projectDir);
  // After the ruling commit, never before it: if filing the request fails, the ruling is
  // still recorded and the proposal is still returned. An approval never carries this
  // form at all (`assertOverreachRulable`).
  const requests = verdict === "approve" || executable
    ? { filed: [], unfiled: [] }
    : fileOverreachRequests(projectDir, { name, gate, conditions });
  if (verdict === "approve") {
    mergeApproved(projectDir, branch, `merge: ${name} approved at ${gate} by ${by}`);
    amendSiteOntoMergeCommit(projectDir);
  } else {
    regenerateSiteOnMain(projectDir, `${name} ${verdict}`);
  }
  return requests;
}

function writeEscalation(projectDir, { name, gate, by, escalateTo, rationale, metrics }) {
  const gatePath = join(".sdlc", "gates", `${name}.yaml`);
  writeText(join(projectDir, gatePath),
    redactLocalPaths(gateFileText({ gate, verdict: "escalated", by, heldBy: "agent", escalateTo, rationale, metrics }), projectDir));
  const runPath = appendRun(projectDir, `rule ${name} escalated at ${gate} to ${escalateTo ?? "?"} by ${by}`);
  stagePaths(projectDir, [gatePath, relative(projectDir, runPath)]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} escalated to ${escalateTo ?? "?"}`], projectDir);
  regenerateSiteOnMain(projectDir, `${name} escalated`);
}

function appendRulingSection(text, { verdict, by, rationale, conditions = [], typecheck = null }) {
  const cond = conditions.length ? conditions.map((c) => `- ${c}`).join("\n") : "none";
  const evidence = typecheck ? `\n### Runner-owned typecheck evidence\n\n${formatTypecheckEvidence(typecheck)}\n` : "";
  return `${text}\n## Ruling\n\n**Verdict:** ${verdict}\n**By:** ${by}\n\n${rationale}\n\n**Conditions:**\n${cond}\n${evidence}`;
}

function openGate(projectDir, name) {
  const branch = `proposal/${name}`;
  if (!gitOk(["rev-parse", "--verify", branch], projectDir)) throw new Error(`no proposal branch ${branch}`);
  git(["checkout", "-q", branch], projectDir);
  const proposalPath = join(projectDir, ".sdlc", "proposals", `${name}.md`);
  const proposalText = existsSync(proposalPath) ? readText(proposalPath) : null;
  const gateMatch = proposalText ? proposalText.match(/^gate:\s*(\S+)/m) : null;
  if (!gateMatch) throw new Error(`proposal ${name} has no gate line`);
  const gate = gateMatch[1];
  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);
  const g = config.policy.gates[gate];
  if (!g) throw new Error(`gate ${gate} is not in policy`);
  return { branch, proposalPath, proposalText, gate, g, config };
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
  const { branch, gate, g } = openGate(projectDir, name);
  const allowed = [g.holder, g.escalate_to].filter(Boolean);
  if (!allowed.includes(by)) throw new Error(`${by} is not a holder of ${gate} (allowed: ${allowed.join(", ")})`);
  const executable = conditionsAreExecutable(gate, name);
  if (!executable) assertOverreachRulable(name, verdict, conditions ?? []);
  const heldBy = by.startsWith("agent:") ? "agent" : "human";
  const requests = commitRuling(projectDir, { name, branch, gate, verdict, by, heldBy, note, conditions, executable });
  return { gate, verdict, heldBy, ...requests };
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
// overridden by `policy.budgets.rule`, read the same way a stage's budget is.
// A triage proposal is ruled at G3 but reads like a G1 one: a page of failures, each needing
// its own verdict and evidence read against the adapter, so it gets the same budget.
export function rulingTurns(config, gate, name = "") {
  return turnsFor(config, "rule", gate === "G1" || name.startsWith("calibrate-triage-") ? DEFAULT_MAX_TURNS : 12);
}

// Which grammar a G1 ruling's conditions are read in. Two proposals reach G1 carrying
// conditions and they ask different questions: an archaeology or ratify follow-up asks
// which recovered criteria become the contract (the ratification grammar), and a
// calibration proposal asks what a criterion the old target fails actually means (the
// calibration grammar). The proposal's own name is what tells them apart — every
// calibration proposal is `calibrate-<target>-<n>` — because a condition read in the
// wrong grammar is not a parse error, it is a ruling that would be dropped in silence.
//
// A third family, `calibrate-triage-<target>-<n>`, is checked first because its name also
// starts `calibrate-`: the reviewer's sorting of a calibration's failures, read in its own
// two-verb grammar at G3, before any failure reaches the product owner.
export function conditionGrammarFor(name) {
  if (name.startsWith("calibrate-triage-"))
    return { label: "triage", text: TRIAGE_GRAMMAR, unparsed: unparsedTriageConditions, checked: true };
  return name.startsWith("calibrate-")
    ? { label: "calibration", text: CALIBRATE_GRAMMAR, unparsed: unparsedCalibrateConditions, checked: false }
    : { label: "ratification", text: CONDITION_GRAMMAR, unparsed: unparsedConditions, checked: false };
}

// Whether this proposal's conditions are an instruction a stage applies through a closed
// vocabulary, rather than free-text lines a writer reads. Three families are: ratification
// and calibration at G1, and the reviewer's triage page at G3. Everything else at G3 and
// every other gate carries free text.
//
// It decides where `test-overreaches` is read. A closed grammar is closed on purpose — a
// line it cannot parse is a ruling that would otherwise be dropped in silence, so it is
// recorded verbatim under `unparsed_conditions` for a person to rewrite, and the stage that
// owns the grammar refuses to act on the gate file until they have. Reading a second,
// unrelated verb out of those same lines would file a request off a ruling that has been
// declared unreadable, and jam the owning stage while doing it. Where the conditions are
// free text there is no such contract to break and nothing else is reading them.
export function conditionsAreExecutable(gate, name) {
  return gate === "G1" || conditionGrammarFor(name).checked;
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

// The four conditions that make a verify result count as current, shared by `buildVerified`
// (the working tree, read off disk once the branch is checked out) and `rulePending`'s
// branch check below (read with `git show`, before the branch is ever checked out) — kept
// in one place so the two paths cannot disagree about what "verified" means.
function verifiedResult(text, name, slice, appTree, next) {
  let r;
  try { r = JSON.parse(text); } catch { return { ok: false, reason: `tests/results/new/slice-${slice}.json does not parse; ${next}` }; }
  if (r.proposal !== name) return { ok: false, reason: `the verify result on this branch is for ${r.proposal}; ${next}` };
  if (r.verdict !== "pass") return { ok: false, reason: `${name} did not pass verify` };
  if (r.app_tree !== appTree) return { ok: false, reason: `the application changed since it was verified; ${next}` };
  return { ok: true, reason: "" };
}

// A build proposal is ruled on the application it contains having been run against the
// acceptance tests for its criteria (spec §5.12: the reviewer reads the verify results).
// The result counts only for the application as it stands on the branch: a result for an
// earlier tree is evidence about code that is no longer there.
export function buildVerified(projectDir, name) {
  const m = /^build-slice-(\d+)(?:-\d+)?$/.exec(name);
  if (!m) return { ok: true, reason: "" };
  const path = join(projectDir, "tests", "results", "new", `slice-${m[1]}.json`);
  const next = `run sdlc run verify --slice ${m[1]} first`;
  if (!existsSync(path)) return { ok: false, reason: `${name} has not been verified; ${next}` };
  return verifiedResult(readText(path), name, m[1], git(["rev-parse", "HEAD:app"], projectDir), next);
}

// Same check, read off a not-yet-checked-out proposal branch: `rulePending` uses this to
// leave an unverified build proposal out of a batch silently, rather than letting it reach
// `ruleByAgent` and fail loudly there.
function buildVerifiedOnBranch(projectDir, branch, name) {
  const m = /^build-slice-(\d+)(?:-\d+)?$/.exec(name);
  if (!m) return { ok: true, reason: "" };
  const next = `run sdlc run verify --slice ${m[1]} first`;
  let text;
  try { text = git(["show", `${branch}:tests/results/new/slice-${m[1]}.json`], projectDir); }
  catch { return { ok: false, reason: `${name} has not been verified; ${next}` }; }
  return verifiedResult(text, name, m[1], git(["rev-parse", `${branch}:app`], projectDir), next);
}

// The agent path: no human types --by approve|return. A persona brief is handed to a
// short-lived agent turn along with the proposal, the diff and the checks, and the
// verdict it comes back with is trusted the same way a human's --by is trusted — phase 0
// has no authentication either way (see docs/decisions/0003).
export async function ruleByAgent(projectDir, name, { persona }) {
  projectDir = resolve(projectDir);
  assertCleanTree(projectDir, "rule");
  const { branch, proposalPath, proposalText, gate, g, config } = openGate(projectDir, name);
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
  // Binds the gate's holder only: an escalation raised after three failed builds is ruled
  // by the tech lead precisely because the result is not a pass, and must not be refused
  // for it.
  if (!ruleEscalation) {
    const verified = buildVerified(projectDir, name);
    if (!verified.ok) throw new Error(`rule ${name}: ${verified.reason}`);
  }
  // An agent-held gate with nowhere to escalate is a broken policy, not a ruling this
  // agent can be trusted with — checked before the persona brief is even read, since
  // every path below (mandatory escalation, an `escalate` verdict) needs `escalate_to`.
  if (!g.escalate_to) throw new Error(`gate ${gate} has an agent holder but no escalate_to`);

  const brief = readPersonaBrief(projectDir, persona);
  const tierMatch = proposalText.match(/^tier:\s*(\S+)/m);
  const tier = tierMatch ? tierMatch[1] : config.policy.default_tier;

  // Mandatory escalation happens before the persona is ever asked: a HIGH/CRITICAL item,
  // or a persona whose brief always defers on this gate, never gets a chance to rule.
  // Declared in the brief's front matter (`escalates: [G-POL]`), never read out of its
  // prose. A brief is written for the agent that reads it, so a sentence scoped to one
  // kind of item — "a platform-article change is escalated, never ruled here" — is
  // indistinguishable to a phrase search from a rule covering every gate, and a persona
  // matched that way is switched off entirely without anything saying so.
  const mandatoryReason = ["HIGH", "CRITICAL"].includes(tier) ? `tier ${tier}`
    : personaEscalates(brief).includes(gate) ? `${persona} does not rule ${gate} alone`
      : null;

  if (mandatoryReason) {
    const rationale = `mandatory escalation: ${mandatoryReason}`;
    // No persona turn ran, so the ruling cost nothing — recorded as zero rather than
    // omitted, so every agent-held gate file carries the same three keys.
    writeEscalation(projectDir, { name, gate, by, escalateTo: g.escalate_to, rationale, metrics: { cost: 0, turns: 0, session: "" } });
    return { verdict: "escalate", rationale, escalated: true };
  }

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
    if (!result.ok) {
      console.warn(`warning: the ruling turn for ${name} failed (${rulingFailure(result)}); retrying once`);
      result = await runRuling(text);
    }
    // A turn that reports failure has no verdict to read, and its own text is the only
    // account of why — except when it has no text at all, which is exactly when a person
    // most needs one, so the CLI's own account of how the session ended stands in.
    // Checked before `parseVerdict`, whose "no verdict block in persona reply" would
    // otherwise be the error a person sees for what is actually a failed session.
    if (!result.ok) throw new Error(`ruling agent turn failed after one retry: ${rulingFailure(result)}`);
    assertCleanTree(projectDir, "rule: the ruling agent modified the working tree");
    return { ...parseVerdict(result.text), metrics: { cost: result.cost, turns: result.turns, session: result.sessionId } };
  };

  let { verdict, rationale, conditions, metrics } = await askOnce(prompt);

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
    ({ verdict, rationale, conditions, metrics } = await askOnce(again));
    unparsed = verdict === "escalate" ? [] : grammar.unparsed(conditions);
    if (unparsed.length) console.warn(`warning: ${name}: ${unparsed.length} condition line(s) still unreadable after one re-prompt; recorded as unparsed_conditions`);
  }

  if (verdict === "escalate") {
    writeEscalation(projectDir, { name, gate, by, escalateTo: g.escalate_to, rationale, metrics });
    return { verdict, rationale, escalated: true };
  }

  // The same check a person's ruling is held to, in the same place in the sequence:
  // before anything is written. A `test-overreaches` line is an instruction a stage will
  // carry out rather than commentary a writer reads, so — unlike an unreadable free-text
  // condition, which is kept verbatim because the reasoning is still worth having — one
  // that would file an unactionable request refuses the ruling instead. Nothing has been
  // committed at this point, and the turn is read-only, so the proposal is left open for
  // a corrected ruling.
  if (!executable) assertOverreachRulable(name, verdict, conditions ?? []);

  // The ruling has to land in the proposal page's own commit, not a follow-up one, so
  // it is appended and written before `commitRuling` stages and commits.
  writeText(proposalPath, redactLocalPaths(appendRulingSection(proposalText, { verdict, by, rationale, conditions, typecheck }), projectDir));
  const requests = commitRuling(projectDir, { name, branch, gate, verdict, by, heldBy: "agent", rationale, conditions, unparsed, metrics, proposalPath, proposalAppended: true, executable });
  return { verdict, rationale, unparsed, escalated: false, ...requests, ...metrics };
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
    // ruling of a kind) is skipped quietly when its own branch has no passing verify
    // result for the application as it stands — no failure line, no run record, since
    // there is nothing wrong with the proposal itself to report. `ruleByAgent` enforces
    // the same requirement loudly for a direct `sdlc rule <name>` call.
    if (!escalation && !buildVerifiedOnBranch(projectDir, branch, name).ok) continue;
    let proposalText;
    try { proposalText = git(["show", `${branch}:.sdlc/proposals/${name}.md`], projectDir); } catch { continue; }
    const gateMatch = proposalText.match(/^gate:\s*(\S+)/m);
    if (!gateMatch) continue;
    let configText;
    try { configText = git(["show", `${branch}:.sdlc/config.yaml`], projectDir); } catch { continue; }
    const { config, errors } = parseConfig(configText);
    if (errors.length) continue;
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
      console.log(!r.escalated ? `${name}: ${r.verdict} at ${gateMatch[1]}`
        : escalation ? `${name}: escalated again by agent:${persona}; waiting for a person`
          : `${name}: escalated to ${g.escalate_to}`);
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

COMMANDS.rule = async ({ pos, flags }) => {
  // A batch that stopped early exits non-zero: it is holding a proposal branch open and
  // has not ruled the proposals behind it, which a zero exit reports as a finished batch.
  if (flags.pending) { const r = await rulePending(process.cwd()); return r.stopped ? 1 : 0; }
  if (typeof flags.by === "string" && flags.by.startsWith("agent:")) {
    // An agent rules through its own turn, not a typed verdict: a verdict positional
    // alongside an `agent:` holder is refused rather than quietly dispatched to the
    // agent path with the typed verdict discarded.
    if (pos[1]) throw new Error("an agent holder rules through its own turn; omit the verdict, or rule as a human role");
    const r = await ruleByAgent(process.cwd(), pos[0], { persona: flags.by.slice("agent:".length) });
    console.log(r.escalated ? `${pos[0]}: escalated (${r.rationale})` : `${pos[0]}: ${r.verdict}`);
    return 0;
  }
  // `--condition` may be given more than once, and each occurrence is one condition line.
  // Anything else (the flag with no value after it) is not a condition and is left out
  // rather than written to the gate file as `true`.
  const conditions = flags.condition === undefined ? undefined
    : [flags.condition].flat().filter((c) => typeof c === "string");
  const r = rule(process.cwd(), pos[0], pos[1], { by: flags.by, note: flags.note ?? "", conditions });
  console.log(`${pos[0]}: ${r.verdict} at ${r.gate}`);
  if (r.filed?.length) console.log(`${pos[0]}: ${r.filed.join(", ")} filed for re-derivation — run sdlc run derive-tests --domain <domain> --stale`);
  for (const id of r.unfiled ?? []) console.warn(`warning: ${pos[0]}: ${id} is not an accepted criterion; nothing was filed for it`);
  return 0;
};

import { existsSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// The runner's own entry point. A stage that lets its agent drive part of the pipeline has
// to tell it how, because `sdlc` is not on anyone's PATH: the project invokes this file by
// path, and so must the agent. Resolved here rather than imported from `new.mjs`, which
// sits in an import cycle with `init.mjs`.
const SDLC_BIN = resolve(fileURLToPath(import.meta.url), "../../../bin/sdlc.mjs");
import { readText, writeText } from "../lib/fsx.mjs";
import { changedPaths, git, gitOk } from "../lib/git.mjs";
import { STAGES } from "../profiles.mjs";
import { MODES, coveredBy } from "../runner/workspace.mjs";
import { runCatalogueScan } from "../runner/catalogue.mjs";
import { typecheckPostCheck } from "../runner/typecheck.mjs";
import { checkDesignAccessibility, checkDesignCatalogue, checkDesignCompiles, checkDesignHarnessUntouched, checkDesignNoLiteralColours, checkDesignSurfaceScope, surfacePageIds } from "../checks/design.mjs";
import { checkPlanConstitution, checkPlanCoverage, planShape } from "../checks/plan.mjs";
import { readRebindFor } from "../spec/rebind.mjs";
import { parseDomainFile, parseAll, applyConditions, mintIds, serialiseDomainFile, writeIndex, renderSpecIndex, CONDITION_GRAMMAR, OVERREACH_VERB, conditionPaths, domainOrdinal, conditionTargetId, criterionFingerprint, splitConditionsByAddressee } from "../spec/criteria.mjs";
import { RECOVERY_PATH, addRecovery, answerRecoveries, entriesIn, keyOf, outstandingRecoveries, readRecovery, readRecoveryFor, recoveryRequestCount, unexpectedLedgerChange } from "../spec/recovery.mjs";
import { dropTestWrongRulings, readRedo, removeRedo } from "../spec/redo.mjs";
import { checkCriteria, checkCriteriaIndex } from "../checks/criteria.mjs";
import { checkEgress } from "../checks/egress.mjs";
import { checkTests, coverage, readNotTestable } from "../checks/tests.mjs";
import { checkSeparation } from "../checks/separation.mjs";
import { loadContract, writeGenerated } from "../spec/surface.mjs";
import { turnsFor } from "../runner/executor.mjs";
import { readLocal } from "../oracle/ports.mjs";
import { oracleOverridePath } from "../oracle/paths.mjs";
import { propose } from "../commands/propose.mjs";
import { SKILLS_DIR, checkSandboxPassword, checkTargetOption, escapeRe, followUpState, skillPath } from "./shared.mjs";
import { calibrate } from "./calibrate.mjs";
// Naming and revision-source helpers a stage module needs too (`build.mjs` in
// particular): kept in their own module rather than defined here, so a stage can import
// them without importing the registry itself, which imports every stage and would make
// that a cycle. Re-exported below so every existing caller of these four names from
// `registry.mjs` keeps working unchanged.
import { addressedElsewhereNote, isReopening, nextProposalName, recommendationFrom, recordReturnOnMain, requestedRevision, returnedRulingOn, revisionConditionList, revisionRulingBlock, splitRulingConditions, withOpenRequests, highestRulingNumber } from "./proposals.mjs";
import { build } from "./build.mjs";
import { verify } from "./verify.mjs";

export { nextProposalName, recommendationFrom, recordReturnOnMain, returnedRulingOn };

function checkProbeFile(projectDir) {
  const id = "probe-file";
  const p = join(projectDir, "app", "PROBE.md");
  if (!existsSync(p)) return { id, ok: false, messages: ["app/PROBE.md is missing"] };
  const text = readText(p);
  if (!text.includes("the runner works")) return { id, ok: false, messages: ["app/PROBE.md does not contain \"the runner works\""] };
  return { id, ok: true, messages: [] };
}

// `probe` proves the runner end to end: an isolated session, a workspace mode, a
// post-check, a journal entry. It is not one of the fifteen pipeline stages in
// src/profiles.mjs and is added to the registry only, never to STAGES there.
const probe = {
  name: "probe",
  title: "probe the runner",
  skill: skillPath("probe"),
  workspace: "project",
  gate: null,
  collect: [],
  implemented: true,
  prompt() {
    return "Create app/PROBE.md containing today's date and the sentence 'the runner works'. Then stop.";
  },
  // No gate, so there is nothing to put a question or a recommendation to.
  proposal() {
    return null;
  },
  preChecks() {
    return [];
  },
  postChecks(projectDir) {
    return [checkProbeFile(projectDir)];
  },
};

function checkBriefExists(projectDir) {
  const id = "brief-file";
  const p = join(projectDir, "intent", "brief.md");
  if (!existsSync(p)) return { id, ok: false, messages: ["intent/brief.md is missing: the tech lead writes the brief"] };
  return { id, ok: true, messages: [] };
}

// The file an `intent` run is judged by: whatever changed under `intent/` other than
// the brief itself. Computed fresh from git status rather than passed in, since it is
// needed both by a post-check and, once that post-check has passed, by `proposal` —
// which the stage contract calls with `ctx` alone, no `projectDir`.
function changedIntentFiles(projectDir) {
  return changedPaths(projectDir).filter((p) => p.startsWith("intent/") && p !== "intent/brief.md");
}

function checkIntentFile(projectDir) {
  const id = "intent-file";
  const changed = changedIntentFiles(projectDir);
  if (changed.length !== 1) {
    const found = changed.length ? `: ${changed.join(", ")}` : "";
    return { id, ok: false, messages: [`expected exactly one new or changed file under intent/ besides brief.md, found ${changed.length}${found}`] };
  }
  const [file] = changed;
  const full = join(projectDir, file);
  if (!existsSync(full)) return { id, ok: false, messages: [`${file} was deleted, not written`], file };
  const text = readText(full);
  const messages = [];
  if (text.includes("{{")) messages.push(`${file} still has a {{placeholder}} unfilled`);
  if (!/^## Open questions/m.test(text)) messages.push(`${file} is missing an "## Open questions" heading`);
  return { id, ok: messages.length === 0, messages, file };
}

function checkIntentScope(projectDir) {
  const id = "intent-scope";
  const outside = changedPaths(projectDir).filter((p) => !p.startsWith("intent/") && p !== "constitution.md");
  if (outside.length) return { id, ok: false, messages: [`intent may only change intent/ and constitution.md, but also touched: ${outside.join(", ")}`] };
  return { id, ok: true, messages: [] };
}

// The same slug rule the skill (`src/stages/skills/intent.md`) instructs the agent to
// build its own filename from: lowercased, every run of non-alphanumeric characters
// collapsed to one hyphen, no leading or trailing hyphen.
function slugify(text) {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Before an agent has run, there is no `intent/<slug>.md` yet to name a proposal after
// — only the brief it is about to interview. `checkProposalNotOpen`'s pre-flight still
// needs a name to check a second run against, so this reads the same slug the agent is
// about to build its own filename from: `intent/brief.md`'s first `# ` heading, run
// through the same rule `slugify` above applies. An agent that titles its document
// differently than the brief's own heading is not caught here — that gap is closed by
// `finishStage`'s own late check instead, once the real file exists.
function briefSlug(projectDir) {
  if (!projectDir) return null;
  const p = join(projectDir, "intent", "brief.md");
  if (!existsSync(p)) return null;
  const heading = readText(p).match(/^#\s+(.+)$/m);
  if (!heading) return null;
  return slugify(heading[1]) || null;
}

// `intent` interviews `intent/brief.md` — the written stakeholder brief a tech lead
// supplies — and turns it into exactly one `intent/<slug>.md`, never inventing an
// answer the brief does not give. It holds gate G0: the opened proposal asks whether
// this is the right problem and outcome before any later stage builds on it.
const intent = {
  name: "intent",
  title: "intent",
  skill: skillPath("intent"),
  workspace: "project",
  gate: "G0",
  collect: [],
  implemented: true,
  prompt() {
    return [
      "Read intent/brief.md. Interview it using the grilling discipline described in your skill instructions: work through the intent template one question at a time, answer each only from what the brief actually says, and mark anything the brief does not answer as an open question rather than guessing at it.",
      "Write exactly one file, intent/<slug>.md, built from intent/.template.md, where <slug> is the brief's title lowercased with spaces and punctuation turned into hyphens. Fill in every section the template asks for, and list every open question under its own \"## Open questions\" heading — including ones nobody has answered yet.",
      "If the brief defines a term that constitution.md's J4 domain-language table does not already have a row for, add one. Touch no other file, and do not edit intent/brief.md itself.",
      "Finish with your journal entry.",
    ].join("\n\n");
  },
  // Once a post-check has stashed `ctx.intentFile`, the name comes straight from the
  // file the agent actually wrote. Before that — the pre-flight open-proposal check
  // `runStage` runs before its agent turn, and `resume` runs before calling
  // `finishStage` at all — there is no such file yet, so the slug is derived from
  // `intent/brief.md`'s own heading instead (`briefSlug` above), the same rule the
  // skill gives the agent for naming its own file. If the brief has no heading at all,
  // there is nothing to name a proposal after and this returns `null` — a proposal to
  // check for, not a guess dressed up as `intent-untitled`.
  proposal(ctx) {
    const slug = ctx.intentFile
      ? ctx.intentFile.slice("intent/".length, -".md".length)
      : briefSlug(ctx.projectDir);
    if (!slug) return null;
    return {
      name: `intent-${slug}`,
      question: "Is this the right problem and outcome?",
      recommendation: recommendationFrom(ctx.agentText),
    };
  },
  preChecks(projectDir) {
    return [checkBriefExists(projectDir)];
  },
  // `ctx` is the same object `runStage`/`resume` also hand to `proposal` a moment later
  // in the same `finishStage` call, so the file this discovers is stashed on it here —
  // the real file, once it exists, always wins over the brief-derived guess.
  postChecks(projectDir, ctx) {
    const fileCheck = checkIntentFile(projectDir);
    if (fileCheck.ok) ctx.intentFile = fileCheck.file;
    return [fileCheck, checkIntentScope(projectDir)];
  },
};

// Both `archaeology` and `ratify` require `--domain <d>`: missing entirely, or naming a
// domain `config.project.domains` doesn't list, both fail here rather than letting the
// agent (or, for `ratify`, the mint) discover it partway through a run. One check id
// covers both, since they are the same question ("is there a domain this run applies
// to?") asked two different ways. `stageName` only shapes the missing-domain message —
// the membership check is identical either way.
function checkDomainOption(ctx, stageName = "archaeology") {
  const id = "domain-option";
  if (!ctx.domain) return { id, ok: false, messages: [`${stageName} needs --domain <d>`] };
  const domains = ctx.config?.project?.domains ?? [];
  if (!domains.includes(ctx.domain)) {
    return { id, ok: false, messages: [`domain "${ctx.domain}" is not in project.domains: ${domains.join(", ") || "(none configured)"}`] };
  }
  return { id, ok: true, messages: [] };
}

function checkSourcesConfigured(ctx) {
  const id = "sources-configured";
  if (!ctx.config?.sources?.old) return { id, ok: false, messages: ["sources.old is not configured in .sdlc/config.yaml"] };
  return { id, ok: true, messages: [] };
}

// The domain file a run is judged by: parsed fresh (not just checked for existence) so
// the file exists, parses, and holds at least one criterion. Shared by `archaeology`'s
// post-checks and `ratify`'s pre-checks under their own check ids — the question is the
// same one either way, and `ratify` in particular must ask it *before* `execute` runs,
// because `execute` rewrites the file from what the parser understood and a block the
// parser could not read would be dropped on the way back out.
function checkDomainFileParses(projectDir, domain, id) {
  if (!domain) return { id, ok: true, messages: [] };
  const file = `spec/domains/${domain}.md`;
  const full = join(projectDir, file);
  if (!existsSync(full)) return { id, ok: false, messages: [`${file} is missing`] };
  const { criteria, errors } = parseDomainFile(readText(full), domain);
  const messages = errors.map((e) => `${file}:${e.line}: ${e.message}`);
  if (criteria.length === 0) messages.push(`${file} has no criteria`);
  return { id, ok: messages.length === 0, messages };
}

// The `R-` ids a domain file already carried at `HEAD` — before this run's own changes —
// parsed the same way `parseAll` reads the working tree, so the two sets compare like
// for like. A file `HEAD` does not have yet (a domain being recovered for the first
// time) has none, the ordinary case for a fresh archaeology run.
function mintedIdsAtHead(projectDir, file, domain) {
  let text;
  try { text = git(["show", `HEAD:${file}`], projectDir); } catch { return new Set(); }
  const { criteria } = parseDomainFile(text, domain);
  return new Set(criteria.filter((c) => c.id.startsWith("R-")).map((c) => c.id));
}

// An `R-` ID is a permanent one, minted only by `ratify` once a human has ruled on what
// archaeology recovered — never archaeology's own to assign. The scope check below
// allows an archaeology run to touch any path under `spec/`, not only
// `spec/domains/<domain>.md`, so a mint slipped into some *other* domain file this run
// happened to change would escape a check scoped to just the target file. Every domain
// file is parsed (`parseAll`), but only the ones this run actually changed are judged —
// a domain file `ratify` legitimately minted `R-` IDs into on an earlier run is not this
// run's business and must not fail it. Nor is one `--revise` is looking at: a revision
// starts from a domain file that may already carry `R-` ids from an earlier ratify pass,
// and the check below is only meant to catch archaeology minting a *new* one — an `R-`
// id already on the file at `HEAD` (this run's own starting point, in either mode) is not
// archaeology's doing and does not fail this check; `archaeology-revise-keeps-minted`
// (below) is what polices a revision's already-minted rows instead.
function checkArchaeologyNoMintedIds(projectDir) {
  const id = "archaeology-no-minted-ids";
  const changed = new Set(changedPaths(projectDir).filter((p) => p.startsWith("spec/domains/") && p.endsWith(".md")));
  const messages = [];
  if (changed.size) {
    const { domains } = parseAll(projectDir);
    for (const [domain, criteria] of Object.entries(domains)) {
      const file = `spec/domains/${domain}.md`;
      if (!changed.has(file)) continue;
      const before = mintedIdsAtHead(projectDir, file, domain);
      const minted = criteria.filter((c) => c.id.startsWith("R-") && !before.has(c.id));
      if (minted.length) messages.push(`${file} mints a permanent id (${minted.map((c) => c.id).join(", ")}); minting is ratify's job, not archaeology's`);
    }
  }
  return { id, ok: messages.length === 0, messages };
}

// `archaeology --revise`'s own promise: a return names one criterion's evidence as
// wrong, never the permanent record of a different one, so every `R-` criterion already
// in the domain file must come out of a revision exactly as `HEAD` had it. Compared as
// parsed objects rather than raw text, with each one's own `line` left out of the
// comparison — a criterion above it gaining or losing a line (an extra `cites`, a
// reworded statement) shifts where it starts in the file without changing it at all, and
// that must not read as tampering. Not run outside `--revise`: an ordinary archaeology
// run has no such promise to keep, and a domain file it is recovering for the first time
// carries no `R-` ids to compare against anyway.
function checkArchaeologyRevisionKeepsMinted(projectDir, ctx) {
  const id = "archaeology-revise-keeps-minted";
  if (!ctx.revise || !ctx.domain) return { id, ok: true, messages: [] };
  const file = `spec/domains/${ctx.domain}.md`;
  const full = join(projectDir, file);
  if (!existsSync(full)) return { id, ok: true, messages: [] };
  let beforeText;
  try { beforeText = git(["show", `HEAD:${file}`], projectDir); } catch { return { id, ok: true, messages: [] }; }
  const { criteria: before } = parseDomainFile(beforeText, ctx.domain);
  const { criteria: after } = parseDomainFile(readText(full), ctx.domain);
  // A minted criterion a ratification ruling sent back for re-recovery is the one
  // exception, and it is the whole reason the run was asked to touch it: rewriting it is
  // the instruction, so refusing the change here would leave the run unable to satisfy
  // both this check and `archaeology-recovery`, which fails if the row comes back
  // unchanged. Measured against `HEAD` — the state the run started from — because by the
  // time this check reads the working tree the row it is asking about has, if all went
  // well, already stopped matching its request. Removing such a row is still refused
  // below: the contract, its tests and any criterion that replaces it all point at that
  // permanent id, and re-recovering a behaviour is not the same as deciding it should not
  // be carried forward, which is `obsolete`'s ruling to make.
  const sentBack = new Set(recoveryAtHead(projectDir, ctx.domain).outstanding.map((e) => e.id));
  const strip = (c) => JSON.stringify({ ...c, line: undefined });
  const beforeById = new Map(before.filter((c) => c.id.startsWith("R-")).map((c) => [c.id, strip(c)]));
  const afterIds = new Set(after.filter((c) => c.id.startsWith("R-")).map((c) => c.id));
  const messages = [];
  for (const c of after) {
    if (!c.id.startsWith("R-")) continue;
    if (sentBack.has(c.id)) continue;
    const was = beforeById.get(c.id);
    if (was !== undefined && was !== strip(c)) messages.push(`${file}: ${c.id} changed; a revision may not alter an already-minted criterion`);
  }
  for (const id2 of beforeById.keys()) {
    if (!afterIds.has(id2)) messages.push(`${file}: ${id2} is missing; a revision may not remove an already-minted criterion`);
  }
  return { id, ok: messages.length === 0, messages };
}

// archaeology may only ever change files under spec/ — the old application it reads is
// never written to, and every other project path belongs to some other stage.
function checkArchaeologyScope(projectDir) {
  const id = "archaeology-scope";
  const outside = changedPaths(projectDir).filter((p) => !p.startsWith("spec/"));
  if (outside.length) return { id, ok: false, messages: [`archaeology may only change spec/, but also touched: ${outside.join(", ")}`] };
  return { id, ok: true, messages: [] };
}

// `--revise`'s own, narrower scope: a return names one criterion's evidence as wrong in
// one domain file, never a reason to touch the contract surface (`spec/contract/*.yaml`)
// an ordinary recovery writes to, or any domain file but the one being revised. Checked
// separately from `checkArchaeologyScope` above, which still allows a first recovery to
// touch any path under `spec/` — a revise run failing this one is named for the path it
// should not have touched, not lumped in with an ordinary out-of-spec failure that does
// not apply to it.
function checkArchaeologyRevisionScope(projectDir, ctx) {
  const id = "archaeology-revise-scope";
  if (!ctx.revise || !ctx.domain) return { id, ok: true, messages: [] };
  const allowed = `spec/domains/${ctx.domain}.md`;
  const outside = changedPaths(projectDir).filter((p) => p !== allowed);
  if (outside.length) return { id, ok: false, messages: [`archaeology --revise may only change ${allowed}, but also touched: ${outside.join(", ")}`] };
  return { id, ok: true, messages: [] };
}

// The re-recovery requests a domain is carrying right now: every `spec/recovery.yaml`
// entry for it whose criterion is still, field for field, the one the ratification ruling
// sent back (`outstandingRecoveries`, `src/spec/recovery.mjs`). A domain with no file yet
// carries none, which is the ordinary case for a first recovery.
function outstandingFor(projectDir, domain) {
  if (!projectDir || !domain) return [];
  const file = join(projectDir, "spec", "domains", `${domain}.md`);
  if (!existsSync(file)) return [];
  const { criteria } = parseDomainFile(readText(file), domain);
  return outstandingRecoveries(readRecoveryFor(projectDir, domain), criteria);
}

// What an `archaeology` run is told about the criteria it is being asked to recover a
// second time. Empty — no paragraph at all — for the ordinary run that is discovering a
// domain rather than correcting one, so a first recovery's prompt reads exactly as it
// always has.
function recoveryPromptBlock(ctx) {
  const outstanding = outstandingFor(ctx.projectDir, ctx.domain);
  if (!outstanding.length) return [];
  return [
    `${outstanding.length} criterion(s) in this domain were sent back by a ratification ruling: what each one records is not what the old application does, so you are recovering it again rather than discovering it. Each is listed with the ruling's own account of what the evidence actually shows, verbatim:`,
    outstanding.map((e) => `- ${e.id} (as recovered at v${e.version}): ${e.why}`).join("\n"),
    "For each of those, read the evidence in sources/old again and rewrite that criterion's statement, citations, given/when/then and confidence to match what you find. Keep its id and do not renumber it. If the evidence turns out to support the row exactly as it stands, leave the statement where it is and record in a `- note:` on the row what you read and where — a criterion that comes back with nothing changed at all fails this run's checks, because a re-recovery that leaves no trace cannot be told from one that never happened.",
  ];
}

// What this run was told to recover, read as the run started rather than as it ends: the
// ledger and the domain file as `HEAD` holds them. Every judgement about a re-recovery is
// made against this — which requests were owed, and what the rows looked like before the
// session touched anything — so neither the agent's own edits nor the stamp the runner
// writes afterwards can change the answer to a question about what this run was asked for.
// A project with no ledger, or a domain file `HEAD` does not have yet, is owed nothing.
function recoveryAtHead(projectDir, domain) {
  if (!domain) return { ledger: [], outstanding: [], byId: new Map() };
  let ledger = [];
  try { ledger = entriesIn(git(["show", `HEAD:${RECOVERY_PATH}`], projectDir)); } catch { ledger = []; }
  let criteria = [];
  try { ({ criteria } = parseDomainFile(git(["show", `HEAD:spec/domains/${domain}.md`], projectDir), domain)); } catch { criteria = []; }
  return {
    ledger,
    outstanding: outstandingRecoveries(ledger.filter((e) => e?.domain === domain), criteria),
    byId: new Map(criteria.map((c) => [c.id, c])),
  };
}

// The criteria in the domain file as it stands now, by id.
function criteriaNow(projectDir, domain) {
  const file = join(projectDir, "spec", "domains", `${domain}.md`);
  if (!existsSync(file)) return new Map();
  return new Map(parseDomainFile(readText(file), domain).criteria.map((c) => [c.id, c]));
}

// A criterion sent back for re-recovery has to come back different. `recovery-wrong` is
// the one ratification verb whose work is done by another stage, and the failure it exists
// to prevent is that stage quietly re-emitting the row it was asked to correct: the
// evidence stays wrong, the ruling looks acted on, and the next ratify pass has nothing new
// to read. So a run that leaves a criterion it was asked to recover exactly as `HEAD` had
// it fails here, naming the criterion and every reason it was sent back. Amending the row
// is what answers it, whether that means a corrected statement and citations or a note
// recording that the evidence was read again and holds; removing the row answers it too,
// since there is then nothing left to recover.
//
// Measured against `HEAD` rather than against the row as the request recorded it, because
// the question is whether THIS run recovered the criterion — a row some later `spike` or
// `edit` moved is still a row nobody has been back to the old application for.
//
// The ledger itself is the pipeline's own bookkeeping, like `tests/acceptance/redo.yaml`,
// and a run that wrote to it is refused: a session that could stamp its own requests could
// mark its own work done without doing it. Refused by comparing the file against `HEAD`
// rather than by asking whether it changed at all, because the runner's own stamp lands in
// this same working tree before the run commits and these checks can run over it again —
// after a repair turn, or when `sdlc resume` picks up a run that died between the stamp and
// the commit. `unexpectedLedgerChange` allows that one shape of change and nothing else.
function checkArchaeologyRecovery(projectDir, ctx) {
  const id = "archaeology-recovery";
  if (!ctx.domain) return { id, ok: true, messages: [] };
  const messages = [];
  const { ledger, outstanding, byId } = recoveryAtHead(projectDir, ctx.domain);
  const wrote = unexpectedLedgerChange(ledger, readRecovery(projectDir), new Set(outstanding.map(keyOf)));
  if (wrote) messages.push(wrote);
  const now = criteriaNow(projectDir, ctx.domain);
  const whysById = new Map();
  for (const e of outstanding) whysById.set(e.id, [...(whysById.get(e.id) ?? []), e.why]);
  for (const [cid, whys] of whysById) {
    const was = byId.get(cid);
    const is = now.get(cid);
    if (!was || !is || criterionFingerprint(was) !== criterionFingerprint(is)) continue;
    messages.push(`${cid} was sent back for re-recovery (${whys.join("; ")}) and came back unchanged; recover it again from sources/old, or record on the row itself what the evidence shows and why it stands`);
  }
  return { id, ok: messages.length === 0, messages };
}

// Records on every request this run was owed that it answered it, and at what version the
// criterion came back — or that the recovery removed the row. This is the only thing that
// ends a request, and it is written by the stage rather than inferred from the criterion,
// because "archaeology has been back to the old application for this row" is a fact about a
// run and not about how the row happens to read now.
//
// Runs only when every check passed, for the reason `clearDeriveTestsRedo` runs where it
// does: a failing run commits nothing of the agent's work, and a request it did not answer
// has to still be owed on the next attempt. `checkArchaeologyRecovery` has already refused
// a run that left any of these rows untouched, so a stamp is only ever written over work
// that was actually done.
function answerArchaeologyRecoveries(projectDir, domain) {
  const { outstanding } = recoveryAtHead(projectDir, domain);
  if (!outstanding.length) return;
  answerRecoveries(projectDir, domain, outstanding.map((e) => e.id), criteriaNow(projectDir, domain));
}

// `archaeology` recovers one business domain's behaviour from the old application,
// checked out read-only at `sources/old` by the `with-sources` workspace before the
// agent session starts. It holds gate G1: the recovered domain file is not trusted as
// the contract until a human or the persona bound to G1 rules on it — ratify (a later
// stage) mints permanent IDs only for what that ruling accepts.
const archaeology = {
  name: "archaeology",
  title: (ctx) => {
    if (!ctx?.domain) return "archaeology";
    return ctx.revise ? `archaeology ${ctx.domain} (revise)` : `archaeology ${ctx.domain}`;
  },
  skill: skillPath("archaeology"),
  workspace: "with-sources",
  gate: "G1",
  collect: [],
  implemented: true,
  prompt(ctx) {
    const d = ctx.domain;
    if (ctx.revise) {
      const rationale = ctx.revision?.rationale ?? "";
      const reopened = isReopening(ctx);
      return [
        reopened ? null
          : `The "${d}" domain was recovered before and partly ratified. A ruling returned it: one criterion's evidence — its citations, or its given/when/then — is wrong in a way no ratification condition can repair. Here is the rationale, verbatim:`,
        reopened ? revisionRulingBlock(ctx) : `\`\`\`\n${rationale}\n\`\`\``,
        `Revise spec/domains/${d}.md so the criteria this rationale names are correct: rewrite their statement, citations, given/when/then, note and confidence from the evidence you find in sources/old — its code, migrations, docs, README, and any OpenAPI/swagger file it has. Never read sources/old/tests, and never read anything outside sources/old except constitution.md, spec/, and intent/.`,
        `This run changes spec/domains/${d}.md only. Unlike a first recovery, do not touch spec/contract/surface.yaml or spec/contract/personas.yaml, and do not touch any other domain's file — a return names one criterion's evidence as wrong, never a reason to add to the contract surface.`,
        `Leave every R-<n> criterion in the file byte-for-byte unchanged. Leave every other D-<n> criterion unchanged too, unless this rationale's evidence contradicts it. Never renumber any criterion, minted or provisional.`,
        ...recoveryPromptBlock(ctx),
        addressedElsewhereNote(ctx),
        `Finish with your journal entry: say which criteria you changed and why, and what the evidence now shows.`,
      ].filter(Boolean).join("\n\n");
    }
    return [
      `Recover what the old application does for the "${d}" domain, reading only sources/old — its code, migrations, docs, README, and any OpenAPI/swagger file it has. Never read sources/old/tests, and never read anything outside sources/old except constitution.md, spec/, and intent/.`,
      `Write spec/domains/${d}.md in the criterion format your skill instructions describe (spec/README.md has the exact grammar): provisional IDs D-${d}-<n>, origin recovered, a confidence graded by the evidence you actually found, at least one cites on every criterion, a reconciliation class, and given/when/then. Mark anything you are not sure of inferred or open, and say in a note why.`,
      `Append any pages you recover to spec/contract/surface.yaml under a "domain: ${d}" entry, and any roles you recover to spec/contract/personas.yaml if they are not already listed there.`,
      ...recoveryPromptBlock(ctx),
      `Finish with your journal entry: lead with three sentences on what the ${d} domain does, then say what conflicted between your sources, then say what you could not determine.`,
    ].join("\n\n");
  },
  proposal(ctx) {
    const d = ctx.domain;
    return {
      // A revision deliberately reuses the name: `recordReturnOnMain` has already written
      // the returned ruling onto `main`, and the re-run's own ruling replaces it, so the
      // pair reads as one decision rather than two. Only a fresh run numbers, because that
      // is the case where an earlier verdict is already recorded and settled.
      name: ctx.revise ? `archaeology-${d}` : nextProposalName(ctx.projectDir, `archaeology-${d}`),
      question: ctx.revise
        ? `Is the revised ${d} domain right where the return said it was wrong?`
        : `Is this what the ${d} domain does, and which of it is the contract?`,
      recommendation: recommendationFrom(ctx.agentText),
    };
  },
  // `checkRevisionSource` has a side effect on a real run (recording the return onto
  // `main`, deleting the spent branch — see its own comment), so it only runs once the two
  // cheap checks ahead of it have both passed: a run with a bad `--domain` or an
  // unconfigured `sources.old` fails on those alone, and the returned ruling — if this
  // domain even has one — is left exactly where it was for a corrected re-run to find.
  preChecks(projectDir, ctx) {
    const cheap = [checkDomainOption(ctx), checkSourcesConfigured(ctx)];
    if (cheap.some((r) => !r.ok)) return cheap;
    return [...cheap, checkRevisionSource(projectDir, ctx)];
  },
  postChecks(projectDir, ctx) {
    const checks = [
      checkCriteria(projectDir, ctx),
      checkDomainFileParses(projectDir, ctx.domain, "archaeology-domain-file"),
      checkArchaeologyNoMintedIds(projectDir),
      checkArchaeologyRecovery(projectDir, ctx),
      checkArchaeologyRevisionKeepsMinted(projectDir, ctx),
      checkArchaeologyScope(projectDir),
      checkArchaeologyRevisionScope(projectDir, ctx),
    ];
    // Written after the checks have judged the tree, and only when they all passed — the
    // same place and the same reasoning as `derive-tests`' own clearing of the requests it
    // has answered. Doing it here rather than in a check keeps every check a judgement on
    // what the run produced, and keeps the record of what was answered out of the reach of
    // the session whose work it describes.
    if (checks.every((c) => c.ok)) answerArchaeologyRecoveries(projectDir, ctx.domain);
    return checks;
  },
};

// The proposal `contract` re-runs land on: `contract-v<n>`, `n` counting up from every
// ruled `contract-v*` gate file already on disk — a gate file only exists once `sdlc
// rule` has recorded a verdict, so this counts rulings, not attempts, the same way the
// brief's naming rule reads. Unlike archaeology's `archaeology-<domain>` (one name per
// domain, forever), `contract` has no natural per-run key of its own — a rebuild is a
// rebuild — so the run itself is what versions the name.
function nextContractVersion(projectDir) {
  const dir = join(projectDir, ".sdlc", "gates");
  if (!existsSync(dir)) return 1;
  const re = /^contract-v(\d+)\.yaml$/;
  return readdirSync(dir).filter((f) => re.test(f)).length + 1;
}

// Every `contract-v<n>` gate file present, oldest first — `nextContractVersion` above
// only needs the count; `readRulings` (below) needs the names themselves, in the same
// oldest-first order a domain's own follow-ups are read in, so a later contract ruling's
// condition on a criterion is applied after (and therefore over) an earlier follow-up's.
function contractGateNames(projectDir) {
  const dir = join(projectDir, ".sdlc", "gates");
  if (!existsSync(dir)) return [];
  const re = /^contract-v(\d+)\.yaml$/;
  return readdirSync(dir)
    .map((f) => [f, re.exec(f)])
    .filter(([, m]) => m)
    .sort((a, b) => Number(a[1][1]) - Number(b[1][1]))
    .map(([f]) => f.replace(/\.yaml$/, ""));
}

// Every identity a session might need to sign in through: the oracle's own, plus every
// configured target's, de-duplicated. This is the set `contract`'s personas are judged
// against — a persona is only obliged to carry a `sign_in` for an identity something in
// this project actually uses.
function configuredIdentities(config) {
  const identities = new Set();
  if (config?.oracle?.identity) identities.add(config.oracle.identity);
  for (const target of Object.values(config?.targets ?? {})) if (target?.identity) identities.add(target.identity);
  return [...identities];
}

function checkContractLoads(projectDir) {
  const id = "contract-loads";
  const { errors } = loadContract(projectDir);
  if (!errors.length) return { id, ok: true, messages: [] };
  return { id, ok: false, messages: errors.map((e) => `${e.file}: ${e.message}`) };
}

// A persona whose `sign_in` is exactly `null` is anonymous by design and exempt; every
// other persona needs an entry for every identity the config actually uses, named so
// whoever rules on the proposal knows exactly which persona and which identity is short.
//
// An entry may be real sign-in credentials, or `{ unavailable: "<reason>" }` for a role
// the target genuinely offers no way to act as — an old application with three fixed
// test users cannot host a second staff member, and that is a fact about the target, not
// a gap in the contract. The reason has to be a non-empty string: `unavailable` with
// nothing behind it is indistinguishable from a persona nobody got around to filling in.
function checkPersonaSignIns(projectDir, config) {
  const id = "contract-persona-sign-in";
  const identities = configuredIdentities(config);
  if (!identities.length) return { id, ok: true, messages: [] };
  const { personas, errors } = loadContract(projectDir);
  // A file that fails to load at all is `checkContractLoads`'s finding to report, not
  // this check's — asking about sign-ins on personas that could not even be parsed would
  // just repeat the same complaint in different words.
  if (errors.length) return { id, ok: true, messages: [] };
  const messages = [];
  for (const p of personas.personas) {
    if (p.sign_in === null) continue;
    for (const identity of identities) {
      const entry = p.sign_in?.[identity];
      if (!entry) {
        messages.push(`persona "${p.id}" has no sign_in for identity "${identity}"`);
        continue;
      }
      const isUnavailable = typeof entry === "object" && !Array.isArray(entry) && "unavailable" in entry;
      if (isUnavailable && (typeof entry.unavailable !== "string" || entry.unavailable.trim() === "")) {
        messages.push(`persona "${p.id}" marks identity "${identity}" unavailable but gives no reason`);
      }
    }
  }
  return { id, ok: messages.length === 0, messages };
}

// Every domain with at least one `accepted` criterion needs somewhere in `surface.yaml`
// for a test to act through — a criterion nobody can reach through a page is not
// actually testable, whatever the domain file says about it. Skipped entirely when
// `spec/criteria-index.json` does not exist yet: a project that has not ratified
// anything has no accepted criteria to hold this stage to.
function checkCriteriaDomainsHavePages(projectDir) {
  const id = "contract-domain-pages";
  const idxPath = join(projectDir, "spec", "criteria-index.json");
  if (!existsSync(idxPath)) return { id, ok: true, messages: [] };
  let index;
  try {
    index = JSON.parse(readText(idxPath));
  } catch (e) {
    return { id, ok: false, messages: [`spec/criteria-index.json does not parse: ${e.message}`] };
  }
  const acceptedDomains = new Set((index.criteria ?? []).filter((c) => c.state === "accepted").map((c) => c.domain));
  if (!acceptedDomains.size) return { id, ok: true, messages: [] };
  const { surface } = loadContract(projectDir);
  const pageDomains = new Set(surface.pages.map((p) => p?.domain).filter(Boolean));
  const missing = [...acceptedDomains].filter((d) => !pageDomains.has(d));
  if (!missing.length) return { id, ok: true, messages: [] };
  return { id, ok: false, messages: [`no page in spec/contract/surface.yaml carries domain: for accepted domain(s): ${missing.join(", ")}`] };
}

// `openapi.yaml` is only judged when there is an old application to have recovered it
// from — a greenfield contract with nothing to reverse-engineer is not held to writing
// an API description sight unseen.
function checkOpenapi(projectDir, config) {
  const id = "contract-openapi";
  if (!config?.sources?.old) return { id, ok: true, messages: [] };
  const file = "spec/contract/openapi.yaml";
  const full = join(projectDir, file);
  if (!existsSync(full)) return { id, ok: false, messages: [`${file} is missing`] };
  let doc;
  try {
    doc = parseYaml(readText(full));
  } catch (e) {
    return { id, ok: false, messages: [`${file} is not valid YAML: ${e.message}`] };
  }
  const messages = [];
  if (!doc || typeof doc !== "object" || !doc.openapi) messages.push(`${file} is missing the top-level "openapi" key`);
  const paths = doc && typeof doc === "object" ? doc.paths : undefined;
  if (!paths || typeof paths !== "object" || Array.isArray(paths) || Object.keys(paths).length === 0)
    messages.push(`${file} has no paths`);
  return { id, ok: messages.length === 0, messages };
}

// Every seed file the agent wrote has to actually insert something — an empty
// `tests/seed/*.sql` file would apply cleanly and seed nothing, which is worse than
// missing because nothing else would notice. `manifest.yaml`'s own parse errors are
// already `checkContractLoads`'s to report (`loadContract` reads it too), so this does
// not repeat them.
function checkSeed(projectDir) {
  const id = "contract-seed";
  const dir = join(projectDir, "tests", "seed");
  if (!existsSync(dir)) return { id, ok: true, messages: [] };
  const messages = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".sql")) continue;
    if (!readText(join(dir, f)).trim()) messages.push(`tests/seed/${f} is empty`);
  }
  return { id, ok: messages.length === 0, messages };
}

// `!override` and `!reset` are Compose's own merge tags (not YAML's) — legitimate on the
// override file this check parses, telling Compose to replace rather than merge a
// mapping or a sequence it collides with in the base file. The `yaml` package does not
// know either one and, left to its defaults, logs a `YAMLWarning: Unresolved tag` for
// every occurrence — noise on a file this check is about to pass anyway. Registering
// both as plain custom tags (one entry per collection shape they can appear over) makes
// the parser treat them as it treats a plain map or sequence, silencing the warning
// without touching what a real syntax error does: `{ logLevel: "silent" }` would have
// silenced those too, since this version of `yaml` treats a silent log level as "don't
// even throw," which is not the trade this check means to make.
function composeMergeTag(tag, collection) {
  return { tag, collection, resolve: (node) => node };
}
const COMPOSE_MERGE_TAGS = [
  composeMergeTag("!override", "map"),
  composeMergeTag("!override", "seq"),
  composeMergeTag("!reset", "map"),
  composeMergeTag("!reset", "seq"),
];

// The compose override is only judged when the project configures an oracle at all, and
// only for shape: it exists and parses as YAML. Nothing here brings up Docker — that is
// `sdlc oracle`'s job, and it is not available in a check that runs in every test.
function checkOracleOverride(projectDir, config) {
  const id = "contract-oracle-override";
  if (!config?.oracle) return { id, ok: true, messages: [] };
  const rel = oracleOverridePath(config);
  const full = join(projectDir, rel);
  if (!existsSync(full)) return { id, ok: false, messages: [`${rel} is missing`] };
  try {
    parseYaml(readText(full), { customTags: COMPOSE_MERGE_TAGS });
  } catch (e) {
    return { id, ok: false, messages: [`${rel} is not valid YAML: ${e.message}`] };
  }
  return { id, ok: true, messages: [] };
}

// `contract` may only touch the paths the guard hook allows it: the contract itself, the
// synthetic seed, and the oracle's compose override.
function checkContractScope(projectDir) {
  const id = "contract-scope";
  const outside = changedPaths(projectDir).filter((p) => !/^(spec\/contract\/|tests\/seed\/|\.sdlc\/oracle\/)/.test(p));
  if (!outside.length) return { id, ok: true, messages: [] };
  return { id, ok: false, messages: [`contract may only change spec/contract/, tests/seed/ and .sdlc/oracle/, but also touched: ${outside.join(", ")}`] };
}

// `contract` completes `spec/contract/` — the pages, personas, API description and
// observables the acceptance tests and the oracle will act through — from what the
// ratified criteria say the system does, reading `sources/old` when this project has
// one. It holds gate G1 again, alongside archaeology: the contract is spec content, not
// implementation, and nothing later builds tests against it until the product-owner
// persona rules it.
const contract = {
  name: "contract",
  title: "contract",
  skill: skillPath("contract"),
  // `with-sources` only when there is actually an old application configured — a
  // greenfield project has nothing under `sources/old` for `ensureSources` to check out,
  // and asking for it would fail the workspace before the agent ever got a prompt.
  workspace: (config) => (config?.sources?.old ? "with-sources" : "project"),
  gate: "G1",
  collect: [],
  implemented: true,
  prompt(ctx) {
    const config = ctx.config;
    const fromSources = !!config?.sources?.old;
    const identities = configuredIdentities(config);
    const oracle = config?.oracle;
    const lines = [
      fromSources
        ? "Complete spec/contract/ from sources/old and the ratified criteria: this project has an old application to recover the contract from, so read it the same way archaeology did — code and docs, never sources/old/tests."
        : "Complete spec/contract/ by authoring the contract from the ratified criteria: this project has no old application configured, so there is nothing under sources/old to read — write the contract from what the criteria in spec/domains/ (and spec/criteria-index.json, if ratify has already run) say the system does.",
      "1. spec/contract/surface.yaml: one entry per page the criteria need, each carrying a \"domain:\" field, a route, a title, and actions/observations named in the vocabulary the criteria use — never a CSS selector or a test ID, which are filled in at the design gate, not here. Keep and normalise whatever archaeology already appended; delete nothing.",
      "A route parameter a test has no way to obtain makes every criterion on that page untestable, so check each one you write. If a page's route carries \":something\", a test must be able to get a value for it: either it is a handle in tests/seed/manifest.yaml, or some observation somewhere returns it. A test that creates a record and then cannot address it is the common case — if an action creates something the criteria later refer to, the page it lands on needs an observation returning that record's identifier. And if a page is also reachable as the signed-in person's own — their profile, their settings, their dashboard — declare that as its own entry with no parameter, because a test acting as themselves has no id to pass and should not have to invent one.",
      identities.length
        ? `2. spec/contract/personas.yaml: every role with a "can" list and a "sign_in" entry for every identity this project configures (${identities.join(", ")}). "session-route" needs { route: <path> }; "sandbox-idp" needs { username: <name> }. A persona with no sign-in at all (an anonymous visitor) writes "sign_in: null" rather than omitting the key. A role the target genuinely offers no way to act as — not one you merely couldn't find — writes { unavailable: "<reason>" } instead, saying why.`
        : "2. spec/contract/personas.yaml: every role with a \"can\" list. This project configures no identity at all (no oracle, no targets), so no persona needs a sign_in entry yet.",
      fromSources
        ? "3. spec/contract/openapi.yaml: assembled from the old application's own API description files if it has any, else written from its routes — one operationId per route — with a top comment \"# recovered from <path(s)> at <commit>\" naming exactly where it came from."
        : "3. spec/contract/openapi.yaml: leave as is; there is no old application to recover an API description from.",
      "4. spec/contract/observables.yaml: email observed through a mail catcher at ${SDLC_MAIL_API}, plus any file or notification endpoint the criteria depend on.",
      "5. tests/seed/: one or more NNN-<name>.sql files, applied in name order, inserting one user per persona whose identity a session route or sandbox IdP looks up, plus whatever fixture records the accepted criteria's given-clauses need — all synthetic (example.test addresses, invented names that are not real people). Write tests/seed/manifest.yaml naming every inserted record a test will refer to by handle.",
      "Reach for the seed before you call a state unreachable. An interface will not create the past: a form that takes a deadline refuses one that has already gone by, a trial cannot be started six months ago, a retention period cannot be waited out. The seed can put a record straight into the database in whatever state the schema allows, and that is what it is for. A whole area of the criteria going untestable because no screen can set up its starting point is almost always this, and it is a row in a seed file rather than a limitation.",
      "Seed the conditions, never the outcome. A record the application will act on is legitimate: an opportunity that is published with a deadline that has passed, an account whose trial ended yesterday. A record already in the state the criterion is about is not, because the application then did nothing and the test is checking your fixture rather than the system. Set up the before and let the application produce the after — if nothing in the application will produce it, say so instead of writing it in.",
      oracle
        ? `6. ${oracleOverridePath(config)}: a Compose override for ${oracle.compose} that publishes the app on \${SDLC_APP_PORT}, the database on \${SDLC_DB_PORT}, adds a "mailpit" service (axllent/mailpit:v1.28.0) publishing its API on \${SDLC_MAIL_API_PORT}, points the app's own mail settings at that mailpit service, sets whatever environment the app needs to run outside production with its test sign-in routes enabled (use "!override" for any env_file the base compose file declares, so this override's own environment actually wins), and defines the migration one-off service the config names (${oracle.migrate_service ?? "none configured"}), if any.`
        : "6. This project configures no oracle, so there is nothing to write under .sdlc/oracle/.",
      oracle
        ? [
          "7. Then prove the override actually works, because nothing you can read tells you whether the application will start.",
          "Run `node $SDLC_BIN oracle up` — the CLI is not on PATH, so use that variable. Done is not \"a page was served\": done is that the migration ran, the seed loaded, and a record from tests/seed/manifest.yaml is visible through the application itself. An application that starts with a broken database connection also serves a page.",
          "If it does not come up, read the container logs, change this override, and try again. Three attempts, not more. Each attempt rebuilds the image and takes minutes, and a failure you cannot fix in three is a failure a person needs to see.",
          "You may change this override's environment, paths, ports and service definitions. You may not make the application easier to start by weakening it: do not skip or disable the migration, do not relax authentication or authorisation, do not stub out a service the application really uses, and do not set a flag that changes what the application does rather than where it runs. This target is the definition of correct behaviour for everything built against it, and an oracle that starts because it was weakened is worse than one that does not start at all.",
          "Run `node $SDLC_BIN oracle down` before you finish, whatever the outcome. A container left running collides with the next run.",
          "If it still will not start, that is a result and not a failure. Leave the override as your best honest attempt, and say in your journal exactly what happens, what you tried, and what you think is needed. A contract whose surface is complete and whose oracle does not start is a reasonable thing to put in front of a gate.",
        ].join("\n\n")
        : "",
      "Finish with your journal entry: say which pages exist, which sign-in method each persona uses, what the seed contains, what could not be recovered, and — when this project has an oracle — whether the application started and what you had to change to get it there.",
    ].filter(Boolean);
    return lines.join("\n\n");
  },
  // A shell, narrowed to the oracle's lifecycle and to reading back what it did. This stage
  // writes the file that says how the target runs, and the only way to know whether that
  // file works is to run it, so it is the one authoring stage with any shell at all. The
  // patterns are the whole grant: it can bring the target up and down, read a container's
  // logs, and ask the application for a page. It cannot install, build, publish or deploy.
  allowedTools: [
    "Read", "Write", "Edit", "Glob", "Grep",
    "Bash(node *sdlc.mjs oracle*)",
    "Bash(docker logs*)",
    "Bash(curl -s*)",
  ],
  env() {
    // `sdlc` is on nobody's PATH: the CLI is invoked by path, so the agent needs the path.
    return { SDLC_BIN };
  },
  proposal(ctx) {
    const n = ctx.contractVersion ?? nextContractVersion(ctx.projectDir);
    return {
      name: `contract-v${n}`,
      question: "Is this the contract the tests will act through?",
      recommendation: recommendationFrom(ctx.agentText),
    };
  },
  // Nothing beyond what the workspace itself needs — unlike archaeology, `contract`
  // takes no `--domain`: a rebuild covers every domain's pages and personas at once, not
  // one domain per run.
  preChecks() {
    return [];
  },
  postChecks(projectDir, ctx) {
    // Stashed on `ctx` the same way `intent` stashes the file it discovers: the real
    // proposal call in `finishStage` does not carry `projectDir`, so the version has to
    // be resolved here, while it is available, for `proposal` to read back.
    ctx.contractVersion = nextContractVersion(projectDir);
    return [
      checkContractLoads(projectDir),
      checkPersonaSignIns(projectDir, ctx.config),
      checkCriteriaDomainsHavePages(projectDir),
      checkOpenapi(projectDir, ctx.config),
      checkSeed(projectDir),
      checkEgress(projectDir, ctx),
      checkOracleOverride(projectDir, ctx.config),
      checkContractScope(projectDir),
    ];
  },
};

// The accepted criteria of one domain, read straight from `spec/criteria-index.json` —
// the same source `coverage` and `checkTests` judge a run's output against, so
// `derive-tests`' own notion of "what needs a test" can never drift from what those
// checks hold it to. A missing or unparseable index is not this function's business to
// fail on — it returns an empty list, and the domain-ratified pre-check below is what
// turns that into a real failure with a real message.
//
// A criterion carrying `superseded-by` is excluded: it has been replaced by another, and
// a test for it could only ever contradict the replacement, never confirm it. `coverage`
// (`src/checks/tests.mjs`) applies the same exclusion, so a superseded criterion is never
// "missing" either — nothing asks for a test that would only ever be wrong.
function acceptedCriteria(projectDir, domain) {
  const idxPath = join(projectDir, "spec", "criteria-index.json");
  if (!existsSync(idxPath)) return { criteria: [], generatedFrom: "" };
  let index;
  try { index = JSON.parse(readText(idxPath)); } catch { return { criteria: [], generatedFrom: "" }; }
  const criteria = (index.criteria ?? []).filter((c) => c.domain === domain && c.state === "accepted" && !c.supersededBy);
  return { criteria, generatedFrom: index.generated_from ?? "" };
}

// Entries on `tests/acceptance/redo.yaml` (`{ redo: [{ id, version, why, verb? }] }`) for
// one domain. A criterion is on that list because a ruling said its test has to be written
// again although the criterion itself has not moved — which is a reason `checkTests` cannot
// see for itself, since the file's header version still matches the index and nothing about
// the criterion is stale. An id the file names that does not belong to this domain's own
// accepted criteria is silently not this domain's business, the same way a stray id
// elsewhere in the file is not an error here.
function readRedoFor(projectDir, domain, byId) {
  return readRedo(projectDir).filter((r) => byId.get(r?.id)?.domain === domain);
}

// The criteria this run will actually write tests for: every accepted criterion of the
// domain on a full run; on a `--stale` run, only the ones `checkTests` reports as stale
// (a spec file whose header version trails the index) or named in
// `tests/acceptance/redo.yaml` for this domain. Called once, in `preChecks` — the only
// hook that ever sees the real project directory before `prompt(ctx)` runs with nothing
// but `ctx` itself — and its result is stashed there for `prompt` to read back.
function resolveCriteriaToDerive(projectDir, ctx) {
  const { criteria, generatedFrom } = acceptedCriteria(projectDir, ctx.domain);
  if (!ctx.stale) return { criteria, generatedFrom };
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const { stale } = checkTests(projectDir, ctx);
  const ids = new Set(stale.filter((id) => byId.has(id)));
  const redo = readRedoFor(projectDir, ctx.domain, byId);
  for (const r of redo) ids.add(r.id);
  return { criteria: criteria.filter((c) => ids.has(c.id)), generatedFrom, redo };
}

// What the writer is told about a test it is replacing rather than writing for the first
// time. Empty — no paragraph at all — when nothing being derived was asked for again, so an
// ordinary derivation's prompt reads exactly as it always has.
//
// The criterion alone cannot say this. A criterion is on the redo list precisely because
// nothing about it has changed, so a writer handed its id and its statement again writes
// the same test again, whatever was wrong with the one being replaced. The ruler's own
// words are the only account of what to do differently, so they are quoted verbatim, and
// the two reasons a request is filed for are put as the different instructions they are:
// one says the test asserted the wrong thing, the other that it asked for more than the
// criterion does.
function redoPromptBlock(ctx) {
  const entries = (ctx.deriveTestsRedo ?? []).filter((r) => r?.id && r?.why);
  if (!entries.length) return [];
  const lines = entries.map((r) => (r.verb === OVERREACH_VERB
    ? `- ${r.id} (as derived at v${r.version}): the criterion stands and the test reached past it — ${r.why}`
    : `- ${r.id} (as derived at v${r.version}): the test asserted the wrong thing — ${r.why}`));
  return [
    `${entries.length} of the criteria below already had a test, and a ruling asked for it to be written again. The criterion has not changed; the test is what was wrong. Each is listed with the ruler's own account of it, verbatim:\n\n${lines.join("\n")}`,
    "Write each of those from its criterion and nothing else, and make sure the new test does not do what the ruling names. A test that asserts more than its criterion states — a capability, a screen or a step the criterion never asks for — cannot be bound at all against an application that is only answerable for the criterion, and the failure it produces names the application rather than the test. Assert what the criterion states, and stop there.",
  ];
}

// A criterion is tested or recorded as not testable, never both, and `checkTests` refuses
// the contradiction. A run that decides an already-tested criterion cannot be tested after
// all creates one, and cannot resolve it: the writer's tools read, write and edit files and
// none of them removes one, so it is told to delete a file it has no way to delete. Twice
// in one batch a domain's whole rewrite was lost to that.
//
// So the run's own decision is carried out here. Only an entry this run added is acted on —
// compared against `HEAD` — so an entry that was already on file never deletes a test
// somebody has written since.
export function removeTestsNowRecordedNotTestable(projectDir, domain) {
  if (!domain) return [];
  const before = new Set(notTestableIdsAt(projectDir, "HEAD"));
  const removed = [];
  for (const entry of readNotTestable(projectDir)) {
    const id = entry?.id;
    if (!id || before.has(id)) continue;
    const rel = `tests/acceptance/${domain}/${id}.spec.ts`;
    const abs = join(projectDir, rel);
    if (!existsSync(abs)) continue;
    rmSync(abs);
    removed.push(rel);
  }
  return removed;
}

function notTestableIdsAt(projectDir, ref) {
  const rel = "tests/acceptance/not-testable.yaml";
  if (!gitOk(["cat-file", "-e", `${ref}:${rel}`], projectDir)) return [];
  try {
    const parsed = parseYaml(git(["show", `${ref}:${rel}`], projectDir));
    return (Array.isArray(parsed?.criteria) ? parsed.criteria : []).map((c) => c?.id).filter(Boolean);
  } catch {
    return [];
  }
}

function checkDeriveTestsDomainRatified(projectDir, ctx) {
  const id = "derive-tests-domain-ratified";
  if (!ctx.domain) return { id, ok: true, messages: [] };
  const { criteria } = acceptedCriteria(projectDir, ctx.domain);
  if (criteria.length === 0)
    return { id, ok: false, messages: [`derive-tests: domain ${ctx.domain} has no accepted criteria; run ratify first`] };
  return { id, ok: true, messages: [] };
}

// Reads `ctx.deriveTestsCriteria`, already resolved and stashed by `preChecks` above —
// not recomputed here, so this reports on exactly the same set `prompt(ctx)` is about to
// hand the agent, whatever the domain's ratified state turned out to be.
function checkDeriveTestsStaleHasWork(ctx) {
  const id = "derive-tests-stale-has-work";
  if (!ctx.domain || !ctx.stale) return { id, ok: true, messages: [] };
  if ((ctx.deriveTestsCriteria ?? []).length === 0)
    return { id, ok: false, messages: [`derive-tests: nothing stale in ${ctx.domain}`] };
  return { id, ok: true, messages: [] };
}

// The proposal name a `--stale` re-run opens: `n` counts up from every ruled
// `derive-tests-<d>-stale-*` gate file already on disk — a gate file only exists once
// `sdlc rule` has recorded a verdict, so this counts rulings, not attempts, the same
// counting rule `contract`'s own versioning follows. A full run's own name
// (`derive-tests-<d>`) needs no such counting: like `archaeology`'s, it is fixed per
// domain, and a second full run is refused outright until the first is ruled.
function nextDeriveTestsStaleVersion(projectDir, domain) {
  return highestRulingNumber(projectDir, `derive-tests-${domain}-stale`) + 1;
}

// The proposal name a `--revise` re-run opens: `n` is how many rulings this domain's test
// proposal has already been through, including the one that sent this run back — the same
// "count rulings, not attempts" rule `contract` and `--stale` follow. Read literally, that
// makes the very first `--revise` after a single return `derive-tests-<d>-2`, never `-1`:
// the un-numbered `derive-tests-<d>` was already the family's first attempt, so a
// numbered name only ever starts counting from its second. `n` is computed here, in a
// post-check, which runs after `checkDeriveTestsRevisionSource` has already recorded this
// run's own return onto `main` — so that return's gate file is on disk and counted, same
// as every earlier one. The regex requires a bare number after the domain, so it never
// matches a `-stale-<n>` gate file, which counts toward `nextDeriveTestsStaleVersion`
// instead — the two sequences are independent.
function nextDeriveTestsRevisionVersion(projectDir, domain) {
  return highestRulingNumber(projectDir, `derive-tests-${domain}`) + 1;
}

// The proposal names a returned derive-tests ruling for one domain can be found under:
// the full run's own fixed name, any earlier `--revise` re-run of it, and any `--stale`
// re-run — a reviewer can return any one of them. Checked in that order (most general
// first, most recent `--stale` numbering last) and, within the numbered forms, highest
// number first, on the same reasoning `archaeology --revise`'s own follow-up search uses:
// a later re-run's return is the more recent word on the domain, and once a return is
// recorded (`recordReturnOnMain`, below) it no longer has a gate file missing from `main`
// and drops out of `returnedRulingOn`'s own candidacy on its own — so in the ordinary case
// at most one of these names ever qualifies at all.
function deriveTestsRevisionCandidates(projectDir, domain) {
  const names = [`derive-tests-${domain}`];
  const refs = gitOk(["for-each-ref", "--format=%(refname:short)", `refs/heads/proposal/derive-tests-${domain}-*`], projectDir)
    ? git(["for-each-ref", "--format=%(refname:short)", `refs/heads/proposal/derive-tests-${domain}-*`], projectDir).split("\n").filter(Boolean)
    : [];
  const revisedRe = new RegExp(`^proposal/derive-tests-${escapeRe(domain)}-(\\d+)$`);
  const staleRe = new RegExp(`^proposal/derive-tests-${escapeRe(domain)}-stale-(\\d+)$`);
  const revisedNums = refs.map((b) => revisedRe.exec(b)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => b - a);
  const staleNums = refs.map((b) => staleRe.exec(b)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => b - a);
  for (const n of revisedNums) names.push(`derive-tests-${domain}-${n}`);
  for (const n of staleNums) names.push(`derive-tests-${domain}-stale-${n}`);
  return names;
}

function findReturnedDeriveTestsRuling(projectDir, domain) {
  for (const name of deriveTestsRevisionCandidates(projectDir, domain)) {
    const found = returnedRulingOn(projectDir, name, `proposal/${name}`);
    if (found) return { name, branch: `proposal/${name}`, ...found };
  }
  return null;
}

// `derive-tests --revise`'s own pre-check, mirroring `checkRevisionSource` above: is there
// a returned test proposal to revise from at all? Finding it and stashing its rationale,
// conditions and the returned branch's own commit on `ctx.revision` happens in every mode
// (a dry run's printed prompt and the workspace both need them); recording the return onto
// `main` (`recordReturnOnMain`, which for G3 renames the branch to `returned/<name>`
// rather than deleting it — the tests it carries live only there) happens only on a real
// run. `branchCommit` is read before that rename, from the still-live `proposal/<name>`
// ref, so it names the commit regardless of what the branch is called by the time
// `materialise` reads it.
function checkDeriveTestsRevisionSource(projectDir, ctx) {
  const id = "derive-tests-revise-source";
  if (!ctx.revise || !ctx.domain) return { id, ok: true, messages: [] };
  const found = findReturnedDeriveTestsRuling(projectDir, ctx.domain);
  if (!found) {
    const requested = requestedRevision(projectDir, "derive-tests");
    if (!requested) return { id, ok: false, messages: [`derive-tests --revise: no returned ruling for ${ctx.domain} to revise from`] };
    ctx.revision = requested;
    return { id, ok: true, messages: [] };
  }
  const branchCommit = git(["rev-parse", found.branch], projectDir);
  ctx.revision = withOpenRequests(projectDir, "derive-tests", { ...found, branchCommit });
  if (!ctx.dryRun) recordReturnOnMain(projectDir, found, { gate: "G3", keepBranch: true });
  return { id, ok: true, messages: [] };
}

// A criterion id mentioned anywhere in a condition's own text — the closest thing G3's
// free-text conditions have to a target, since (unlike G1's ratification grammar) there is
// no formal `<verb> <id>: <text>` shape to parse one out of reliably. Matches both a
// permanent id (`R-1.1`) and a provisional one (`D-applications-2`), since a returned test
// proposal can equally have been derived against either.
const CONDITION_CRITERION_ID_RE = /\b(?:R-\d+\.\d+|D-[a-z0-9-]+-\d+)\b/g;

// The spec files a revision's own conditions name, by the criterion id(s) each condition
// mentions — the set `checkDeriveTestsRevisionDrift` (below) exempts from having to come
// out of a revision byte-for-byte unchanged.
function conditionNamedFiles(domain, conditions) {
  const named = new Set();
  for (const line of conditions ?? []) {
    for (const id of String(line).match(CONDITION_CRITERION_ID_RE) ?? []) named.add(`tests/acceptance/${domain}/${id}.spec.ts`);
  }
  return named;
}

// `derive-tests --revise`'s own promise, the same one `archaeology --revise` keeps for a
// domain file's already-minted criteria: a return names specific tests as wrong, never a
// reason to quietly rewrite ones nobody asked about. Every spec file the returned branch
// already carried, whose criterion no condition names, has to come out of a revision
// exactly as that branch had it — compared against the returned branch's own commit
// (`ctx.revision.branchCommit`), which is a revision's real baseline, not against `HEAD`
// (main may have moved on for reasons unrelated to this domain since the branch was
// opened) and not against the workspace's own starting point (the same commit, but naming
// it this way keeps the check readable on its own). Not run outside `--revise`.
//
// It also enforces the same promise for the shared `tests/acceptance/not-testable.yaml`:
// every entry belonging to another domain has to come out of this run exactly as `HEAD`
// had it — compared against `HEAD` itself (still the commit this run started from; nothing
// is committed until every post-check passes), not the returned branch, since another
// domain's entries are never that branch's to have an opinion on. `materialise`'s own
// overlay merge (`workspace.mjs`) is what keeps this true in the ordinary case; this is
// what catches a regression in that merge, or a hand-edit that touched it anyway, before a
// persona ever sees it.
function criteriaAt(projectDir, ref, relPath) {
  if (!gitOk(["cat-file", "-e", `${ref}:${relPath}`], projectDir)) return [];
  try {
    const parsed = parseYaml(git(["show", `${ref}:${relPath}`], projectDir));
    return Array.isArray(parsed?.criteria) ? parsed.criteria : [];
  } catch {
    return [];
  }
}

function checkDeriveTestsRevisionDrift(projectDir, ctx) {
  const id = "derive-tests-revise-drift";
  if (!ctx.revise || !ctx.domain || !ctx.revision?.branchCommit) return { id, ok: true, messages: [] };
  const domain = ctx.domain;
  const dirRel = `tests/acceptance/${domain}`;
  const commit = ctx.revision.branchCommit;
  const before = gitOk(["ls-tree", "-r", "--name-only", commit, "--", dirRel], projectDir)
    ? git(["ls-tree", "-r", "--name-only", commit, "--", dirRel], projectDir).split("\n").filter(Boolean)
    : [];
  const named = conditionNamedFiles(domain, ctx.revision.conditions);
  const messages = [];
  for (const rel of before) {
    if (!rel.endsWith(".spec.ts") || named.has(rel)) continue;
    const full = join(projectDir, rel);
    if (!existsSync(full)) { messages.push(`${rel}: removed, but no condition named it`); continue; }
    // `git()` trims its output, so the blob's own trailing newline (present in the
    // working tree's file, which `readText` returns unmodified) has to be added back
    // before the two are compared — the same reconstruction `recordReturnOnMain` above
    // uses for the same reason.
    if (readText(full) !== `${git(["show", `${commit}:${rel}`], projectDir)}\n`)
      messages.push(`${rel}: changed, but no condition named it`);
  }

  const notTestablePath = "tests/acceptance/not-testable.yaml";
  const ownsId = domainOwnsId(projectDir, domain);
  const headOthers = new Map(criteriaAt(projectDir, "HEAD", notTestablePath).filter((e) => !ownsId(e?.id)).map((e) => [e.id, e]));
  const nowOthers = new Map(readNotTestable(projectDir).filter((e) => !ownsId(e?.id)).map((e) => [e?.id, e]));
  for (const otherId of new Set([...headOthers.keys(), ...nowOthers.keys()])) {
    if (JSON.stringify(headOthers.get(otherId)) !== JSON.stringify(nowOthers.get(otherId)))
      messages.push(`${notTestablePath}: ${otherId} changed, but belongs to another domain`);
  }

  return { id, ok: messages.length === 0, messages };
}

// `checkTests` resolves a spec file's `blind` claim against git history — a file this
// run just wrote is still uncommitted at post-check time, so only `derive-tests`'s own
// env var lets a `blind` claim on a dirty file stand (`resolveProvenance`,
// `src/checks/tests.mjs`). Set for the duration of the call and restored after, rather
// than left on `process.env` for the rest of the process, so a later check in the same
// run (or a later stage entirely) never inherits it by accident.
function checkTestsBlind(projectDir, ctx) {
  const prev = process.env.SDLC_STAGE;
  process.env.SDLC_STAGE = "derive-tests";
  try {
    return checkTests(projectDir, ctx);
  } finally {
    if (prev === undefined) delete process.env.SDLC_STAGE;
    else process.env.SDLC_STAGE = prev;
  }
}

// A derive-tests session writes one spec file per criterion, and no criterion costs less
// than a read of the contract and a write of its file. So a run given fewer than two
// turns per criterion is very likely to stop partway through the domain, and the way that
// surfaces without this is a coverage failure that reads as bad work rather than as a
// ceiling set too low. A warning and not a failure: the ceiling is the project's to set,
// and a session that finishes early under a tight one is a perfectly good run.
function checkDeriveTestsBudget(ctx) {
  const id = "derive-tests-budget";
  const n = (ctx.deriveTestsCriteria ?? []).length;
  if (!n) return { id, ok: true, messages: [] };
  const turns = turnsFor(ctx.config ?? {}, "derive-tests");
  if (n <= turns / 2) return { id, ok: true, messages: [] };
  return {
    id, ok: true, messages: [],
    warnings: [`derive-tests: ${n} criteria to derive with a ceiling of ${turns} turns; set policy.budgets.derive-tests`],
  };
}

function checkDeriveTestsCoverage(projectDir, domain) {
  const id = "derive-tests-coverage";
  const { missing } = coverage(projectDir, domain);
  if (missing.length)
    return { id, ok: false, messages: [`${domain}: no test and no not-testable.yaml entry for: ${missing.join(", ")}`] };
  return { id, ok: true, messages: [] };
}

// `derive-tests` may only ever change the acceptance suite for its own domain, the
// shared `not-testable.yaml`, and the generated types `prepare` regenerated on its way
// in — never `tests/adapters/`, never `app/`, and never another domain's own tests.
function checkDeriveTestsScope(projectDir, domain) {
  const id = "derive-tests-scope";
  const allowed = new RegExp(`^(tests/acceptance/${domain}/|tests/acceptance/not-testable\\.yaml$|tests/generated/)`);
  const outside = changedPaths(projectDir).filter((p) => !allowed.test(p));
  if (outside.length)
    return {
      id, ok: false,
      messages: [`derive-tests may only change tests/acceptance/${domain}/, tests/acceptance/not-testable.yaml and tests/generated/, but also touched: ${outside.join(", ")}`],
    };
  return { id, ok: true, messages: [] };
}

// The claim every spec file's header makes for itself (`checkTests` resolves whether it
// actually earns it, against git history) still has to be the claim written on the file:
// a `derive-tests` run can never leave a new or changed spec file's own header saying
// `unverified` — that would be a blind stage quietly admitting its own output cannot be
// trusted, rather than the stage that exists to make the claim true in the first place.
function checkDeriveTestsBlindHeader(projectDir, domain) {
  const id = "derive-tests-blind-header";
  const changed = changedPaths(projectDir).filter((p) => p.startsWith(`tests/acceptance/${domain}/`) && p.endsWith(".spec.ts"));
  const messages = [];
  for (const rel of changed) {
    const full = join(projectDir, rel);
    if (!existsSync(full)) continue;
    const second = readText(full).split("\n")[1] ?? "";
    if (!second.includes("provenance: blind"))
      messages.push(`${rel}: second line must declare "provenance: blind" — a derive-tests file can never claim unverified provenance`);
  }
  return { id, ok: messages.length === 0, messages };
}

// The entries this run has answered, taken off `tests/acceptance/redo.yaml`. An entry is
// a standing request to write a criterion's test again; once this run has derived that
// criterion the request is met, and leaving it on the list would send the same id back
// through `--stale` on every future run for as long as the file existed.
//
// Written here rather than in the workspace because the agent must never touch this file:
// it is the pipeline's own bookkeeping, not part of the suite the agent is judged on.
// A post-check may write — `finishStage` commits whatever the working tree holds once the
// checks pass — and this runs after `checkDeriveTestsScope` has already judged the tree,
// so clearing the file cannot widen what the agent was allowed to have touched. It runs
// only when every check passed: a failing run commits nothing of the agent's work, and
// the requests it did not answer have to still be there for the next attempt.
function clearDeriveTestsRedo(projectDir, ctx) {
  const derived = (ctx.deriveTestsCriteria ?? []).map((c) => c.id);
  if (!derived.length) return;
  removeRedo(projectDir, derived);
  // The redo entry and the `test-wrong` ruling record that produced it are two halves of
  // the same answer, so both are retired together: leaving the record behind would mark
  // the freshly written test's next failure as already ruled on, and no new question
  // would ever be asked about it.
  dropTestWrongRulings(projectDir, derived);
}

// The only two paths a `--revise` run's revised domain ever gets to speak for: its own
// acceptance tests, and the shared `not-testable.yaml` entries it may hold among them.
// Read from two places — `runStage` (`src/commands/run.mjs`) builds `materialise`'s
// `overlay.paths` from it, so the workspace's own copy of exactly these paths comes from
// the returned branch's commit rather than `HEAD`; `collect` below scopes a revise run's
// writeback to the same two (plus `tests/generated`, which is never overlaid — it is
// regenerated from `HEAD`'s own contract by `prepare`) so a stray write anywhere else
// under `tests/acceptance/` never leaves the workspace at all, before
// `derive-tests-scope` even gets a chance to judge the tree.
function deriveTestsRevisionScope(domain) {
  return [`tests/acceptance/${domain}`, "tests/acceptance/not-testable.yaml"];
}

// `derive-tests` is the blind stage: an agent that sees only the contract (generated
// into `tests/generated/*` by its own `prepare` step) and the seed writes one Playwright
// spec per accepted criterion, calling the abstract surface and never a locator. It holds
// gate G3: the reviewer persona rules whether each test asserts only what its criterion
// states and nothing about how the system is built.
const deriveTests = {
  name: "derive-tests",
  title: "derive tests",
  skill: skillPath("derive-tests"),
  // A fresh temporary directory built from committed content only (`git archive HEAD`),
  // so the agent writing tests never sees an uncommitted edit to the contract or to
  // another domain's own criteria. On a `--revise` run, `runStage` also overlays
  // `revisionOverlayPaths` below from the returned branch's own commit, so the revised
  // domain starts from exactly what was proposed and returned.
  workspace: "spec-only",
  gate: "G3",
  // The stem this stage's proposals are named from. It is what lets a ruling being written
  // at a gate find the stage its conditions will reach, so a condition naming a path this
  // stage cannot deliver is refused while the ruler is still there to re-address it.
  proposalPrefix: "derive-tests-",
  // The paths a `--revise` run's own workspace was overlaid with — see
  // `deriveTestsRevisionScope` above.
  revisionOverlayPaths: (ctx) => deriveTestsRevisionScope(ctx.domain),
  // Of those paths, `not-testable.yaml` is the one every domain shares, so it cannot be
  // overlaid the way `tests/acceptance/<domain>/` is (the returned branch's content simply
  // replacing whatever `HEAD` has) without discarding whatever entries another domain has
  // added since the branch was cut — the defect this run-record's own `not-testable.yaml`
  // handling exists to fix. `materialise`'s `overlay.merge` (`workspace.mjs`) is what acts
  // on this: it keeps `HEAD`'s entries for every domain but the one under revision, and
  // takes this domain's own entries from the returned branch instead.
  revisionOverlayMerge(projectDir, domain) {
    return [{ path: "tests/acceptance/not-testable.yaml", key: "criteria", ownsId: domainOwnsId(projectDir, domain) }];
  },
  // Copied back into the project once the session ends. A full or `--stale` run copies
  // the whole acceptance suite (nothing else could have changed it) and the generated
  // types `prepare` regenerated in the workspace before the agent ever saw it; a
  // `--revise` run narrows this to the revised domain's own two paths plus
  // `tests/generated`, so another domain's tests and the shared bookkeeping files
  // (`redo.yaml`, `attestations.yaml`) — present in the workspace only because the base
  // archive always includes them, never because this run touched them — are never
  // written back over the project's own copy.
  collect(ctx) {
    return ctx.revise ? [...deriveTestsRevisionScope(ctx.domain), "tests/generated"] : ["tests/acceptance", "tests/generated"];
  },
  // A revise run reads the whole suite and delivers one domain out of it, so the rest of
  // `tests/acceptance` — the sibling domains, `redo.yaml`, `attestations.yaml` — is context
  // for that run rather than output. It is in the workspace for the same reason it always
  // was, and now it is sealed there: a revise run that edited a sibling's tests would have
  // had them dropped at collect time with nothing said. A full run collects the whole
  // directory and declares it there instead.
  context(ctx) {
    return ctx.revise ? ["tests/acceptance"] : [];
  },
  implemented: true,
  // No Bash and no MCP server: a blind test-writing session reads the generated contract
  // and writes spec files, and a shell is the one tool that could reach past the
  // workspace to the application it is not allowed to see.
  allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
  // Generates `tests/generated/*` from the contract already sitting in the workspace
  // (`git archive` put it there), so the agent's very first read of `surface`/`persona`/
  // `seed` is the same TypeScript a real test file imports — never regenerated from a
  // contract the agent could have edited itself, since this workspace never lets it.
  prepare(wsDir) {
    writeGenerated(wsDir);
  },
  prompt(ctx) {
    const d = ctx.domain;
    if (ctx.revise) {
      const rationale = ctx.revision?.rationale ?? "";
      const conditions = ctx.revision?.conditions ?? [];
      const condLines = conditions.length
        ? conditions.map((c, i) => `${i + 1}. ${c}`).join("\n")
        : "(the ruling recorded no separate conditions; act on the rationale alone.)";
      const elsewhere = addressedElsewhereNote(ctx);
      const reopened = isReopening(ctx);
      return [
        reopened ? revisionRulingBlock(ctx)
          : `These tests for the "${d}" domain were proposed and returned, not approved. Here is the reviewer's rationale, verbatim:\n\n\`\`\`\n${rationale}\n\`\`\``,
        reopened ? null : `And each condition it attached, verbatim:\n\n${condLines}`,
        `Change only what these conditions name — a spec file, a not-testable entry, or one assertion inside a file. Every other file already in tests/acceptance/${d}/ and every other entry in tests/acceptance/not-testable.yaml stays byte-for-byte as you found it: re-derive nothing, and never rewrite a header's "derived" date on a file whose content you did not actually change.`,
        `A criterion nothing in surface reaches — no page, action or observation gets you there — still gets an entry in tests/acceptance/not-testable.yaml instead of a file, exactly as a first derivation would.`,
        elsewhere,
        `Finish with your journal entry: say what you changed for each condition, in order, and name any condition you could not act on and why.`,
      ].filter(Boolean).join("\n\n");
    }
    const criteria = ctx.deriveTestsCriteria ?? [];
    const specSha = ctx.deriveTestsGeneratedFrom || "0000000000000000000000000000000000000000";
    const today = new Date().toISOString().slice(0, 10);
    const list = criteria.map((c) => `- ${c.id} (v${c.version}): ${c.statement}`).join("\n");
    return [
      `Write one Playwright acceptance test per criterion below, for the "${d}" domain, and nothing else. You see only the contract (tests/generated/*, generated from spec/contract) and the seed; there is no app/ in this workspace and nothing here lets you read one.`,
      ...redoPromptBlock(ctx),
      `The criteria to derive tests for:\n\n${list}\n\nThis list already excludes any criterion carrying superseded-by: it has been replaced by another, and a test for it could only ever contradict the replacement, so it gets none of its own.`,
      `For each one, write tests/acceptance/${d}/<ID>.spec.ts, starting with exactly these two header lines:\n\n// criterion: @<ID> v<version>\n// provenance: blind, spec@${specSha}, derived ${today}\n\nImport only from "../../fixtures" and "../../generated/*". Sign in through persona.<id> when the criterion needs a signed-in actor, act through surface.<page>.<action>(), read through surface.<page>.<observation>(), refer to a record through seed.<group>.<handle> rather than an id or a value you invented, and observe email through mail rather than a database row or a log line. Write one test() per given/when/then the criterion states, titled with the criterion's own statement. Never read or guess at how the system is built, and never write a selector, a test id, a locator call, or a hardcoded route — the surface is the whole world.`,
      `A criterion nothing in surface reaches — no page, action or observation gets you there — gets an entry in tests/acceptance/not-testable.yaml instead of a file: { id: <ID>, version: <version>, reason: "<why>" }. A reason has to name what is actually missing, not that the criterion is hard.`,
      `Finish with your journal entry: how many criteria got a test, which were not testable and why, and which surface actions or observations you needed but did not find — name them, so the contract can be extended to reach them.`,
    ].join("\n\n");
  },
  proposal(ctx) {
    const d = ctx.domain;
    if (ctx.revise) {
      return {
        name: `derive-tests-${d}-${ctx.deriveTestsRevisionN ?? nextDeriveTestsRevisionVersion(ctx.projectDir, d)}`,
        question: `Do the revised ${d} tests now follow from their criteria and from nothing else?`,
        recommendation: recommendationFrom(ctx.agentText),
      };
    }
    const name = ctx.stale
      ? `derive-tests-${d}-stale-${ctx.deriveTestsStaleN ?? nextDeriveTestsStaleVersion(ctx.projectDir, d)}`
      : nextProposalName(ctx.projectDir, `derive-tests-${d}`);
    return {
      name,
      question: `Do these tests follow from the ${d} criteria and from nothing else?`,
      recommendation: recommendationFrom(ctx.agentText),
    };
  },
  preChecks(projectDir, ctx) {
    const domainCheck = checkDomainOption(ctx, "derive-tests");
    // `checkDeriveTestsRevisionSource` has a side effect on a real `--revise` run
    // (recording the return onto `main`, renaming the spent branch — see its own
    // comment), so on a revise run every check that could fail it off is settled first,
    // and the side-effecting check only runs once all of them have passed: a run with a
    // bad `--domain`, or one against a domain with nothing left to derive tests for at
    // all, fails on that alone, and the returned ruling — if this domain even has one —
    // is left exactly where it was for a corrected re-run to find. Mirrors
    // `archaeology`'s own `preChecks` above. An ordinary run has no such side effect to
    // protect and keeps evaluating every check below regardless of `domainCheck` or
    // `domainRatifiedCheck`, as it always has.
    if (ctx.revise && !domainCheck.ok) return [domainCheck];
    // Cheap and free of any side effect of its own, so it is settled before
    // `checkDeriveTestsRevisionSource` gets a chance to record anything: a domain whose
    // criteria have all been superseded since the returned proposal was opened has
    // nothing left to revise, and that has to fail before the return is recorded, not
    // after.
    const domainRatifiedCheck = checkDeriveTestsDomainRatified(projectDir, ctx);
    if (ctx.revise && !domainRatifiedCheck.ok) return [domainCheck, domainRatifiedCheck];
    const revisionCheck = checkDeriveTestsRevisionSource(projectDir, ctx);
    // Resolved once here — the real project directory, before a workspace exists — and
    // stashed on `ctx` for `prompt(ctx)` to read back later with nothing else to go on. A
    // revise run's prompt is built from the returned branch's own content and the
    // ruling's conditions instead, so there is no "criteria to derive" list to resolve.
    if (ctx.domain && !ctx.revise) {
      const resolved = resolveCriteriaToDerive(projectDir, ctx);
      ctx.deriveTestsCriteria = resolved.criteria;
      ctx.deriveTestsGeneratedFrom = resolved.generatedFrom;
      // Stashed alongside the criteria, and for the same reason: `prompt(ctx)` runs with
      // nothing but `ctx`, and a request's reason is the one thing about it the prompt
      // cannot reconstruct from the contract.
      ctx.deriveTestsRedo = resolved.redo ?? [];
    }
    return [
      domainCheck,
      revisionCheck,
      domainRatifiedCheck,
      checkDeriveTestsStaleHasWork(ctx),
      checkDeriveTestsBudget(ctx),
    ];
  },
  postChecks(projectDir, ctx) {
    // Done before the checks below, because one of them refuses exactly what this clears
    // up and the writer has no way to clear it up itself.
    ctx.deriveTestsRemoved = removeTestsNowRecordedNotTestable(projectDir, ctx.domain);
    // Stashed the same way `contract` stashes its own version: the real `proposal(ctx)`
    // call in `finishStage` does not carry `projectDir`, so a `--stale` or `--revise`
    // run's number has to be resolved here, while it is available, for `proposal` to read
    // back.
    if (ctx.stale) ctx.deriveTestsStaleN = nextDeriveTestsStaleVersion(projectDir, ctx.domain);
    if (ctx.revise) ctx.deriveTestsRevisionN = nextDeriveTestsRevisionVersion(projectDir, ctx.domain);
    const checks = [
      checkTestsBlind(projectDir, ctx),
      checkSeparation(projectDir),
      checkDeriveTestsCoverage(projectDir, ctx.domain),
      checkDeriveTestsScope(projectDir, ctx.domain),
      checkDeriveTestsBlindHeader(projectDir, ctx.domain),
      checkDeriveTestsRevisionDrift(projectDir, ctx),
      typecheckPostCheck(projectDir, `derive-tests-${ctx.domain}`),
    ];
    if (checks.every((c) => c.ok)) clearDeriveTestsRedo(projectDir, ctx);
    return checks;
  },
};

// Everything the rest of this stage needs to know about the target it is binding
// against, resolved once in `preChecks` (the only hook that sees the real project
// directory before `prompt`/`mcp`/`env` run with nothing but `ctx`) and stashed there
// for them to read back — the same pattern `derive-tests` stashes its own resolved
// criteria in. `old`'s base URL and mail API only exist once `sdlc oracle up` has
// actually started it and written `.sdlc/oracle-old.local.yaml` (`readLocal`,
// `src/oracle/ports.mjs`); every other target's base URL is whatever its own config
// entry names, and carries no mail catcher of its own to observe email through.
function resolveBindAdapterTarget(projectDir, ctx) {
  const t = ctx.target;
  if (t === "old") {
    const local = ctx.config?.oracle?.target === "old" ? readLocal(projectDir, "old") : null;
    ctx.bindAdapterBaseUrl = local?.base_url;
    ctx.bindAdapterMailApi = local?.mail_api ?? "";
    ctx.bindAdapterIdentity = ctx.config?.oracle?.identity;
  } else {
    const target = ctx.config?.targets?.[t];
    ctx.bindAdapterBaseUrl = target?.base_url;
    ctx.bindAdapterMailApi = "";
    ctx.bindAdapterIdentity = target?.identity;
  }
}

// A one-shot "is anything answering here at all" probe, any HTTP status included —
// `preChecks` is called synchronously (`sdlc run`'s own contract with every stage), and
// Node has no synchronous `fetch`, so the check runs in a short-lived child process
// instead of blocking the event loop itself. `AbortSignal.timeout` bounds it to 5s
// and `execFileSync` has a 6s OS-level timeout so a stalled child never blocks the
// pre-check forever; both layers ensure a target that never answers fails promptly.
function probeHttp(url) {
  const script = "fetch(process.argv[1], { signal: AbortSignal.timeout(5000) })"
    + ".then(() => process.exit(0)).catch(() => process.exit(1));";
  try {
    execFileSync(process.execPath, ["-e", script, url], { timeout: 6000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// The target must actually be reachable before an agent turn spends a session walking
// it with a browser. `--target old` fails by name ("run sdlc oracle up first") when
// nothing has started it yet; any other target already had its shape checked by
// `checkBindAdapterTargetOption` above, so an invalid one reports nothing further here
// rather than repeating that check's own message. `SDLC_ORACLE=mock` — the same escape
// hatch every other oracle-facing call in this pipeline uses (`src/oracle/compose.mjs`)
// — skips the real network probe entirely, since a mock run has no server to answer it.
function checkBindAdapterTargetUp(ctx) {
  const id = "bind-adapter-target-up";
  if (!ctx.target) return { id, ok: true, messages: [] };
  if (ctx.target === "old" && ctx.config?.oracle?.target !== "old") return { id, ok: true, messages: [] };
  if (ctx.target !== "old" && !(ctx.target in (ctx.config?.targets ?? {}))) return { id, ok: true, messages: [] };
  if (!ctx.bindAdapterBaseUrl) {
    return ctx.target === "old"
      ? { id, ok: false, messages: ["bind-adapter: the old target is not up; run sdlc oracle up first"] }
      : { id, ok: false, messages: [`bind-adapter: target "${ctx.target}" has no base_url configured`] };
  }
  if (process.env.SDLC_ORACLE === "mock") return { id, ok: true, messages: [] };
  const baseUrl = ctx.bindAdapterBaseUrl.replace(/\/$/, "");
  if (!probeHttp(`${baseUrl}/`))
    return { id, ok: false, messages: [`bind-adapter: ${baseUrl}/ did not answer`] };
  return { id, ok: true, messages: [] };
}

// The proposal name a run opens: `bind-adapter-<t>` the first time, `bind-adapter-<t>-<n>`
// after that — `n` counting up from every ruled `bind-adapter-<t>*` gate file already on
// disk, the same "count rulings, not attempts" rule `contract`'s own `-v<n>` follows.
// Unlike `contract`, the un-numbered name is the one a fresh target gets; a number only
// appears once a first ruling already exists to count.
function nextBindAdapterName(projectDir, target) {
  return nextProposalName(projectDir, `bind-adapter-${target}`);
}

// `bindings.yaml` names every action and observation the surface declares, on every
// page, exactly once — `bound`, or `unbound: <reason>` — and names nothing the surface
// does not. Checked against `loadContract`, the same source of truth `writeGenerated`
// built `tests/generated/surface.d.ts` from, so an adapter can never quietly drift from
// what the contract (and therefore the acceptance suite) actually names.
function checkBindAdapterBindings(projectDir, target) {
  const id = "bind-adapter-bindings";
  const file = `tests/adapters/${target}/bindings.yaml`;
  const full = join(projectDir, file);
  if (!existsSync(full)) return { id, ok: false, messages: [`${file} is missing`] };
  let doc;
  try {
    doc = parseYaml(readText(full)) ?? {};
  } catch (e) {
    return { id, ok: false, messages: [`${file} is not valid YAML: ${e.message}`] };
  }
  const { surface, errors } = loadContract(projectDir);
  if (errors.length) return { id, ok: false, messages: errors.map((e) => `${e.file}: ${e.message}`) };

  const messages = [];
  const isVerdict = (v) => v === "bound" || (typeof v === "string" && v.startsWith("unbound:"));
  const pages = doc.pages && typeof doc.pages === "object" && !Array.isArray(doc.pages) ? doc.pages : {};
  const surfaceIds = new Set(surface.pages.map((p) => p.id));

  for (const page of surface.pages) {
    const entry = pages[page.id] ?? {};
    for (const group of ["actions", "observations"]) {
      const named = Object.keys(page[group] ?? {});
      const bound = entry[group] && typeof entry[group] === "object" && !Array.isArray(entry[group]) ? entry[group] : {};
      for (const name of named) {
        const verdict = bound[name];
        if (verdict === undefined) messages.push(`${file}: ${page.id}.${name} is missing`);
        else if (!isVerdict(verdict)) messages.push(`${file}: ${page.id}.${name} must be "bound" or "unbound: <reason>", got ${JSON.stringify(verdict)}`);
      }
      for (const name of Object.keys(bound)) {
        if (!named.includes(name)) messages.push(`${file}: ${page.id}.${group}.${name} is not in the surface`);
      }
    }
  }
  for (const pageId of Object.keys(pages)) {
    if (!surfaceIds.has(pageId)) messages.push(`${file}: page "${pageId}" is not in the surface`);
  }
  return { id, ok: messages.length === 0, messages };
}

function checkBindAdapterIndex(projectDir, target) {
  const id = "bind-adapter-index";
  const file = `tests/adapters/${target}/index.ts`;
  if (!existsSync(join(projectDir, file))) return { id, ok: false, messages: [`${file} is missing`] };
  return { id, ok: true, messages: [] };
}

// `bind-adapter` may only ever change its own target's corner of the adapter tree —
// never another target's adapter, never `tests/acceptance` (which this workspace never
// even materialises, so touching it would mean something else went wrong entirely).
function checkBindAdapterScope(projectDir, target) {
  const id = "bind-adapter-scope";
  const allowed = new RegExp(`^tests/adapters/${escapeRe(target)}/`);
  const outside = changedPaths(projectDir).filter((p) => !allowed.test(p));
  if (outside.length)
    return { id, ok: false, messages: [`bind-adapter may only change tests/adapters/${target}/, but also touched: ${outside.join(", ")}`] };
  return { id, ok: true, messages: [] };
}

// The sign-in instructions for the prompt below, one paragraph per identity this
// pipeline knows how to reach: `session-route` mints a session by URL alone, no form to
// fill; `sandbox-idp` needs an actual form filled with the persona's username and the
// sandbox password every target under test shares — read from the environment, never
// invented, and never named as its own value here (the value lives only in `env`,
// never printed by a dry run and never worth spelling out to an agent turn that only
// ever needs the variable's name).
function bindAdapterSignInInstructions(identity) {
  if (identity === "sandbox-idp") {
    return "This target signs in through sandbox-idp: find the identity provider's own sign-in form and fill it with the persona's username (persona.signIn[\"sandbox-idp\"].username) and the password in your SDLC_SANDBOX_PASSWORD environment variable — never a password you invent or find written down anywhere.";
  }
  if (identity === "session-route") {
    return "This target signs in through session-route: page.goto(baseURL + persona.signIn[\"session-route\"].route) mints the session directly — there is no form to fill.";
  }
  return `This target's identity ("${identity ?? "unknown"}") is not one this pipeline names a sign-in method for; sign in the way the running application actually offers, and say in your journal what you found.`;
}

// `bind-adapter` writes the one binding of the abstract `Surface` for one target,
// walking the *running* application with a real browser (the Playwright MCP server) —
// never reading source, because its `blind-adapter` workspace never has any application
// source to read. It holds gate G3, the same gate `derive-tests` holds: the reviewer
// persona rules whether the binding is navigation and locators only, covers everything
// the contract names, and touches nothing outside its own target's corner of the tree.
// The proposal names a `bind-adapter --revise` run may revise from, newest first: the
// numbered re-runs for this target, then the first binding's own bare name. Mirrors
// `deriveTestsRevisionCandidates` above, and for the same reason — a return is always the
// most recent word on a target, and the highest-numbered proposal is the most recent
// return there can be.
function bindAdapterRevisionCandidates(projectDir, target) {
  const pattern = `refs/heads/proposal/bind-adapter-${target}-*`;
  const refs = gitOk(["for-each-ref", "--format=%(refname:short)", pattern], projectDir)
    ? git(["for-each-ref", "--format=%(refname:short)", pattern], projectDir).split("\n").filter(Boolean)
    : [];
  const re = new RegExp(`^proposal/bind-adapter-${escapeRe(target)}-(\\d+)$`);
  const numbers = refs.map((b) => re.exec(b)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => b - a);
  return [...numbers.map((n) => `bind-adapter-${target}-${n}`), `bind-adapter-${target}`];
}

// `bind-adapter --revise`'s own pre-check, the same shape `derive-tests --revise` uses.
// Without it a returned adapter has no correction path at all: the stage takes neither
// `--revise` nor `--stale`, so a ruling naming three observations to change costs a
// binding walked from nothing, which on a surface of this size is the most expensive turn
// in the pipeline. The returned branch's own commit is stashed on `ctx.revision` for
// `runStage` to overlay the adapter from, so the revision starts from exactly what was
// proposed rather than from whatever `main` still carries.
function checkBindAdapterRevisionSource(projectDir, ctx) {
  const id = "bind-adapter-revise-source";
  if (!ctx.revise || !ctx.target) return { id, ok: true, messages: [] };
  const found = findReturnedBindAdapterRuling(projectDir, ctx.target);
  if (!found) {
    const requested = requestedRevision(projectDir, "bind-adapter");
    if (!requested) return { id, ok: false, messages: [`bind-adapter --revise: no returned ruling for ${ctx.target} to revise from`] };
    ctx.revision = requested;
    return { id, ok: true, messages: [] };
  }
  const branchCommit = git(["rev-parse", found.branch], projectDir);
  ctx.revision = withOpenRequests(projectDir, "bind-adapter", { ...found, branchCommit });
  if (!ctx.dryRun) recordReturnOnMain(projectDir, found, { gate: "G3", keepBranch: true });
  return { id, ok: true, messages: [] };
}

function findReturnedBindAdapterRuling(projectDir, target) {
  for (const name of bindAdapterRevisionCandidates(projectDir, target)) {
    const found = returnedRulingOn(projectDir, name, `proposal/${name}`);
    if (found) return { name, branch: `proposal/${name}`, ...found };
  }
  return null;
}

// What a `--revise` run is told on top of the ordinary task: the binding it is revising is
// already in the workspace, and a ruling names what was wrong with it. The instruction to
// change only what the conditions name is the same promise `derive-tests --revise` keeps —
// a return names specific bindings as wrong, and is never licence to rewrite the ones
// nobody asked about.
function bindAdapterRevisionInstructions(ctx) {
  const conditions = revisionConditionList(ctx);
  return [
    `This is a revision. The binding you are correcting is already at tests/adapters/${ctx.target}/ — open it and change only what the conditions below name. Do not rebind what was accepted, and do not start the target's walk over.`,
    revisionRulingBlock(ctx),
    conditions ? `The conditions it must now meet:\n\n${conditions}` : "",
    addressedElsewhereNote(ctx),
  ].filter(Boolean).join("\n\n");
}

// What a calibration found wanting in this target's adapter — the `adapter-wrong` verdicts
// the reviewer gave when it sorted a calibration's failures, carried into the next binding
// run. These are the findings a
// reviewer reading the diff cannot supply and the agent cannot discover: a control it
// reported missing that the application does render, a value it read off the wrong part of
// the page. Each names the criterion whose test failed, so the agent can see what the
// binding was being asked for.
function bindAdapterCalibrationFindings(ctx) {
  const entries = ctx.bindAdapterRebind ?? [];
  if (!entries.length) return null;
  const lines = entries.map((e) => `- ${e.id}: ${e.why}`).join("\n");
  return [
    `A calibration run found these bindings wanting. Sorting its failures, the reviewer found the criterion and the test sound in each case, and this adapter to be what failed:`,
    lines,
    `Correct each one. Where a finding says a control exists that you reported unbound, look again for it — under a different label, behind a step, on a page reached another way — before reporting it unbound a second time, and say in the reason what you did to look.`,
  ].join("\n\n");
}

const bindAdapter = {
  name: "bind-adapter",
  title: "bind adapter",
  skill: skillPath("bind-adapter"),
  workspace: "blind-adapter",
  gate: "G3",
  // The stem this stage's proposals are named from. It is what lets a ruling being written
  // at a gate find the stage its conditions will reach, so a condition naming a path this
  // stage cannot deliver is refused while the ruler is still there to re-address it.
  proposalPrefix: "bind-adapter-",
  // On a `--revise` run the returned branch's own adapter is overlaid into the workspace,
  // so the agent opens the binding it wrote rather than an empty directory. Nothing else
  // is overlaid: `tests/generated` is regenerated from `HEAD`'s contract by `prepare`, and
  // an adapter has no file it shares with another target.
  revisionOverlayPaths: (ctx) => [`tests/adapters/${ctx.target}`],
  // Only the adapter itself: `tests/generated/*`, regenerated in the workspace by
  // `prepare` below, is derived straight from the contract already committed on
  // `main` and needs no commit of its own here.
  collect: ["tests/adapters"],
  implemented: true,
  // Turns the contract this workspace archived (`spec/contract/`) into the same
  // `tests/generated/surface.d.ts` a real adapter file imports, so the agent's very
  // first read of `Surface` is the type it is about to implement, not a hand-derived
  // guess at it.
  prepare(wsDir) {
    writeGenerated(wsDir);
  },
  mcp() {
    // `--browser chromium` is load-bearing: the server otherwise defaults to the Google
    // Chrome *channel* and looks for an installed Chrome, which a CI image or a developer
    // machine that only ever installed Playwright does not have. The failure is silent
    // from the agent's side — every navigation fails before a page exists — and an
    // adapter session that cannot open a page can only report everything unbound, which
    // is a whole stage's budget spent to learn that a browser was missing. Chromium is
    // the build `runSuite` already installs, so this asks for the one that is there.
    return { playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.80", "--headless", "--isolated", "--browser", "chromium"] } };
  },
  // No Bash: an adapter session drives the browser and edits files, and has no
  // business reaching a shell.
  allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "mcp__playwright__*"],
  env(ctx) {
    return {
      SDLC_TARGET_URL: ctx.bindAdapterBaseUrl ?? "",
      SDLC_MAIL_API: ctx.bindAdapterMailApi ?? "",
      SDLC_SANDBOX_PASSWORD: process.env.SDLC_SANDBOX_PASSWORD ?? "",
    };
  },
  prompt(ctx) {
    const t = ctx.target;
    const identity = ctx.bindAdapterIdentity;
    return [
      // The URL is written into the prompt, not left in the environment for the session to
      // look up. It is passed as `SDLC_TARGET_URL` as well, because the adapter's own code
      // and every later stage read it there — but this session has no shell, by design, and
      // so no way to read an environment variable at all. Told only where the value lived,
      // one run browsed a URL out of the harness README instead and said so in its journal.
      `Write tests/adapters/${t}/index.ts, exporting default function create(page: Page, ctx: { baseURL: string; persona: typeof persona }): Surface, implementing every page tests/generated/surface.d.ts declares for this project. This target is named "${t}" and it is running right now at ${ctx.bindAdapterBaseUrl || "(no base URL resolved — say so and bind nothing)"}. Open that address with the browser tools and bind against what you find there — never a selector copied from source, because there is no source in this workspace to copy one from. The same address reaches your adapter as "baseURL" when it runs for real, so build every URL from the "baseURL" you are given rather than writing this one into the file.`,
      ctx.bindAdapterMailApi
        ? `Email this target sends is readable through a mail catcher at ${ctx.bindAdapterMailApi}, which is what spec/contract/observables.yaml means by \${SDLC_MAIL_API}. Your adapter reads it from process.env at run time; this is the address it has while you are looking.`
        : null,
      `signIn(persona) reads persona.signIn["${identity ?? "?"}"] for the persona it is given. ${bindAdapterSignInInstructions(identity)} When that entry is { unavailable: "<reason>" } instead of real credentials, signIn must throw new Error("unbound: signIn.<persona id> — <reason>") rather than attempt to sign in — the same shape as an unbound action or observation, so calibrate reports every criterion that needs this persona as unbound instead of a real failure.`,
      `Bind every action and observation by driving the browser: open the page at its route, find the control by its role, its label, its visible text, or the URL it lands you on — never a CSS selector, a test id, or anything else that only makes sense with the source open next to you. An action or observation nothing on the page actually does throws new Error("unbound: <page>.<member> — <reason>") from that method, naming what is missing.`,
      `Write tests/adapters/${t}/bindings.yaml naming every action and observation on every page in the surface exactly once, as "bound" or "unbound: <reason>". Spell every page, action and observation exactly as spec/contract/surface.yaml spells it — "applications-new" and "submit_proposal", not the camelCased TypeScript members ("applicationsNew", "submitProposal") your adapter implements them as:\n\ntarget: ${t}\npages:\n  <pageId>:\n    actions: { <name>: bound }\n    observations: { <name>: "unbound: <why>" }`,
      `Your territory is tests/adapters/${t}/ alone. Never write under tests/acceptance or spec/ — this workspace does not even have them for you to touch by mistake.`,
      `Finish with your journal entry: what was bound, what was not and why, and any page whose route in surface.yaml did not resolve on the target.`,
      ctx.revise ? bindAdapterRevisionInstructions(ctx) : null,
      bindAdapterCalibrationFindings(ctx),
    ].filter(Boolean).join("\n\n");
  },
  proposal(ctx) {
    const t = ctx.target;
    return {
      name: ctx.bindAdapterName ?? nextBindAdapterName(ctx.projectDir, t),
      question: `Does this adapter bind every surface action and observation on ${t}, and nothing else?`,
      recommendation: recommendationFrom(ctx.agentText),
    };
  },
  preChecks(projectDir, ctx) {
    if (ctx.target) resolveBindAdapterTarget(projectDir, ctx);
    // Stashed here, the one hook that sees the project directory before `prompt(ctx)` runs
    // with nothing but `ctx` — the same place this stage resolves its target's URL. Not
    // cleared by this stage: a proposal that is returned has fixed nothing, and a revise of
    // it still needs the findings. `calibrate` clears them once it has run against an
    // adapter that changed since they were written.
    ctx.bindAdapterRebind = ctx.target ? readRebindFor(projectDir, ctx.target) : [];
    return [
      checkTargetOption("bind-adapter", ctx),
      checkSandboxPassword("bind-adapter", ctx, "binding against"),
      checkBindAdapterTargetUp(ctx),
      checkBindAdapterRevisionSource(projectDir, ctx),
    ];
  },
  postChecks(projectDir, ctx) {
    // Stashed the same way `contract` stashes its own version: the real `proposal(ctx)`
    // call in `finishStage` does not carry `projectDir`, so the name has to be resolved
    // here, while it is available, for `proposal` to read back.
    ctx.bindAdapterName = nextBindAdapterName(projectDir, ctx.target);
    const checks = [
      checkSeparation(projectDir),
      checkBindAdapterBindings(projectDir, ctx.target),
      checkBindAdapterIndex(projectDir, ctx.target),
      checkBindAdapterScope(projectDir, ctx.target),
      typecheckPostCheck(projectDir, ctx.bindAdapterName),
    ];
    return checks;
  },
};

function ratifyGateName(domain) {
  return `archaeology-${domain}`;
}

function ratifyGatePath(projectDir, domain) {
  return join(projectDir, ".sdlc", "gates", `${ratifyGateName(domain)}.yaml`);
}

// The name of the nth follow-up proposal for a domain — the closing loop's own gate,
// asked once per pass over whatever is still `inferred` or `open`.
function followUpName(domain, n) {
  return `ratify-${domain}-${n}`;
}

// Whether a criterion id belongs to `domain`: its own provisional `D-<domain>-<n>` form,
// or a permanent `R-<k>.<n>` form whose `k` is the domain's own ordinal in
// `config.project.domains` (`domainOrdinal`, `src/spec/criteria.mjs`). Shared by
// `readRulings` below, scoping a shared `contract-v<n>` ruling's conditions to the domain
// that owns each id, and by `derive-tests`'s own `--revise` overlay merge (below), scoping
// the shared `tests/acceptance/not-testable.yaml`'s entries to the domain under revision.
function domainOwnsId(projectDir, domain) {
  const dOwnId = new RegExp(`^D-${escapeRe(domain)}-\\d+$`);
  const ordinal = domainOrdinal(projectDir, domain);
  const rOwnId = ordinal !== undefined ? new RegExp(`^R-${ordinal}\\.\\d+$`) : null;
  return (id) => typeof id === "string" && (dOwnId.test(id) || (rOwnId !== null && rOwnId.test(id)));
}

// The moment a gate file records its ruling being made — `at`, written by `sdlc rule` on
// every verdict it writes. `undefined` for a file that has none (hand-written, or a gate
// format older than the field), which `domainRulingNames` sorts last rather than guessing
// a position for it.
function gateRuledAt(path) {
  try {
    const at = (parseYaml(readText(path)) ?? {}).at;
    return typeof at === "string" && at ? at : undefined;
  } catch { return undefined; }
}

// Every ruling on this domain, oldest first, across all three families that carry
// ratification conditions for it: the first archaeology proposal (`archaeology-<d>`), the
// closing loop's follow-ups (`ratify-<d>-<n>`), and the numbered archaeology proposals a
// re-run opens (`archaeology-<d>-<n>`). The last of those is the proposal a re-recovery is
// ruled on — the route `recovery-wrong` sends a criterion down — and a `confirm` filed
// there is the ordinary way that criterion closes out, so a reading that skipped it would
// drop the ruling that answers the request.
//
// Ordered by when each ruling was actually made rather than by name, because the two
// families number independently: `archaeology-<d>-3` and `ratify-<d>-3` say nothing about
// which came first, and the order decides which verdict on a criterion applies over which.
// An ISO timestamp compares chronologically as plain text. A gate file with no `at` sorts last, on
// the reading that a file without the field was added by hand after the rest; ties break on
// family and then number, so the order is total and stable whatever the clock did.
function domainRulingNames(projectDir, domain) {
  const dir = join(projectDir, ".sdlc", "gates");
  if (!existsSync(dir)) return [ratifyGateName(domain)];
  const archRe = new RegExp(`^archaeology-${escapeRe(domain)}(?:-(\\d+))?\\.yaml$`);
  const followRe = new RegExp(`^ratify-${escapeRe(domain)}-(\\d+)\\.yaml$`);
  const rows = [];
  for (const f of readdirSync(dir)) {
    const arch = archRe.exec(f);
    const follow = arch ? null : followRe.exec(f);
    if (!arch && !follow) continue;
    rows.push({
      name: f.replace(/\.yaml$/, ""),
      family: arch ? 0 : 1,
      number: arch ? (arch[1] ? Number(arch[1]) : 1) : Number(follow[1]),
      at: gateRuledAt(join(dir, f)),
    });
  }
  rows.sort((a, b) =>
    (a.at ?? "\uffff").localeCompare(b.at ?? "\uffff") || a.family - b.family || a.number - b.number);
  const names = rows.map((r) => r.name);
  // The first archaeology ruling is always read, even before it exists on disk: every
  // other reader of this list (`checkArchaeologyApproved`, and `readGate`'s own
  // existence check) treats a missing gate file as nothing to read, and naming it keeps
  // that the single answer rather than two different ones.
  return names.includes(ratifyGateName(domain)) ? names : [ratifyGateName(domain), ...names];
}

// Every ruling this domain's ratification is built from, in the order it was made: the
// archaeology proposal first, then each follow-up (`ratify-<d>-1`, `-2`, …) by number,
// then every approved `contract-v<n>` gate, oldest first. Only approved rulings
// contribute — a returned or escalated follow-up (or contract re-run) has decided
// nothing — and the conditions are concatenated in that order, so a later ruling's
// verdict on a criterion is applied after (and therefore over) an earlier one's —
// including a contract ruling landing after a follow-up already touched the same id.
//
// A `contract-v<n>` gate is ruled once for every domain at once — the product-owner
// persona names whatever criteria it means, from whichever domain, on the one G1
// proposal the `contract` stage opens — so its conditions are kept here only when the
// id they name belongs to *this* domain: a `D-<domain>-<n>` id, or an `R-<k>.<n>` id
// whose `k` is this domain's own ordinal in `config.project.domains` (`domainOrdinal`,
// `src/spec/criteria.mjs`). A condition naming another domain's id is left for that
// domain's own `ratify` run to pick up — without this filter, every domain's `ratify`
// would report every other domain's conditions as `unknown`. A line the grammar could
// not parse at all carries no id to judge ownership by, so it is never filtered out this
// way; it is always folded in as `unparsed`, for whichever domain runs `ratify` first to
// report and block on.
//
// `answered` is every id an earlier ruling gave `contract` or `spike` to — the two
// verbs that record a decision without ever raising a criterion's confidence, so
// neither one moves it toward the contract. A criterion answered that way once; the
// follow-up page says which ones already were, so the persona knows it is being asked
// to close one out with `confirm`, `edit`, `obsolete` or `defect` rather than to repeat
// the same non-answer. `followUpRulingsRead`, right below, is what actually stops the
// loop if a persona repeats it anyway.
function readRulings(projectDir, domain) {
  const dir = join(projectDir, ".sdlc", "gates");
  const names = domainRulingNames(projectDir, domain);

  const conditions = [];
  const unparsed = [];
  const answered = new Set();
  const read = [];
  // Every `contract-v<n>` that actually contributed a condition to this domain —
  // reported separately from `read` (which stays the domain's own rulings, the count
  // `followUpRulingsRead` relies on) so `ratify`'s journal text can say by name which
  // contract gate(s), if any, a run's changes came from.
  const contractRead = [];

  const ownsId = domainOwnsId(projectDir, domain);

  const readGate = (name, { filterToOwnIds = false, into = read } = {}) => {
    const p = join(dir, `${name}.yaml`);
    if (!existsSync(p)) return;
    const gate = parseYaml(readText(p)) ?? {};
    if (gate.verdict !== "approve") return;
    let contributed = !filterToOwnIds;
    for (const c of gate.conditions ?? []) {
      if (filterToOwnIds) {
        const id = conditionTargetId(c);
        if (id !== null && !ownsId(id)) continue;
      }
      contributed = true;
      conditions.push(c);
      // `contract` takes a bare ID; `spike` requires a trailing colon and text. Matched
      // separately so neither pattern accidentally swallows the colon into the ID.
      const m = /^\s*contract\s+(\S+)\s*$/.exec(c) ?? /^\s*spike\s+(\S+):/.exec(c);
      if (m) answered.add(m[1]);
    }
    for (const u of gate.unparsed_conditions ?? []) { contributed = true; unparsed.push(`.sdlc/gates/${name}.yaml: ${u}`); }
    if (contributed) into.push(name);
  };

  for (const name of names) readGate(name);
  for (const name of contractGateNames(projectDir)) readGate(name, { filterToOwnIds: true, into: contractRead });

  return { read, contractRead, conditions, unparsed, answered };
}

// How many of `read`'s approved gate files are follow-ups (`ratify-<domain>-<n>`) rather
// than the archaeology ruling itself. A criterion still short of the contract at this
// point has been asked about on every follow-up opened so far — `unresolved` in
// `followUp` below only ever grows the set of ids a fresh follow-up lists, so an id that
// is still in it now was in it the last time a follow-up was opened too — which is what
// lets a single domain-wide count stand in for a per-criterion one and still be exact,
// as long as archaeology has not been re-run for this domain since (a rerun can add
// fresh `D-` ids partway through the loop that have not actually been asked about yet;
// closing that gap is not part of what this count is for).
function followUpRulingsRead(read, domain) {
  const re = new RegExp(`^ratify-${escapeRe(domain)}-\\d+$`);
  return read.filter((n) => re.test(n)).length;
}

// Which returned ruling `--revise` acts on when a domain has more than one candidate:
// the highest-numbered follow-up if any follow-up was returned, else the archaeology
// proposal itself. A follow-up's return is always the more recent word on the domain —
// follow-ups are opened and ruled in order, so a higher number can only exist because an
// earlier one (or the archaeology ruling before all of them) already resolved.
function findReturnedRuling(projectDir, domain) {
  const followUpRefs = gitOk(["for-each-ref", "--format=%(refname:short)", `refs/heads/proposal/ratify-${domain}-*`], projectDir)
    ? git(["for-each-ref", "--format=%(refname:short)", `refs/heads/proposal/ratify-${domain}-*`], projectDir).split("\n").filter(Boolean)
    : [];
  const re = new RegExp(`^proposal/ratify-${escapeRe(domain)}-(\\d+)$`);
  const followUpNumbers = followUpRefs.map((b) => re.exec(b)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => b - a);
  for (const n of followUpNumbers) {
    const name = followUpName(domain, n);
    const found = returnedRulingOn(projectDir, name, `proposal/${name}`);
    if (found) return { name, branch: `proposal/${name}`, ...found };
  }
  const archName = ratifyGateName(domain);
  const found = returnedRulingOn(projectDir, archName, `proposal/${archName}`);
  return found ? { name: archName, branch: `proposal/${archName}`, ...found } : null;
}

// `archaeology --revise`'s own pre-check: is there a returned ruling to revise from at
// all? Reported here rather than left for the agent turn to discover. Finding the ruling
// and stashing its rationale on `ctx.revision` happens in every mode, since a dry run's
// printed prompt needs the same rationale a real run's does; recording it onto `main` and
// deleting the spent branch (`recordReturnOnMain`) happens only on a real run — `ctx`
// carries `dryRun` (set by `runStage` before `preChecks` is called) for exactly this,
// so a dry run leaves the branch and `main` exactly as it found them.
function checkRevisionSource(projectDir, ctx) {
  const id = "archaeology-revise-source";
  if (!ctx.revise || !ctx.domain) return { id, ok: true, messages: [] };
  const found = findReturnedRuling(projectDir, ctx.domain);
  if (!found) {
    const requested = requestedRevision(projectDir, "archaeology");
    if (!requested) return { id, ok: false, messages: [`archaeology --revise: no returned ruling for ${ctx.domain} to revise from`] };
    ctx.revision = requested;
    return { id, ok: true, messages: [] };
  }
  ctx.revision = withOpenRequests(projectDir, "archaeology", found);
  if (!ctx.dryRun) recordReturnOnMain(projectDir, found, { gate: "G1" });
  return { id, ok: true, messages: [] };
}

// The page of the follow-up proposal: every criterion still short of the contract, with
// everything the persona needs to rule on it without opening the domain file, and the
// grammar its answer has to be written in.
function followUpPage(domain, unresolved, answered, unparsed) {
  const lines = [
    `${unresolved.length} criterion(s) in the **${domain}** domain are still \`inferred\` or \`open\`, so`,
    "`ratify` has not minted a permanent id for them and no later stage can build against them.",
    "Rule on each one below. `contract` and `spike` record a decision without ever raising a",
    "criterion's confidence, so neither one closes it out — a criterion left short of the contract",
    "through two follow-ups this way is marked `obsolete` by `ratify` itself, noted",
    "\"unresolved after two rulings\", rather than being asked about forever.",
    "",
  ];
  if (unparsed.length) {
    lines.push("An earlier ruling on this domain carries condition lines the ratification grammar cannot",
      "read. They are listed here so they can be restated in the grammar below; until they are, `ratify`",
      "refuses to act on that ruling at all.",
      "");
    for (const u of unparsed) lines.push(`- ${u}`);
    lines.push("");
  }
  for (const c of unresolved) {
    lines.push(`### ${c.id} · v${c.version} · ${c.confidence} · ${c.origin}`, "", c.statement, "");
    if (c.reconciliation) lines.push(`- reconciliation: ${c.reconciliation}`);
    if (c.given) lines.push(`- given: ${c.given}`);
    if (c.when) lines.push(`- when: ${c.when}`);
    if (c.then) lines.push(`- then: ${c.then}`);
    for (const cite of c.cites ?? []) lines.push(`- cites: ${cite.line !== undefined ? `${cite.path}:${cite.line}` : cite.path}`);
    for (const note of c.notes ?? []) lines.push(`- note: ${note}`);
    if (answered.has(c.id)) {
      lines.push("", "**This criterion has already been answered once, with `contract` or `spike`.** Neither one",
        "moves it toward the contract, so answering the same way again would leave it exactly where it",
        "is: already answered once: confirm, edit, obsolete or defect it.");
    }
    lines.push("");
  }
  lines.push("## Ratification conditions", "", CONDITION_GRAMMAR, "");
  return lines.join("\n");
}

// `ratify` mints permanent IDs only for a domain a human (or the persona bound to G1)
// has actually approved, and only once that approval has landed on `main` — a `return`
// or an `escalate` gate file exists too, and neither is safe to ratify from. Checked two
// ways, matching how the ruling actually gets there: an ordinary approve+merge leaves the
// proposal branch reachable from `main` (`git branch --merged main`), while `main` itself
// already holding the gate file at `HEAD` (the common case, since `sdlc rule` checks
// `main` out right after merging) covers a history rewritten since.
function checkArchaeologyApproved(projectDir, domain) {
  const id = "archaeology-approved";
  // A missing `--domain` is `checkDomainOption`'s message to give, not this one's —
  // reported here as passing so the two checks do not print the same complaint twice.
  if (!domain) return { id, ok: true, messages: [] };
  const name = ratifyGateName(domain);
  const gatePath = ratifyGatePath(projectDir, domain);
  if (!existsSync(gatePath)) return { id, ok: false, messages: [`.sdlc/gates/${name}.yaml is missing; rule ${name} approve first`] };
  const gate = parseYaml(readText(gatePath)) ?? {};
  if (gate.verdict !== "approve") return { id, ok: false, messages: [`${name} was not approved (verdict: ${gate.verdict ?? "unknown"})`] };
  const branch = `proposal/${name}`;
  const merged = gitOk(["branch", "--merged", "main"], projectDir)
    && git(["branch", "--merged", "main"], projectDir).split("\n").map((l) => l.replace(/^\*?\s*/, "").trim()).includes(branch);
  const reachable = gitOk(["cat-file", "-e", `HEAD:.sdlc/gates/${name}.yaml`], projectDir);
  if (!merged && !reachable) return { id, ok: false, messages: [`${branch} is approved but not merged into main yet`] };
  return { id, ok: true, messages: [] };
}

// A ruling ratify is about to execute must be one it can read in full. A condition line
// the grammar could not parse — kept on the gate file under `unparsed_conditions` after
// the persona was already asked to restate it once — is a ruling on some criterion that
// would silently do nothing, so the run fails naming the lines and the gate file they are
// on, for a person to correct in place.
function checkNoUnparsedConditions(projectDir, domain) {
  const id = "gate-conditions-parse";
  if (!domain) return { id, ok: true, messages: [] };
  const { unparsed } = readRulings(projectDir, domain);
  if (!unparsed.length) return { id, ok: true, messages: [] };
  return {
    id,
    ok: false,
    messages: [
      `${unparsed.length} condition line(s) on the ruling(s) for "${domain}" do not match the ratification grammar and were not applied. Rewrite them in the gate file(s) (see docs/stages/rule.md, "Ratification conditions") and run ratify again:`,
      ...unparsed.map((u) => `  ${u}`),
    ],
  };
}

// `spec/criteria-index.json` and `spec/spec.md` are ratify's own generated artifacts
// (`spec/README.md`: "Do not edit either by hand"); this post-check is the promise that
// a successful ratify run actually leaves both behind, parsing.
function checkSpecArtifacts(projectDir) {
  const id = "spec-artifacts";
  const messages = [];
  const idxPath = join(projectDir, "spec", "criteria-index.json");
  if (!existsSync(idxPath)) messages.push("spec/criteria-index.json is missing");
  else { try { JSON.parse(readText(idxPath)); } catch (e) { messages.push(`spec/criteria-index.json does not parse: ${e.message}`); } }
  if (!existsSync(join(projectDir, "spec", "spec.md"))) messages.push("spec/spec.md is missing");
  return { id, ok: messages.length === 0, messages };
}

// The highest `n` already minted as `R-<domainOrdinal>.<n>` anywhere in the project —
// `mintIds`' `existingMax`, so a second ratify run on a domain archaeology revisited
// continues numbering rather than colliding with what an earlier run already minted.
// Scoped to the whole project (every domain's criteria), not just the domain being
// ratified: an id's ordinal is a *position* in `config.project.domains`, and a project
// whose domain list gets reordered after some ids were already minted can leave an
// `R-<k>.<n>` sitting in a domain file other than the one that now owns ordinal `k`.
// Scanning every domain for that ordinal, rather than trusting the current domain's own
// file to hold its own history, is what keeps a freshly minted id from colliding with
// one already claimed under the same ordinal elsewhere.
function maxRNumber(allDomains, domainOrdinal) {
  const re = new RegExp(`^R-${domainOrdinal}\\.(\\d+)$`);
  let max = 0;
  for (const criteria of Object.values(allDomains)) {
    for (const c of criteria) {
      const m = re.exec(c.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max;
}

// `ratify` holds no gate and spawns no agent (`agent: false` — see `runStage`): the
// product owner already ruled at G1, on the archaeology proposal itself, and what is left
// is mechanical — apply the conditions that ruling attached, mint permanent IDs for
// whatever it confirmed, and regenerate the two files every other stage reads instead of
// a domain file. `execute` is called directly by `runStage` in place of an agent turn; its
// return shape (`{ text, changed }`) stands in for an agent result the same way
// `runStage` synthesises one (`cost: 0, turns: 0, sessionId: "deterministic"`).
const ratify = {
  name: "ratify",
  // `finishStage` resolves a function `title` by calling it with `ctx` — the domain name
  // is folded into the no-gate commit subject (`stage(ratify): <title>`) this way, rather
  // than by `execute` mutating the shared, single `ratify` object's own `title` field
  // (unsafe if the runner ever executes stages concurrently within one process, and a
  // stale value on any run that reads `stage.title` before `execute` is called for the
  // first time).
  title: (ctx) => (ctx?.domain ? `ratify ${ctx.domain}` : "ratify"),
  workspace: "project",
  gate: null,
  agent: false,
  collect: [],
  implemented: true,
  execute(projectDir, ctx) {
    const domain = ctx.domain;

    // Every approved ruling on this domain, in order: the archaeology proposal, then each
    // follow-up the closing loop opened and the persona ruled, then whichever
    // `contract-v<n>` gate(s) carried a condition naming one of this domain's own ids. A
    // later ruling's condition on the same criterion is applied after an earlier one's,
    // so closing a criterion out is exactly a matter of ruling on it again.
    const { conditions, read, contractRead } = readRulings(projectDir, domain);

    const domainFile = join(projectDir, "spec", "domains", `${domain}.md`);
    const originalText = readText(domainFile);

    const domains = ctx.config?.project?.domains ?? [];
    const domainOrdinal = domains.indexOf(domain) + 1;

    // Read before this pass writes anything: `maxRNumber` needs every OTHER domain's
    // own already-minted ids under this ordinal, not just this domain's.
    const { domains: allDomains } = parseAll(projectDir);
    const existingMax = maxRNumber(allDomains, domainOrdinal);

    // Read before the conditions are applied: a `recovery-wrong` condition needs to know
    // whether the request it names has already been filed and already answered, which is
    // the only thing that stops a ruling — read again on every pass, since a gate file is
    // never consumed — from undoing the recovery that answered it.
    const recoveryEntries = readRecoveryFor(projectDir, domain);

    const { criteria: before, preamble } = parseDomainFile(originalText, domain, domainOrdinal);
    const { criteria: withConditions, applied, unknown } = applyConditions(before, conditions, recoveryEntries);

    // The closing loop's bound: `contract` and `spike` are the two verbs that answer a
    // follow-up without ever raising a criterion's confidence (see `readRulings`'s own
    // comment on `answered`) — `confirm`, `edit` and `defect` all resolve a criterion
    // (`applyConditions` sets confidence to `confirmed` for all three), so any of those
    // takes a criterion out of `inferred`/`open` before this sweep ever runs. A persona
    // that keeps choosing `contract` or `spike` — or simply says nothing, which the
    // grammar treats the same as `contract` — would otherwise never close the loop out.
    // Once a still-unresolved criterion has been through two follow-up rulings with
    // nothing resolving it, `ratify` decides for it: `obsolete`, with the reason on the
    // row itself, so the next `followUp` call finds nothing left to ask about and the
    // loop actually terminates. Guarded to `D-` ids only: an `R-` criterion was minted
    // because a prior pass already confirmed it, so it can never legitimately be the
    // target of this sweep — the only way one could carry `inferred`/`open` confidence
    // at all is a stray `spike` condition naming an already-minted id, and that must not
    // force-obsolete a permanent criterion the contract already depends on.
    // Criteria out for re-recovery are out of the closing loop entirely while they are
    // out: the question they are waiting on is one for `archaeology` and the evidence in
    // the old application, not one the product owner can answer by ruling again. They are
    // therefore neither asked about on a follow-up (`followUp`, below) nor counted toward
    // the loop's own bound, which would otherwise force-obsolete a row whose correction
    // is still being recovered. Two sets, and only two: the requests on file that the
    // criteria still match, and the ones this pass's own conditions are filing now. A
    // criterion whose re-recovery has come back is in neither — its entry is stamped
    // answered, and `applyConditions` files no request for one it can see has been answered
    // — so the exemption lifts when the work comes back, and only then. A row some other
    // verb changed while it was out is still out.
    const outForRecovery = new Set([
      ...outstandingRecoveries(recoveryEntries, withConditions).map((e) => e.id),
      ...withConditions.filter((c) => c.recoveryRequests?.length).map((c) => c.id),
    ]);

    // And a criterion cannot be promoted while it is out. `edit` and `confirm` both raise
    // confidence to `confirmed`, which is what makes a row eligible to mint — so a ruling
    // that reworded a row somebody else had already sent back would put a criterion whose
    // evidence is known to be wrong into the permanent contract. The wording change stands;
    // the promotion waits for the recovery, which is the only thing that can settle whether
    // there is anything here to promote. Provisional rows only: an `R-` row is already
    // minted, and taking a permanent criterion out of the contract is `obsolete`'s ruling.
    for (const c of withConditions) {
      if (outForRecovery.has(c.id) && c.id.startsWith("D-") && c.confidence === "confirmed") c.confidence = "open";
    }

    if (followUpRulingsRead(read, domain) >= 2) {
      for (const c of withConditions) {
        if (outForRecovery.has(c.id)) continue;
        if (c.id.startsWith("D-") && (c.confidence === "inferred" || c.confidence === "open") && c.state !== "obsolete") {
          c.state = "obsolete";
          if (!c.notes.includes("unresolved after two rulings")) c.notes.push("unresolved after two rulings");
        }
      }
    }

    const minted = mintIds(withConditions, domainOrdinal, existingMax);

    // Filed after minting rather than while the condition is applied, so each entry names
    // the id and version the criterion actually ends up with in the file. One entry per
    // reason: a ruling that names a criterion twice is two requests, each owed its own
    // answer. `addRecovery` files nothing when the same criterion already carries the same
    // request, which is what makes replaying a ruling that already sent a row back a no-op
    // rather than a second request.
    const recoveryPath = addRecovery(projectDir, minted.flatMap((c) =>
      (c.recoveryRequests ?? []).map((why) => ({ id: c.id, domain, version: c.version, why }))));

    // The preamble the file arrived with is written straight back: everything above the
    // first criterion block is a person's or an agent's own text, and nothing in this
    // pass has any business rewriting it.
    const serialised = serialiseDomainFile(minted, domain, preamble);

    // Every verb `applyConditions` applies is idempotent against a row it already
    // changed (see that function's own comment), so replaying the same gate-file
    // conditions against an unchanged domain file reproduces the same text byte for
    // byte. That real comparison — not "does any `D-` id happen to remain" — decides
    // whether this run is a no-op: a domain can carry a `D-` id forever (a `spike`d or
    // still-`inferred` criterion that never gets confirmed) without that meaning a rerun
    // has fresh work to do.
    const domainChanged = serialised !== originalText;
    if (domainChanged) writeText(domainFile, serialised);

    // Regenerated on every run, whether the domain file changed or not. Both are derived
    // from *every* domain file in the project, so they go stale for reasons this run has
    // nothing to do with — another domain ratified since, a hand edit, an index that was
    // never written — and a run that stopped as soon as it found its own domain settled
    // would leave them that way, with `checkCriteria`'s stale-index failure the next
    // thing anyone hears about it.
    const parsed = parseAll(projectDir);
    writeIndex(projectDir, parsed);
    renderSpecIndex(projectDir, parsed);

    if (!domainChanged && !recoveryPath) {
      return { text: `ratify ${domain}: nothing to do — already ratified`, changed: [] };
    }

    const accepted = minted.filter((c) => c.state === "accepted");
    // Read back from the file `addRecovery` has just written, against the criteria as
    // minted, so this is every request the domain is carrying — the ones filed on this
    // pass and any an earlier one filed that archaeology has not answered yet.
    const entriesNow = readRecoveryFor(projectDir, domain);
    const awaitingRecovery = outstandingRecoveries(entriesNow, minted);
    const awaitingIds = new Set(awaitingRecovery.map((e) => e.id));
    const stillOpen = minted.filter((c) => c.id.startsWith("D-") && (c.confidence === "inferred" || c.confidence === "open") && c.state !== "obsolete" && !awaitingIds.has(c.id));
    const obsolete = minted.filter((c) => c.state === "obsolete");
    const replacementsAdded = applied.filter((a) => a.verb === "defect").length;

    const lines = [`ratify ${domain}: ${accepted.length} accepted, ${stillOpen.length} still open, ${obsolete.length} obsolete, ${replacementsAdded} replacement(s) added${awaitingRecovery.length ? `, ${awaitingRecovery.length} out for re-recovery` : ""}.`];
    if (contractRead.length) lines.push(`Conditions from: ${contractRead.join(", ")}.`);
    if (awaitingRecovery.length) {
      lines.push(`Out for re-recovery — run \`sdlc run archaeology --domain ${domain}\` to recover these again:`);
      for (const e of awaitingRecovery) {
        const n = recoveryRequestCount(entriesNow, e.id);
        lines.push(`- ${e.id}${n > 1 ? ` (sent back ${n} times)` : ""} — ${e.why}`);
      }
    }
    if (stillOpen.length) {
      lines.push("Still open:");
      for (const c of stillOpen) lines.push(`- ${c.id} (${c.confidence})${c.notes?.length ? ` — ${c.notes[0]}` : ""}`);
    }
    if (obsolete.length) {
      lines.push("Obsolete:");
      for (const c of obsolete) lines.push(`- ${c.id}${c.notes?.length ? ` — ${c.notes[c.notes.length - 1]}` : ""}`);
    }
    if (unknown.length) {
      lines.push("Unknown conditions (reported, not applied):");
      for (const u of unknown) lines.push(`- ${u}`);
    }

    const changed = [`spec/domains/${domain}.md`, "spec/criteria-index.json", "spec/spec.md"];
    if (recoveryPath) changed.push(recoveryPath);
    return { text: lines.join("\n"), changed };
  },
  proposal() {
    return null;
  },
  preChecks(projectDir, ctx) {
    return [
      checkDomainOption(ctx, "ratify"),
      checkArchaeologyApproved(projectDir, ctx.domain),
      checkNoUnparsedConditions(projectDir, ctx.domain),
      checkDomainFileParses(projectDir, ctx.domain, "ratify-domain-file"),
    ];
  },
  postChecks(projectDir, ctx) {
    return [checkCriteria(projectDir, ctx), checkCriteriaIndex(projectDir), checkSpecArtifacts(projectDir)];
  },
  // The closing loop. `ratify` mints only what the ruling actually confirmed, so a
  // domain routinely comes out of it with criteria still `inferred` or `open` — and
  // nothing, before this, ever asked about them again: they sat in the domain file
  // indefinitely, invisible to every later stage, and closing them out depended on
  // somebody noticing.
  //
  // Run after the ratify commit has landed on `main`, so the proposal it opens branches
  // off a `main` that already holds this pass's work. It asks the G1 persona one question
  // — which of these become the contract — and its answer arrives as another approved
  // gate file, which the next `sdlc run ratify --domain <d>` reads alongside the
  // archaeology ruling. Each pass therefore either resolves criteria or asks again about
  // fewer of them.
  //
  // At most one follow-up is open at a time: while `ratify-<d>-<n>` is unruled it is the
  // thing being waited on, and opening a second one alongside it would ask the same
  // question twice.
  followUp(projectDir, ctx) {
    const domain = ctx.domain;
    if (!domain) return null;
    const file = join(projectDir, "spec", "domains", `${domain}.md`);
    if (!existsSync(file)) return null;

    const { criteria } = parseDomainFile(readText(file), domain);
    // `obsolete` is a decision, not an open question: a row the ruling deliberately did
    // not carry forward keeps whatever confidence it was recovered with, and asking about
    // it again every pass would make the loop never close.
    // A criterion out for re-recovery is not an open question for this persona: it is
    // waiting on `archaeology` reading the old application again, and asking about it on a
    // follow-up would ask for a ruling on evidence that is known to be wrong. The rest of
    // the domain closes out around it.
    const awaiting = new Set(outstandingRecoveries(readRecoveryFor(projectDir, domain), criteria).map((e) => e.id));
    const unresolved = criteria.filter((c) => (c.confidence === "inferred" || c.confidence === "open") && c.state !== "obsolete" && !awaiting.has(c.id));
    const { answered, unparsed } = readRulings(projectDir, domain);
    if (unresolved.length === 0 && unparsed.length === 0) return null;

    const { open, highest } = followUpState(projectDir, `ratify-${domain}`);
    if (open) return null;

    const name = followUpName(domain, highest + 1);
    const { branch } = propose(projectDir, name, {
      gate: "G1",
      question: `Which of the ${domain} criteria that are still inferred or open become the contract?`,
      recommendation: `${unresolved.length} criterion(s) in ${domain} are still short of the contract; rule on each with a ratification condition so the next ratify pass can mint them.`,
      page: followUpPage(domain, unresolved, answered, unparsed),
    });
    return { name, gate: "G1", branch, unresolved: unresolved.length };
  },
};

// Every real pipeline stage (deploy, operate, …) is a stub until its own task
// lands: calling `prompt` fails loudly and by name, so `sdlc run <stage>` reports a clear
// reason instead of quietly doing nothing.
function stub(name) {
  return {
    name,
    title: name,
    skill: skillPath(name),
    workspace: "project",
    gate: null,
    collect: [],
    implemented: false,
    prompt() {
      throw new Error(`stage ${name} is not implemented yet`);
    },
    proposal() {
      return null;
    },
    preChecks() {
      return [];
    },
    postChecks() {
      return [];
    },
  };
}

export const STAGES_BY_NAME = Object.fromEntries(STAGES.map((name) => [name, stub(name)]));
STAGES_BY_NAME.probe = probe;
STAGES_BY_NAME.intent = intent;
STAGES_BY_NAME.archaeology = archaeology;
STAGES_BY_NAME.ratify = ratify;
STAGES_BY_NAME.contract = contract;
STAGES_BY_NAME["derive-tests"] = deriveTests;
STAGES_BY_NAME["bind-adapter"] = bindAdapter;
// `design` draws the screens the criteria describe, one domain at a time, and is the only
// stage that fills in the contract's test IDs. It holds gate G-DESIGN, ruled by the UX
// reviewer persona: the question is whether the catalogue covers the surface, is built out
// of the design system rather than beside it, and says honestly where a criterion did not
// settle what a screen should do.
//
// Its workspace carries no application and no acceptance suite. No application because a
// screen designed from a running one is a screen copied rather than designed; no suite
// because a design that can read the assertions waiting for it is a design drawn to satisfy
// them rather than to serve the behaviour.
// The proposal names a `design --revise` run may revise from, newest first — the same shape
// `bind-adapter` and `derive-tests` use, and for the same reason: a returned design is a page
// of specific conditions, and redrawing fourteen screens from nothing to meet three of them
// throws away the eleven that were right.
function designRevisionCandidates(projectDir, domain) {
  const pattern = `refs/heads/proposal/design-${domain}-*`;
  const refs = gitOk(["for-each-ref", "--format=%(refname:short)", pattern], projectDir)
    ? git(["for-each-ref", "--format=%(refname:short)", pattern], projectDir).split("\n").filter(Boolean)
    : [];
  const re = new RegExp(`^proposal/design-${escapeRe(domain)}-(\\d+)$`);
  const numbers = refs.map((b) => re.exec(b)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => b - a);
  return [...numbers.map((n) => `design-${domain}-${n}`), `design-${domain}`];
}

function findReturnedDesignRuling(projectDir, domain) {
  for (const name of designRevisionCandidates(projectDir, domain)) {
    const found = returnedRulingOn(projectDir, name, `proposal/${name}`);
    if (found) return { name, branch: `proposal/${name}`, ...found };
  }
  return null;
}

function checkDesignRevisionSource(projectDir, ctx, maySpend = true) {
  const id = "design-revise-source";
  if (!ctx.revise || !ctx.domain) return { id, ok: true, messages: [] };
  const spend = maySpend && !ctx.dryRun;
  const found = findReturnedDesignRuling(projectDir, ctx.domain);
  if (!found) {
    const requested = requestedRevision(projectDir, "design");
    if (!requested) return { id, ok: false, messages: [`design --revise: no returned ruling for ${ctx.domain} to revise from`] };
    ctx.revision = requested;
    return { id, ok: true, messages: [] };
  }
  const branchCommit = git(["rev-parse", found.branch], projectDir);
  ctx.revision = withOpenRequests(projectDir, "design", { ...found, branchCommit });
  if (spend) recordReturnOnMain(projectDir, found, { gate: "G-DESIGN", keepBranch: true });
  return { id, ok: true, messages: [] };
}

// What a revising run is told on top of the ordinary task. The screens it is correcting are
// already in the workspace, overlaid from the returned branch, so the instruction is to
// change what the conditions name and leave the rest.
function designRevisionInstructions(ctx) {
  const conditions = revisionConditionList(ctx);
  return [
    `This is a revision. The screens you are correcting are already under design/ — open them and change only what the conditions below name. Do not redraw a screen nobody asked about.`,
    revisionRulingBlock(ctx),
    conditions ? `The conditions it must now meet:\n\n${conditions}` : "",
    addressedElsewhereNote(ctx),
    `A condition addressed to a person rather than a stage — the runner, the tech lead — is not yours to carry out either. Say in your journal which ones you left, and to whom.`,
  ].filter(Boolean).join("\n\n");
}

const design = {
  name: "design",
  title: (ctx) => `design ${ctx.domain}`,
  skill: skillPath("design"),
  workspace: "design",
  gate: "G-DESIGN",
  // The stem this stage's proposals are named from. It is what lets a ruling being written
  // at a gate find the stage its conditions will reach, so a condition naming a path this
  // stage cannot deliver is refused while the ruler is still there to re-address it.
  proposalPrefix: "design-",
  collect: ["design", "spec/contract/surface.yaml"],
  // A design run writes one story per page per state — ninety-odd files for a domain of
  // fourteen pages — and a session's default ceiling ends it a third of the way through,
  // having written nothing it can hand over. A project's `policy.budgets.design` still
  // overrides this, as for any stage.
  defaultTurns: 250,
  // On a `--revise` run the returned branch's own design work is overlaid into the
  // workspace, so a correction starts from the screens that were drawn rather than from an
  // empty directory.
  revisionOverlayPaths: () => ["design", "spec/contract/surface.yaml"],
  implemented: true,
  allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
  prompt(ctx) {
    const d = ctx.domain;
    const pages = ctx.designPages ?? [];
    const list = pages.length
      ? pages.map((p) => `  - ${p}`).join("\n")
      : "  (the surface names no page for this domain; say so in your journal and write nothing)";
    return [
      `Design the screens of the ${d} domain. The pages spec/contract/surface.yaml gives this domain are:\n\n${list}`,
      `Read spec/domains/${d}.md for what these screens have to support, and spec/contract/surface.yaml for what each one offers. Write design/DESIGN.md, design/screens.yaml and one story per page per state under design/catalogue/, and fill in the test_id of every action and observation on these pages.`,
      `Other domains have written in design/DESIGN.md and design/screens.yaml before you. Add to both; never replace what is there.`,
      ctx.revise ? designRevisionInstructions(ctx) : null,
    ].filter(Boolean).join("\n\n");
  },
  proposal(ctx) {
    const d = ctx.domain;
    return {
      name: ctx.designName ?? nextProposalName(ctx.projectDir, `design-${d}`),
      question: `Do these screens serve the ${d} criteria, and are they built out of the design system?`,
      recommendation: recommendationFrom(ctx.agentText),
    };
  },
  preChecks(projectDir, ctx) {
    const domainCheck = checkDomainOption(ctx, "design");
    if (ctx.domain) ctx.designPages = pagesForDomain(projectDir, ctx.domain);
    const before = [
      domainCheck,
      checkDesignDomainRatified(projectDir, ctx),
      checkDesignSurfaceExists(projectDir, ctx),
    ];
    // The revision source reports whatever the checks above found and only spends a
    // return or a request when they passed, for the reason `plan`'s own `preChecks` gives.
    return [...before, checkDesignRevisionSource(projectDir, ctx, before.every((c) => c.ok))];
  },
  postChecks(projectDir, ctx) {
    // `design/screens.yaml` is the declaration and the catalogue answers to it, so a story
    // whose page and state nobody declares any more is stale by definition. A revision that
    // narrows a screen's states leaves exactly that behind, and cannot clear it up: the
    // writer's tools read, write and edit files and none of them removes one. Cleared here,
    // the same way a derivation's own not-testable decision is carried out for it.
    ctx.designRemoved = removeUndeclaredStories(projectDir);
    ctx.designName = nextProposalName(projectDir, `design-${ctx.domain}`);
    // Stale stories are cleared first: the scan compiles whatever is in the catalogue, and
    // a story nobody declares any more would be compiled, scanned, and reported against a
    // gate that is not about it.
    runCatalogueScan(projectDir);
    return [
      checkDesignCatalogue(projectDir, ctx.domain),
      checkDesignNoLiteralColours(projectDir),
      checkDesignSurfaceScope(projectDir),
      checkDesignHarnessUntouched(projectDir),
      checkDesignCompiles(projectDir),
      checkDesignAccessibility(projectDir),
    ];
  },
};

// The pages one domain owns, read from the surface's own `domain` field — the same field
// archaeology writes when it appends a page, so a design run covers exactly what its
// domain put there and never another domain's screens.
// Stories the declaration no longer names. Read from `design/screens.yaml` rather than from
// this run's diff, because the declaration is what the catalogue answers to whoever wrote it
// — and a story for a state nobody declares is not reviewable: the reviewer reads the
// declaration and expects the catalogue to match it.
export function removeUndeclaredStories(projectDir) {
  const dir = join(projectDir, "design", "catalogue");
  if (!existsSync(dir)) return [];
  let declared;
  try {
    const doc = parseYaml(readText(join(projectDir, "design", "screens.yaml")));
    declared = new Set((Array.isArray(doc?.screens) ? doc.screens : [])
      .flatMap((s) => (Array.isArray(s?.states) ? s.states : []).map((state) => `${s.page}.${state}`)));
  } catch {
    return [];
  }
  if (declared.size === 0) return [];
  const removed = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".stories.tsx")) continue;
    if (declared.has(f.slice(0, -".stories.tsx".length))) continue;
    rmSync(join(dir, f));
    removed.push(`design/catalogue/${f}`);
  }
  return removed;
}

function pagesForDomain(projectDir, domain) {
  const path = join(projectDir, "spec", "contract", "surface.yaml");
  if (!existsSync(path)) return [];
  let doc;
  try { doc = parseYaml(readText(path)); } catch { return []; }
  const pages = Array.isArray(doc?.pages) ? doc.pages : [];
  return pages.filter((p) => p?.domain === domain && p?.id).map((p) => `${p.id} — ${p.route ?? "(no route)"}`);
}

function checkDesignDomainRatified(projectDir, ctx) {
  const id = "design-domain-ratified";
  if (!ctx.domain) return { id, ok: true, messages: [] };
  const { criteria } = acceptedCriteria(projectDir, ctx.domain);
  if (criteria.length === 0)
    return { id, ok: false, messages: [`design: domain ${ctx.domain} has no accepted criteria; run ratify first`] };
  return { id, ok: true, messages: [] };
}

// A design run with no surface to design against would write a catalogue nothing can be
// checked against and no test IDs at all, and its post-checks would pass for want of
// anything to compare. Refused up front instead, naming the stage that produces one.
function checkDesignSurfaceExists(projectDir, ctx) {
  const id = "design-surface-exists";
  if (!ctx.domain) return { id, ok: true, messages: [] };
  if (surfacePageIds(projectDir, ctx.domain).length === 0)
    return { id, ok: false, messages: [`design: spec/contract/surface.yaml names no page in the ${ctx.domain} domain; run contract first`] };
  return { id, ok: true, messages: [] };
}

// `plan` cuts the build into vertical slices and says how that plan meets the constitution.
// It holds gate G2, ruled by the architect persona: whether a slice is really a slice —
// something that can be built, run and shown on its own — is a judgement no check can make,
// and it is the whole question at that gate.
//
// Unlike every stage before it, this one is not per-domain. A slice crosses domains by
// definition: a vendor finding and reading an opportunity is opportunities and content and
// users at once, and a plan cut one domain at a time would produce layers wearing a slice's
// name.
const plan = {
  name: "plan",
  title: "plan",
  skill: skillPath("plan"),
  workspace: "plan",
  gate: "G2",
  // The stem this stage's proposals are named from. It is what lets a ruling being written
  // at a gate find the stage its conditions will reach, so a condition naming a path this
  // stage cannot deliver is refused while the ruler is still there to re-address it.
  proposalPrefix: "plan",
  collect: ["plan", "docs/decisions"],
  // The planner reads every accepted criterion and the whole design before it cuts a
  // slice, which alone outruns the default ceiling on a project of any size.
  defaultTurns: 150,
  // A revision starts from the plan the architect returned, not from nothing: the conditions
  // name what to change in it, and a replanned cut would move everything the ruling accepted.
  revisionOverlayPaths: () => ["plan", "docs/decisions"],
  implemented: true,
  allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
  prompt(ctx) {
    const n = ctx.planCriteriaCount ?? 0;
    return [
      `Cut the build of this system into vertical slices. There are ${n} accepted criteria to place, across the domains spec/criteria-index.json names, and every one of them belongs to exactly one slice.`,
      `Write plan/plan.md — including its "## Constitution check" section — and plan/tasks.md with the slices in build order. Write a decision record under docs/decisions/ for any choice a later reader would otherwise have to reverse-engineer.`,
      ctx.revise ? planRevisionInstructions(ctx) : null,
    ].filter(Boolean).join("\n\n");
  },
  proposal(ctx) {
    return {
      name: ctx.planName ?? nextProposalName(ctx.projectDir, "plan"),
      question: "Is this the right cut of the work, and does each slice stand on its own?",
      recommendation: recommendationFrom(ctx.agentText),
    };
  },
  preChecks(projectDir, ctx) {
    const ids = allAcceptedCriterionIds(projectDir);
    ctx.planCriteriaCount = ids.length;
    ctx.planAcceptedIds = ids;
    const before = [checkPlanHasCriteria(ids), checkPlanHasDesign(projectDir)];
    // The revision source is the one check here that writes: it records a return onto
    // `main`, or takes up a request addressed to this stage, and either is spent once it
    // has happened. It still reports, whatever the checks above found — a run is entitled
    // to be told everything that is wrong with it in one pass — but it only spends
    // anything when they passed, so a project with nothing to plan against does not lose
    // the ruling it would have revised from to a run that was never going to happen.
    return [...before, checkPlanRevisionSource(projectDir, ctx, before.every((c) => c.ok))];
  },
  postChecks(projectDir, ctx) {
    ctx.planName = nextProposalName(projectDir, "plan");
    const coverage = checkPlanCoverage(projectDir, ctx.planAcceptedIds ?? allAcceptedCriterionIds(projectDir));
    const shape = planShape(projectDir);
    return [
      checkPlanConstitution(projectDir),
      // A slice carrying most of the spec is not refused — only a person can say whether it
      // is really one piece of work — but it is put in front of the persona that can.
      { ...coverage, warnings: shape.warnings },
    ];
  },
};

// Every `plan` proposal branch under one prefix, newest numbering first.
function planBranches(projectDir, prefix) {
  const pattern = `refs/heads/${prefix}/plan*`;
  const refs = gitOk(["for-each-ref", "--format=%(refname:short)", pattern], projectDir)
    ? git(["for-each-ref", "--format=%(refname:short)", pattern], projectDir).split("\n").filter(Boolean)
    : [];
  return refs.map((b) => new RegExp(`^${prefix}/(plan(?:-(\\d+))?)$`).exec(b)).filter(Boolean)
    .sort((a, b) => Number(b[2] ?? 1) - Number(a[2] ?? 1)).map((m) => m[1]);
}

// The returned plan a `--revise` run starts from: the newest `proposal/plan` or
// `proposal/plan-<n>` whose ruling is a return not yet recorded on `main`.
function checkPlanRevisionSource(projectDir, ctx, maySpend = true) {
  const id = "plan-revise-source";
  if (!ctx.revise) return { id, ok: true, messages: [] };
  const spend = maySpend && !ctx.dryRun;
  const open = planBranches(projectDir, "proposal");
  for (const name of open) {
    const found = returnedRulingOn(projectDir, name, `proposal/${name}`);
    if (!found) continue;
    ctx.revision = withOpenRequests(projectDir, "plan", { name, branch: `proposal/${name}`, ...found, branchCommit: git(["rev-parse", `proposal/${name}`], projectDir) });
    if (spend) recordReturnOnMain(projectDir, ctx.revision, { gate: "G2", keepBranch: true });
    return { id, ok: true, messages: [] };
  }
  // A return already recorded on `main` has had its branch renamed to `returned/<name>`,
  // and its ruling is no longer a candidate above — by design, since the revision it was
  // recorded for is the one that spends it. A revision that never produced a proposal
  // (its agent turn failed, or the run was interrupted) leaves exactly that state behind
  // with nothing to try again from, so the recorded return is read back here. Only while
  // no proposal branch for the stem exists: once one does, it is the newer word on the
  // plan and this would revise something already superseded.
  if (!open.length) {
    for (const name of planBranches(projectDir, "returned")) {
      const gatePath = `.sdlc/gates/${name}.yaml`;
      if (!gitOk(["cat-file", "-e", `returned/${name}:${gatePath}`], projectDir)) continue;
      const gate = parseYaml(git(["show", `returned/${name}:${gatePath}`], projectDir)) ?? {};
      if (gate.verdict !== "return") continue;
      ctx.revision = withOpenRequests(projectDir, "plan", {
        name, branch: `returned/${name}`, rationale: gate.rationale ?? gate.note ?? "",
        ...splitRulingConditions(gate, name), branchCommit: git(["rev-parse", `returned/${name}`], projectDir),
      });
      return { id, ok: true, messages: [] };
    }
  }
  const requested = requestedRevision(projectDir, "plan");
  if (requested) { ctx.revision = requested; return { id, ok: true, messages: [] }; }
  return { id, ok: false, messages: ["plan --revise: no returned plan ruling to revise from"] };
}

function planRevisionInstructions(ctx) {
  const conditions = revisionConditionList(ctx);
  return [
    "This is a revision. The plan you are correcting is already under plan/ and docs/decisions/ — change what the conditions below name and keep every slice the ruling did not question.",
    revisionRulingBlock(ctx),
    conditions ? `The conditions it must now meet:\n\n${conditions}` : "",
    addressedElsewhereNote(ctx),
    "A condition addressed to a person rather than a stage — the runner, the tech lead — is not yours to carry out either. Say in your journal which ones you left, and to whom.",
  ].filter(Boolean).join("\n\n");
}

// Every accepted, non-superseded criterion in the project, across every domain. The plan is
// the one artefact answerable for all of them at once.
function allAcceptedCriterionIds(projectDir) {
  const idxPath = join(projectDir, "spec", "criteria-index.json");
  if (!existsSync(idxPath)) return [];
  let index;
  try { index = JSON.parse(readText(idxPath)); } catch { return []; }
  return (index.criteria ?? []).filter((c) => c.state === "accepted" && !c.supersededBy).map((c) => c.id);
}

function checkPlanHasCriteria(ids) {
  const id = "plan-has-criteria";
  if (ids.length === 0) return { id, ok: false, messages: ["plan: no accepted criteria to plan against; run ratify first"] };
  return { id, ok: true, messages: [] };
}

// A plan cut before the screens are drawn is a plan cut against guesses about them, and the
// slices are exactly what that would get wrong: how much of a screen one slice delivers is
// the thing the design settles.
function checkPlanHasDesign(projectDir) {
  const id = "plan-has-design";
  if (!existsSync(join(projectDir, "design", "screens.yaml")))
    return { id, ok: false, messages: ["plan: design/screens.yaml is missing; run design first"] };
  return { id, ok: true, messages: [] };
}

STAGES_BY_NAME.calibrate = calibrate;
STAGES_BY_NAME.plan = plan;
STAGES_BY_NAME.design = design;
STAGES_BY_NAME.build = build;
STAGES_BY_NAME.verify = verify;

// The stages a condition may be addressed to: the ones that can be asked to produce their
// artifact again. A stage declares that by having somewhere for a revision to start from
// (`revisionOverlayPaths`), which is the same property `--revise` itself turns on, so the
// set is read off the registry rather than listed a second time — a stage that gains a
// revision mode becomes addressable with it, and one that has none can never be asked for
// work it has no way to do.
export function revisableStages() {
  return Object.entries(STAGES_BY_NAME).filter(([, stage]) => stage?.revisionOverlayPaths).map(([name]) => name).sort();
}

// What a stage delivers, for a full run of it. `collect` may be narrowed per run, and the
// question these three answer — which stage can be asked for a path at all — is about the
// stage rather than about one run of it.
function collectOf(stage) {
  try {
    return typeof stage?.collect === "function" ? stage.collect({}) : (stage?.collect ?? []);
  } catch {
    return [];
  }
}

// Whether this pipeline has any say over a path. The union of every path any stage reads or
// writes, so a condition naming something in the project that no stage of this pipeline
// produces — a file the team maintains by hand — is left where it is rather than refused.
export function pipelineOwns(path) {
  const owned = [];
  for (const stage of Object.values(STAGES_BY_NAME)) {
    const mode = typeof stage?.workspace === "function" ? null : stage?.workspace;
    if (mode && MODES[mode]) owned.push(...MODES[mode]);
    owned.push(...collectOf(stage));
  }
  return coveredBy(owned, path);
}

// What one stage delivers, by name — the same list `deliverableBy` matches paths against,
// and what a ruler is shown before a condition is written.
export function deliveredBy(stage) {
  return collectOf(STAGES_BY_NAME[stage]);
}

// Every stage that could deliver a path, sorted, read off the registry rather than listed a
// second time: a stage that gains or loses a collect path changes this answer with it.
export function deliverableBy(path) {
  return Object.entries(STAGES_BY_NAME)
    .filter(([, stage]) => stage?.implemented && coveredBy(collectOf(stage), path))
    .map(([name]) => name).sort();
}

// The stage a returned proposal's conditions will reach. A stage declares the stem its
// proposals are named from (`proposalPrefix`); the longest one that matches wins, so a
// family whose names begin with another's is still read as its own. A proposal belonging to
// no revisable stage answers `null` — its conditions are read in a closed grammar, or its
// return is taken up by a person rather than by a `--revise` run, and neither is this
// function's business.
export function stageForProposal(name) {
  let best = null;
  for (const [stage, def] of Object.entries(STAGES_BY_NAME)) {
    const prefix = def?.proposalPrefix;
    if (!prefix || !String(name).startsWith(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { stage, prefix };
  }
  return best?.stage ?? null;
}

// The line of work a proposal belongs to: every proposal that is a revision of the same
// artifact, and no other. A stage's proposals are named `<prefix><subject>` the first time
// and `<prefix><subject>-<n>` after that (`nextProposalName`), so the family is the name
// with that trailing number taken off.
//
// The number is stripped from the part after the stage's own prefix, and only where that
// part still holds a separator, because the subject is itself a number for a stage that
// builds one slice at a time: `build-slice-1` and `build-slice-2` are two different lines
// of work, while `build-slice-1` and `build-slice-1-2` are two attempts at the same one.
// Reading the name without the prefix cannot tell those apart, and the registry can.
//
// `null` for a proposal belonging to no stage with a prefix, which is the same answer
// `stageForProposal` gives and for the same reason.
export function proposalFamily(name) {
  const stage = stageForProposal(name);
  if (!stage) return null;
  const prefix = STAGES_BY_NAME[stage]?.proposalPrefix ?? "";
  const rest = String(name).slice(prefix.length);
  return rest.includes("-") ? `${prefix}${rest.replace(/-\d+$/, "")}` : `${prefix}${rest}`;
}

// The plain conditions on a ruling that name a path the stage receiving them cannot write.
// Each comes back with the path, the line it was read from, and which stages could deliver
// it — `[]` where none can, which is a different answer and reads differently.
//
// Only plain lines are read. `addressed-to` and `test-overreaches` already say, in the
// condition itself, that the work belongs to another stage, and reading them here as well
// would refuse a ruling for being explicit about exactly this.
export function undeliverableConditions(name, lines) {
  const stage = stageForProposal(name);
  if (!stage) return [];
  const delivers = collectOf(STAGES_BY_NAME[stage]);
  const { mine } = splitConditionsByAddressee(lines ?? []);
  const found = [];
  for (const line of mine) {
    for (const path of conditionPaths(line, pipelineOwns)) {
      if (coveredBy(delivers, path)) continue;
      found.push({ line, path, stage, delivers, deliverableBy: deliverableBy(path) });
    }
  }
  return found;
}

export function stageFor(name) {
  const stage = STAGES_BY_NAME[name];
  if (!stage) throw new Error(`unknown stage: ${name}`);
  return stage;
}

// Test-only escape hatch: registers a stage object under its own name so a test can
// exercise `runStage`/`finishStage` against behaviour (a failing pre-check, a
// deliberately unimplemented stub) that no real stage in `profiles.mjs` exhibits yet,
// without needing a new task to land first.
export function registerStage(stage) {
  STAGES_BY_NAME[stage.name] = stage;
}

export function skillText(name) {
  const preamble = readText(join(SKILLS_DIR, "_preamble.md"));
  const stage = stageFor(name);
  return `${preamble}\n${readText(stage.skill)}`;
}

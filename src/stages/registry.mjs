import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";
import { changedPaths, git, gitOk } from "../lib/git.mjs";
import { STAGES } from "../profiles.mjs";
import { parseDomainFile, parseAll, applyConditions, mintIds, serialiseDomainFile, writeIndex, renderSpecIndex, CONDITION_GRAMMAR } from "../spec/criteria.mjs";
import { checkCriteria, checkCriteriaIndex } from "../checks/criteria.mjs";
import { propose } from "../commands/propose.mjs";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "skills");

function skillPath(name) {
  return join(SKILLS_DIR, `${name}.md`);
}

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

// An `R-` ID is a permanent one, minted only by `ratify` once a human has ruled on what
// archaeology recovered — never archaeology's own to assign. The scope check below
// allows an archaeology run to touch any path under `spec/`, not only
// `spec/domains/<domain>.md`, so a mint slipped into some *other* domain file this run
// happened to change would escape a check scoped to just the target file. Every domain
// file is parsed (`parseAll`), but only the ones this run actually changed are judged —
// a domain file `ratify` legitimately minted `R-` IDs into on an earlier run is not this
// run's business and must not fail it.
function checkArchaeologyNoMintedIds(projectDir) {
  const id = "archaeology-no-minted-ids";
  const changed = new Set(changedPaths(projectDir).filter((p) => p.startsWith("spec/domains/") && p.endsWith(".md")));
  const messages = [];
  if (changed.size) {
    const { domains } = parseAll(projectDir);
    for (const [domain, criteria] of Object.entries(domains)) {
      const file = `spec/domains/${domain}.md`;
      if (!changed.has(file)) continue;
      const minted = criteria.filter((c) => c.id.startsWith("R-"));
      if (minted.length) messages.push(`${file} mints a permanent id (${minted.map((c) => c.id).join(", ")}); minting is ratify's job, not archaeology's`);
    }
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

// `archaeology` recovers one business domain's behaviour from the old application,
// checked out read-only at `sources/old` by the `with-sources` workspace before the
// agent session starts. It holds gate G1: the recovered domain file is not trusted as
// the contract until a human or the persona bound to G1 rules on it — ratify (a later
// stage) mints permanent IDs only for what that ruling accepts.
const archaeology = {
  name: "archaeology",
  title: "archaeology",
  skill: skillPath("archaeology"),
  workspace: "with-sources",
  gate: "G1",
  collect: [],
  implemented: true,
  prompt(ctx) {
    const d = ctx.domain;
    return [
      `Recover what the old application does for the "${d}" domain, reading only sources/old — its code, migrations, docs, README, and any OpenAPI/swagger file it has. Never read sources/old/tests, and never read anything outside sources/old except constitution.md, spec/, and intent/.`,
      `Write spec/domains/${d}.md in the criterion format your skill instructions describe (spec/README.md has the exact grammar): provisional IDs D-${d}-<n>, origin recovered, a confidence graded by the evidence you actually found, at least one cites on every criterion, a reconciliation class, and given/when/then. Mark anything you are not sure of inferred or open, and say in a note why.`,
      `Append any pages you recover to spec/contract/surface.yaml under a "domain: ${d}" entry, and any roles you recover to spec/contract/personas.yaml if they are not already listed there.`,
      `Finish with your journal entry: lead with three sentences on what the ${d} domain does, then say what conflicted between your sources, then say what you could not determine.`,
    ].join("\n\n");
  },
  proposal(ctx) {
    const d = ctx.domain;
    return {
      name: `archaeology-${d}`,
      question: `Is this what the ${d} domain does, and which of it is the contract?`,
      recommendation: recommendationFrom(ctx.agentText),
    };
  },
  preChecks(projectDir, ctx) {
    return [checkDomainOption(ctx), checkSourcesConfigured(ctx)];
  },
  postChecks(projectDir, ctx) {
    return [
      checkCriteria(projectDir, ctx),
      checkDomainFileParses(projectDir, ctx.domain, "archaeology-domain-file"),
      checkArchaeologyNoMintedIds(projectDir),
      checkArchaeologyScope(projectDir),
    ];
  },
};

function ratifyGateName(domain) {
  return `archaeology-${domain}`;
}

function ratifyGatePath(projectDir, domain) {
  return join(projectDir, ".sdlc", "gates", `${ratifyGateName(domain)}.yaml`);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The name of the nth follow-up proposal for a domain — the closing loop's own gate,
// asked once per pass over whatever is still `inferred` or `open`.
function followUpName(domain, n) {
  return `ratify-${domain}-${n}`;
}

// Every ruling this domain's ratification is built from, in the order it was made: the
// archaeology proposal first, then each follow-up (`ratify-<d>-1`, `-2`, …) by number.
// Only approved rulings contribute — a returned or escalated follow-up has decided
// nothing — and the conditions are concatenated in that order, so a later ruling's
// verdict on a criterion is applied after (and therefore over) an earlier one's.
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
  const names = [ratifyGateName(domain)];
  if (existsSync(dir)) {
    const re = new RegExp(`^ratify-${escapeRe(domain)}-(\\d+)\\.yaml$`);
    const follow = readdirSync(dir)
      .map((f) => [f, re.exec(f)])
      .filter(([, m]) => m)
      .sort((a, b) => Number(a[1][1]) - Number(b[1][1]))
      .map(([f]) => f.replace(/\.yaml$/, ""));
    names.push(...follow);
  }
  const conditions = [];
  const unparsed = [];
  const answered = new Set();
  const read = [];
  for (const name of names) {
    const p = join(dir, `${name}.yaml`);
    if (!existsSync(p)) continue;
    const gate = parseYaml(readText(p)) ?? {};
    if (gate.verdict !== "approve") continue;
    read.push(name);
    for (const c of gate.conditions ?? []) {
      conditions.push(c);
      // `contract` takes a bare ID; `spike` requires a trailing colon and text. Matched
      // separately so neither pattern accidentally swallows the colon into the ID.
      const m = /^\s*contract\s+(\S+)\s*$/.exec(c) ?? /^\s*spike\s+(\S+):/.exec(c);
      if (m) answered.add(m[1]);
    }
    for (const u of gate.unparsed_conditions ?? []) unparsed.push(`.sdlc/gates/${name}.yaml: ${u}`);
  }
  return { read, conditions, unparsed, answered };
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

// A follow-up proposal already open — its branch exists with no gate file on it yet — is
// the one this loop is waiting on, so no second one is opened alongside it. Returns the
// highest follow-up number seen either way, so the next one continues the sequence rather
// than reusing a number a ruled proposal already holds.
function followUpState(projectDir, domain) {
  const refs = gitOk(["for-each-ref", "--format=%(refname:short)", `refs/heads/proposal/ratify-${domain}-*`], projectDir)
    ? git(["for-each-ref", "--format=%(refname:short)", `refs/heads/proposal/ratify-${domain}-*`], projectDir).split("\n").filter(Boolean)
    : [];
  const re = new RegExp(`^proposal/ratify-${escapeRe(domain)}-(\\d+)$`);
  let highest = 0;
  let open = null;
  for (const branch of refs) {
    const m = re.exec(branch);
    if (!m) continue;
    highest = Math.max(highest, Number(m[1]));
    const name = branch.slice("proposal/".length);
    const ruledOnBranch = gitOk(["cat-file", "-e", `${branch}:.sdlc/gates/${name}.yaml`], projectDir);
    const ruledOnMain = existsSync(join(projectDir, ".sdlc", "gates", `${name}.yaml`));
    if (!ruledOnBranch && !ruledOnMain) open = name;
  }
  const dir = join(projectDir, ".sdlc", "gates");
  if (existsSync(dir)) {
    const gre = new RegExp(`^ratify-${escapeRe(domain)}-(\\d+)\\.yaml$`);
    for (const f of readdirSync(dir)) {
      const m = gre.exec(f);
      if (m) highest = Math.max(highest, Number(m[1]));
    }
  }
  return { open, highest };
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
    // follow-up the closing loop opened and the persona ruled. A later ruling's condition
    // on the same criterion is applied after an earlier one's, so closing a criterion out
    // is exactly a matter of ruling on it again.
    const { conditions, read } = readRulings(projectDir, domain);

    const domainFile = join(projectDir, "spec", "domains", `${domain}.md`);
    const originalText = readText(domainFile);

    const domains = ctx.config?.project?.domains ?? [];
    const domainOrdinal = domains.indexOf(domain) + 1;

    // Read before this pass writes anything: `maxRNumber` needs every OTHER domain's
    // own already-minted ids under this ordinal, not just this domain's.
    const { domains: allDomains } = parseAll(projectDir);
    const existingMax = maxRNumber(allDomains, domainOrdinal);

    const { criteria: before, preamble } = parseDomainFile(originalText, domain, domainOrdinal);
    const { criteria: withConditions, applied, unknown } = applyConditions(before, conditions);

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
    if (followUpRulingsRead(read, domain) >= 2) {
      for (const c of withConditions) {
        if (c.id.startsWith("D-") && (c.confidence === "inferred" || c.confidence === "open") && c.state !== "obsolete") {
          c.state = "obsolete";
          if (!c.notes.includes("unresolved after two rulings")) c.notes.push("unresolved after two rulings");
        }
      }
    }

    const minted = mintIds(withConditions, domainOrdinal, existingMax);
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

    if (!domainChanged) {
      return { text: `ratify ${domain}: nothing to do — already ratified`, changed: [] };
    }

    const accepted = minted.filter((c) => c.state === "accepted");
    const stillOpen = minted.filter((c) => c.id.startsWith("D-") && (c.confidence === "inferred" || c.confidence === "open") && c.state !== "obsolete");
    const obsolete = minted.filter((c) => c.state === "obsolete");
    const replacementsAdded = applied.filter((a) => a.verb === "defect").length;

    const lines = [`ratify ${domain}: ${accepted.length} accepted, ${stillOpen.length} still open, ${obsolete.length} obsolete, ${replacementsAdded} replacement(s) added.`];
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

    return { text: lines.join("\n"), changed: [`spec/domains/${domain}.md`, "spec/criteria-index.json", "spec/spec.md"] };
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
    const unresolved = criteria.filter((c) => (c.confidence === "inferred" || c.confidence === "open") && c.state !== "obsolete");
    const { answered, unparsed } = readRulings(projectDir, domain);
    if (unresolved.length === 0 && unparsed.length === 0) return null;

    const { open, highest } = followUpState(projectDir, domain);
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

// Every real pipeline stage (design, build, …) is a stub until its own task lands:
// calling `prompt` fails loudly and by name, so `sdlc run <stage>` reports a clear
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

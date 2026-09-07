import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";
import { changedPaths, git, gitOk } from "../lib/git.mjs";
import { STAGES } from "../profiles.mjs";
import { parseDomainFile, parseAll, applyConditions, mintIds, serialiseDomainFile, writeIndex, renderSpecIndex, CONDITION_GRAMMAR } from "../spec/criteria.mjs";
import { checkCriteria, checkCriteriaIndex } from "../checks/criteria.mjs";
import { checkEgress } from "../checks/egress.mjs";
import { checkTests, coverage } from "../checks/tests.mjs";
import { checkSeparation } from "../checks/separation.mjs";
import { loadContract, writeGenerated } from "../spec/surface.mjs";
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

// The default path for the compose override `contract` writes when a project configures
// an oracle at all — `.sdlc/oracle/compose.yml`, applied here in code rather than in the
// schema, so a project that never sets `oracle.compose_override` still gets a fixed,
// predictable path for `sdlc oracle` (and this stage's own post-check) to find.
function oracleOverridePath(config) {
  return config?.oracle?.compose_override ?? ".sdlc/oracle/compose.yml";
}

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
      if (!p.sign_in?.[identity]) messages.push(`persona "${p.id}" has no sign_in for identity "${identity}"`);
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
    parseYaml(readText(full));
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
      identities.length
        ? `2. spec/contract/personas.yaml: every role with a "can" list and a "sign_in" entry for every identity this project configures (${identities.join(", ")}). "session-route" needs { route: <path> }; "sandbox-idp" needs { username: <name> }. A persona with no sign-in at all (an anonymous visitor) writes "sign_in: null" rather than omitting the key.`
        : "2. spec/contract/personas.yaml: every role with a \"can\" list. This project configures no identity at all (no oracle, no targets), so no persona needs a sign_in entry yet.",
      fromSources
        ? "3. spec/contract/openapi.yaml: assembled from the old application's own API description files if it has any, else written from its routes — one operationId per route — with a top comment \"# recovered from <path(s)> at <commit>\" naming exactly where it came from."
        : "3. spec/contract/openapi.yaml: leave as is; there is no old application to recover an API description from.",
      "4. spec/contract/observables.yaml: email observed through a mail catcher at ${SDLC_MAIL_API}, plus any file or notification endpoint the criteria depend on.",
      "5. tests/seed/: one or more NNN-<name>.sql files, applied in name order, inserting one user per persona whose identity a session route or sandbox IdP looks up, plus whatever fixture records the accepted criteria's given-clauses need — all synthetic (example.test addresses, invented names that are not real people). Write tests/seed/manifest.yaml naming every inserted record a test will refer to by handle.",
      oracle
        ? `6. ${oracleOverridePath(config)}: a Compose override for ${oracle.compose} that publishes the app on \${SDLC_APP_PORT}, the database on \${SDLC_DB_PORT}, adds a "mailpit" service (axllent/mailpit:v1.28.0) publishing its API on \${SDLC_MAIL_API_PORT}, points the app's own mail settings at that mailpit service, sets whatever environment the app needs to run outside production with its test sign-in routes enabled (use "!override" for any env_file the base compose file declares, so this override's own environment actually wins), and defines the migration one-off service the config names (${oracle.migrate_service ?? "none configured"}), if any.`
        : "6. This project configures no oracle, so there is nothing to write under .sdlc/oracle/.",
      "Finish with your journal entry: say which pages exist, which sign-in method each persona uses, what the seed contains, and what could not be recovered.",
    ];
    return lines.join("\n\n");
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
function acceptedCriteria(projectDir, domain) {
  const idxPath = join(projectDir, "spec", "criteria-index.json");
  if (!existsSync(idxPath)) return { criteria: [], generatedFrom: "" };
  let index;
  try { index = JSON.parse(readText(idxPath)); } catch { return { criteria: [], generatedFrom: "" }; }
  const criteria = (index.criteria ?? []).filter((c) => c.domain === domain && c.state === "accepted");
  return { criteria, generatedFrom: index.generated_from ?? "" };
}

// Ids named in `tests/acceptance/redo.yaml` (`{ redo: [{ id, why }] }`) for one domain —
// an optional, hand-maintained file a person uses to ask `--stale` to redo a criterion
// `checkTests` would not otherwise flag as stale (its header version already matches the
// index, but something else about it needs another pass). An id the file names that does
// not belong to this domain's own accepted criteria is silently not this domain's
// business, the same way a stray id elsewhere in the file is not an error here.
function readRedoIds(projectDir, domain, byId) {
  const p = join(projectDir, "tests", "acceptance", "redo.yaml");
  if (!existsSync(p)) return [];
  let parsed;
  try { parsed = parseYaml(readText(p)); } catch { return []; }
  const redo = Array.isArray(parsed?.redo) ? parsed.redo : [];
  return redo.map((r) => r?.id).filter((id) => byId.get(id)?.domain === domain);
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
  for (const id of readRedoIds(projectDir, ctx.domain, byId)) ids.add(id);
  return { criteria: criteria.filter((c) => ids.has(c.id)), generatedFrom };
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
  const dir = join(projectDir, ".sdlc", "gates");
  if (!existsSync(dir)) return 1;
  const re = new RegExp(`^derive-tests-${escapeRe(domain)}-stale-(\\d+)\\.yaml$`);
  return readdirSync(dir).filter((f) => re.test(f)).length + 1;
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
  // another domain's own criteria.
  workspace: "spec-only",
  gate: "G3",
  // Copied back into the project once the session ends: the acceptance suite the agent
  // wrote, and the generated types `prepare` (below) regenerated in the workspace before
  // the agent ever saw it.
  collect: ["tests/acceptance", "tests/generated"],
  implemented: true,
  // Generates `tests/generated/*` from the contract already sitting in the workspace
  // (`git archive` put it there), so the agent's very first read of `surface`/`persona`/
  // `seed` is the same TypeScript a real test file imports — never regenerated from a
  // contract the agent could have edited itself, since this workspace never lets it.
  prepare(wsDir) {
    writeGenerated(wsDir);
  },
  prompt(ctx) {
    const d = ctx.domain;
    const criteria = ctx.deriveTestsCriteria ?? [];
    const specSha = ctx.deriveTestsGeneratedFrom || "0000000000000000000000000000000000000000";
    const today = new Date().toISOString().slice(0, 10);
    const list = criteria.map((c) => `- ${c.id} (v${c.version}): ${c.statement}`).join("\n");
    return [
      `Write one Playwright acceptance test per criterion below, for the "${d}" domain, and nothing else. You see only the contract (tests/generated/*, generated from spec/contract) and the seed; there is no app/ in this workspace and nothing here lets you read one.`,
      `The criteria to derive tests for:\n\n${list}`,
      `For each one, write tests/acceptance/${d}/<ID>.spec.ts, starting with exactly these two header lines:\n\n// criterion: @<ID> v<version>\n// provenance: blind, spec@${specSha}, derived ${today}\n\nImport only from "../../fixtures" and "../../generated/*". Sign in through persona.<id> when the criterion needs a signed-in actor, act through surface.<page>.<action>(), read through surface.<page>.<observation>(), and refer to a record through seed.<group>.<handle> rather than an id or a value you invented. Write one test() per given/when/then the criterion states, titled with the criterion's own statement. Never read or guess at how the system is built, and never write a selector, a locator call, a data-testid, a hardcoded route, or anything else that reaches past surface — the surface is the whole world.`,
      `A criterion nothing in surface reaches — no page, action or observation gets you there — gets an entry in tests/acceptance/not-testable.yaml instead of a file: { id: <ID>, version: <version>, reason: "<why>" }. A reason has to name what is actually missing, not that the criterion is hard.`,
      `Finish with your journal entry: how many criteria got a test, which were not testable and why, and which surface actions or observations you needed but did not find — name them, so the contract can be extended to reach them.`,
    ].join("\n\n");
  },
  proposal(ctx) {
    const d = ctx.domain;
    const name = ctx.stale
      ? `derive-tests-${d}-stale-${ctx.deriveTestsStaleN ?? nextDeriveTestsStaleVersion(ctx.projectDir, d)}`
      : `derive-tests-${d}`;
    return {
      name,
      question: `Do these tests follow from the ${d} criteria and from nothing else?`,
      recommendation: recommendationFrom(ctx.agentText),
    };
  },
  preChecks(projectDir, ctx) {
    // Resolved once here — the real project directory, before a workspace exists — and
    // stashed on `ctx` for `prompt(ctx)` to read back later with nothing else to go on.
    if (ctx.domain) {
      const resolved = resolveCriteriaToDerive(projectDir, ctx);
      ctx.deriveTestsCriteria = resolved.criteria;
      ctx.deriveTestsGeneratedFrom = resolved.generatedFrom;
    }
    return [
      checkDomainOption(ctx, "derive-tests"),
      checkDeriveTestsDomainRatified(projectDir, ctx),
      checkDeriveTestsStaleHasWork(ctx),
    ];
  },
  postChecks(projectDir, ctx) {
    // Stashed the same way `contract` stashes its own version: the real `proposal(ctx)`
    // call in `finishStage` does not carry `projectDir`, so a `--stale` run's number has
    // to be resolved here, while it is available, for `proposal` to read back.
    if (ctx.stale) ctx.deriveTestsStaleN = nextDeriveTestsStaleVersion(projectDir, ctx.domain);
    return [
      checkTestsBlind(projectDir, ctx),
      checkSeparation(projectDir),
      checkDeriveTestsCoverage(projectDir, ctx.domain),
      checkDeriveTestsScope(projectDir, ctx.domain),
      checkDeriveTestsBlindHeader(projectDir, ctx.domain),
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
STAGES_BY_NAME.contract = contract;
STAGES_BY_NAME["derive-tests"] = deriveTests;

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

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";
import { changedPaths, git, gitOk } from "../lib/git.mjs";
import { STAGES } from "../profiles.mjs";
import { parseDomainFile, parseAll, applyConditions, mintIds, serialiseDomainFile, writeIndex, renderSpecIndex } from "../spec/criteria.mjs";
import { checkCriteria } from "../checks/criteria.mjs";

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

// The recommendation on an intent proposal is the first sentence of the agent's own
// journal text, not a re-derivation of it: whatever the agent decided to say first is
// what a reader sees first. Falls back to the whole (trimmed) text when it holds no
// sentence-ending punctuation, and to a fixed line when there is no text at all.
export function firstSentence(text) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "no journal text was recorded";
  const match = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  let sentence = match ? match[0] : trimmed;
  if (sentence.length > 200) {
    sentence = sentence.slice(0, 200) + "…";
  }
  return sentence.trim();
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
      recommendation: firstSentence(ctx.agentText),
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

// The domain file this run is judged by: parsed fresh (not just checked for existence)
// so the file exists, parses, and holds at least one criterion.
function checkArchaeologyDomainFile(projectDir, domain) {
  const id = "archaeology-domain-file";
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
      recommendation: firstSentence(ctx.agentText),
    };
  },
  preChecks(projectDir, ctx) {
    return [checkDomainOption(ctx), checkSourcesConfigured(ctx)];
  },
  postChecks(projectDir, ctx) {
    return [
      checkCriteria(projectDir, ctx),
      checkArchaeologyDomainFile(projectDir, ctx.domain),
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

function checkRatifyDomainFile(projectDir, domain) {
  const id = "ratify-domain-file";
  if (!domain) return { id, ok: true, messages: [] };
  const file = `spec/domains/${domain}.md`;
  if (!existsSync(join(projectDir, file))) return { id, ok: false, messages: [`${file} is missing`] };
  return { id, ok: true, messages: [] };
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

    const gate = parseYaml(readText(ratifyGatePath(projectDir, domain))) ?? {};
    const conditions = gate.conditions ?? [];

    const domainFile = join(projectDir, "spec", "domains", `${domain}.md`);
    const originalText = readText(domainFile);

    const domains = ctx.config?.project?.domains ?? [];
    const domainOrdinal = domains.indexOf(domain) + 1;

    // Read before this pass writes anything: `maxRNumber` needs every OTHER domain's
    // own already-minted ids under this ordinal, not just this domain's.
    const { domains: allDomains } = parseAll(projectDir);
    const existingMax = maxRNumber(allDomains, domainOrdinal);

    const { criteria: before } = parseDomainFile(originalText, domain, domainOrdinal);
    const { criteria: withConditions, applied, unknown } = applyConditions(before, conditions);
    const minted = mintIds(withConditions, domainOrdinal, existingMax);
    const serialised = serialiseDomainFile(minted, domain);

    // Every verb `applyConditions` applies is idempotent against a row it already
    // changed (see that function's own comment), so replaying the same gate-file
    // conditions against an unchanged domain file reproduces the same text byte for
    // byte. That real comparison — not "does any `D-` id happen to remain" — decides
    // whether this run is a no-op: a domain can carry a `D-` id forever (a `spike`d or
    // still-`inferred` criterion that never gets confirmed) without that meaning a rerun
    // has fresh work to do.
    const domainChanged = serialised !== originalText;
    if (!domainChanged) {
      return { text: `ratify ${domain}: nothing to do — already ratified`, changed: [] };
    }
    writeText(domainFile, serialised);

    const parsed = parseAll(projectDir);
    writeIndex(projectDir, parsed);
    renderSpecIndex(projectDir, parsed);

    const accepted = minted.filter((c) => c.state === "accepted");
    const stillOpen = minted.filter((c) => c.id.startsWith("D-") && (c.confidence === "inferred" || c.confidence === "open"));
    const obsolete = minted.filter((c) => c.state === "obsolete");
    const replacementsAdded = applied.filter((a) => a.verb === "defect").length;

    const lines = [`ratify ${domain}: ${accepted.length} accepted, ${stillOpen.length} still open, ${obsolete.length} obsolete, ${replacementsAdded} replacement(s) added.`];
    if (stillOpen.length) {
      lines.push("Still open:");
      for (const c of stillOpen) lines.push(`- ${c.id} (${c.confidence})${c.notes?.length ? ` — ${c.notes[0]}` : ""}`);
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
    return [checkDomainOption(ctx, "ratify"), checkArchaeologyApproved(projectDir, ctx.domain), checkRatifyDomainFile(projectDir, ctx.domain)];
  },
  postChecks(projectDir, ctx) {
    return [checkCriteria(projectDir, ctx), checkSpecArtifacts(projectDir)];
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

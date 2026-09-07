// Every spec file's header names the criterion it derives from and how it got here; this
// check is what makes that claim trustworthy rather than decorative — the ID has to be a
// real, accepted criterion, the filename has to match it, and a claim of `blind`
// provenance has to be backed by the commit that actually wrote the file. `coverage`
// (used by `calibrate`'s post-check and by `status`) is exported from here rather than
// being a check of its own, since it is a read the way `checkCriteriaIndex` reads
// `spec/domains` — nothing here fails on it.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { readText } from "../lib/fsx.mjs";
import { git, gitOk } from "../lib/git.mjs";

const CRITERION_LINE_RE = /^\/\/ criterion: @(\S+) v(\d+)$/;
const PROVENANCE_LINE_RE = /^\/\/ provenance: (blind|unverified), spec@([0-9a-fA-F]+), derived (\d{4}-\d{2}-\d{2})$/;

// Subjects `derive-tests` itself writes, on the proposal, the direct-commit and the
// merge path respectively (see propose.mjs, finish-stage.mjs, rule.mjs) — the only three
// that let a `blind` claim stand once the file has real git history.
const DERIVE_TESTS_SUBJECT_RE = /^(propose\(G3\): derive-tests-|stage\(derive-tests\)|merge: derive-tests-)/;

function loadIndex(projectDir) {
  const p = join(projectDir, "spec", "criteria-index.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readText(p)); } catch (e) {
    return { parseError: e.message };
  }
}

function readYamlList(projectDir, relPath, key) {
  const p = join(projectDir, "tests", "acceptance", relPath);
  if (!existsSync(p)) return [];
  let parsed;
  try { parsed = parse(readText(p)); } catch { return []; }
  return Array.isArray(parsed?.[key]) ? parsed[key] : [];
}

const readNotTestable = (projectDir) => readYamlList(projectDir, "not-testable.yaml", "criteria");
const readAttestations = (projectDir) => readYamlList(projectDir, "attestations.yaml", "attestations");

// Whether a spec file claiming `blind` provenance actually earned it. A file whose header
// says `unverified` is unverified regardless of what git says — the header is the claim
// being checked, not overridden by it. For a `blind` claim: a file with no committed,
// clean version of itself (untracked, or with uncommitted changes) has no history yet to
// verify against — that is exactly the state `derive-tests`' own post-check sees its own
// output in, before it has committed, so only that stage's env var lets the claim stand;
// any other caller (`sdlc checks`, another stage's post-check) treats it as unverified
// until it is committed. Once there is a clean, committed version, the real subject line
// decides — a subject `derive-tests` did not write means the file was hand-edited or
// carried over from somewhere else, whatever the header claims.
function resolveProvenance(projectDir, relFile, claim) {
  if (claim === "unverified") return "unverified";
  const dirty = git(["status", "--porcelain", "--", relFile], projectDir).length > 0;
  if (dirty) return process.env.SDLC_STAGE === "derive-tests" ? "blind" : "unverified";
  const subject = gitOk(["log", "-1", "--format=%s", "--", relFile], projectDir)
    ? git(["log", "-1", "--format=%s", "--", relFile], projectDir)
    : "";
  return DERIVE_TESTS_SUBJECT_RE.test(subject) ? "blind" : "unverified";
}

export function checkTests(projectDir, ctx = {}) {
  const id = "tests";
  const messages = [];
  const warnings = [];
  const stale = [];

  const index = loadIndex(projectDir);
  // `runChecks` only calls this once `spec/criteria-index.json` exists, but a direct
  // caller against a project that has not reached ratify yet finds nothing here to
  // check against.
  if (index === null) return { id, ok: true, messages, warnings, stale };
  if (index.parseError) return { id, ok: false, messages: [`spec/criteria-index.json does not parse: ${index.parseError}`], warnings, stale };

  const criteria = Array.isArray(index.criteria) ? index.criteria : [];
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const defaultTier = ctx.config?.policy?.default_tier ?? "STANDARD";

  const acceptanceDir = join(projectDir, "tests", "acceptance");
  const specFiles = [];
  if (existsSync(acceptanceDir)) {
    for (const entry of readdirSync(acceptanceDir)) {
      const abs = join(acceptanceDir, entry);
      if (statSync(abs).isDirectory()) {
        for (const filename of readdirSync(abs)) {
          const fabs = join(abs, filename);
          if (statSync(fabs).isDirectory()) continue;
          specFiles.push({ relPath: `tests/acceptance/${entry}/${filename}`, filename, abs: fabs });
        }
      } else if (entry !== "not-testable.yaml" && entry !== "attestations.yaml") {
        // A test file sitting directly under tests/acceptance/, with no domain folder
        // above it, has nowhere for `coverage` to attribute it to.
        messages.push(`tests/acceptance/${entry}: tests live under a domain folder`);
      }
    }
  }

  const testedIds = [];
  for (const f of specFiles) {
    if (!f.filename.endsWith(".spec.ts")) {
      messages.push(`${f.relPath}: expected a *.spec.ts file`);
      continue;
    }
    const lines = readText(f.abs).split("\n");
    const m1 = CRITERION_LINE_RE.exec(lines[0] ?? "");
    const m2 = PROVENANCE_LINE_RE.exec(lines[1] ?? "");
    if (!m1) { messages.push(`${f.relPath}:1: expected "// criterion: @<ID> v<n>"`); continue; }
    if (!m2) { messages.push(`${f.relPath}:2: expected "// provenance: <blind|unverified>, spec@<sha>, derived <YYYY-MM-DD>"`); continue; }

    const [, headerId, versionStr] = m1;
    const version = Number(versionStr);
    const [, provenanceClaim] = m2;

    if (f.filename !== `${headerId}.spec.ts`)
      messages.push(`${f.relPath}: filename must be ${headerId}.spec.ts for the criterion in its header`);

    const entry = byId.get(headerId);
    if (!entry || entry.state !== "accepted") {
      messages.push(`${f.relPath}: @${headerId} is not an accepted criterion in spec/criteria-index.json`);
      continue;
    }
    testedIds.push(headerId);

    if (version < entry.version) {
      stale.push(headerId);
      warnings.push(`${f.relPath}: stale — header is v${version}, the index has v${entry.version}`);
    } else if (version > entry.version) {
      messages.push(`${f.relPath}: header is v${version}, but the index only has v${entry.version}`);
    }

    const tier = entry.tier ?? defaultTier;
    const provenance = resolveProvenance(projectDir, f.relPath, provenanceClaim);
    if (provenance === "unverified") {
      if (tier === "HIGH" || tier === "CRITICAL") {
        messages.push(`${f.relPath}: unverified provenance fails outright at tier ${tier}`);
      } else {
        const attested = readAttestations(projectDir).some((a) => a && a.file === f.relPath && a.by);
        if (!attested)
          messages.push(`${f.relPath}: unverified provenance at tier ${tier} needs an entry in tests/acceptance/attestations.yaml naming the file and a "by"`);
      }
    }
  }

  for (const entry of readNotTestable(projectDir)) {
    const idx = byId.get(entry?.id);
    if (!idx || idx.state !== "accepted")
      messages.push(`tests/acceptance/not-testable.yaml: ${entry?.id} is not an accepted criterion`);
    if (!entry?.reason || !String(entry.reason).trim())
      messages.push(`tests/acceptance/not-testable.yaml: ${entry?.id} has no reason`);
    if (testedIds.includes(entry?.id))
      messages.push(`tests/acceptance/not-testable.yaml: ${entry?.id} also has a test`);
  }

  return { id, ok: messages.length === 0, messages, warnings, stale };
}

// The accepted criteria of one domain, split by whether each is backed by a spec file,
// noted as not-testable, or neither. Not a check itself — `derive-tests`' post-check
// calls it for the domain it just worked, and `status` renders it as the coverage board.
export function coverage(projectDir, domain) {
  const index = loadIndex(projectDir);
  const criteria = index && Array.isArray(index.criteria) ? index.criteria : [];
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const accepted = criteria.filter((c) => c.domain === domain && c.state === "accepted").map((c) => c.id);

  const domainDir = join(projectDir, "tests", "acceptance", domain);
  const testedIds = new Set();
  if (existsSync(domainDir)) {
    for (const filename of readdirSync(domainDir)) {
      const m = /^(.+)\.spec\.ts$/.exec(filename);
      if (m) testedIds.add(m[1]);
    }
  }

  const notTestableIds = new Set(
    readNotTestable(projectDir).filter((e) => byId.get(e?.id)?.domain === domain).map((e) => e.id),
  );

  return {
    covered: accepted.filter((id) => testedIds.has(id)),
    missing: accepted.filter((id) => !testedIds.has(id) && !notTestableIds.has(id)),
    notTestable: accepted.filter((id) => notTestableIds.has(id)),
  };
}

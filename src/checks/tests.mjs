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
import { git } from "../lib/git.mjs";

const CRITERION_LINE_RE = /^\/\/ criterion: @(\S+) v(\d+)$/;
const PROVENANCE_LINE_RE = /^\/\/ provenance: (blind|unverified), spec@([0-9a-fA-F]+), derived (\d{4}-\d{2}-\d{2})$/;

// Subjects `derive-tests` itself writes, on the proposal, the direct-commit and the
// merge path respectively (see propose.mjs, finish-stage.mjs, rule.mjs) — the only three
// that let a `blind` claim stand once the file has real git history.
const DERIVE_TESTS_SUBJECT_RE = /^(propose\(G3\): derive-tests-|stage\(derive-tests\)|merge: derive-tests-)/;

// The files that legitimately sit directly under `tests/acceptance/` rather than inside a
// domain folder: the two exemption lists a spec file's absence is recorded in, and the
// list `calibrate` writes and `derive-tests --stale` reads (`redo.yaml`). Anything else
// loose in that directory is a test nothing can attribute to a domain.
const ACCEPTANCE_FILES = new Set(["not-testable.yaml", "attestations.yaml", "redo.yaml"]);

// Exported for `runSuite` (`src/testrun/playwright.mjs`), which needs the same
// criterion-to-domain lookup to report a `not-testable` row's domain — the index has no
// other reader, so there is nothing to duplicate by sharing this one.
export function loadIndex(projectDir) {
  const p = join(projectDir, "spec", "criteria-index.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readText(p)); } catch (e) {
    return { parseError: e.message };
  }
}

// `messages` is optional: `checkTests` passes its own message list so a parse failure is
// reported as a check failure naming the file, the same way `loadIndex` reports one for
// the criteria index; `coverage` (a read, not a check — see its own comment below) omits
// it and gets the pre-fix behaviour of treating an unparseable file as an empty list,
// since there is nothing there for it to fail.
function readYamlList(projectDir, relFile, key, messages) {
  const relPath = `tests/acceptance/${relFile}`;
  const p = join(projectDir, "tests", "acceptance", relFile);
  if (!existsSync(p)) return [];
  let parsed;
  try {
    parsed = parse(readText(p));
  } catch (e) {
    if (messages) messages.push(`${relPath}: does not parse: ${e.message}`);
    return [];
  }
  return Array.isArray(parsed?.[key]) ? parsed[key] : [];
}

// Exported for `runSuite`, which reports one row per not-testable entry the same way this
// check validates them, and needs the same list rather than a second parse of the file.
export const readNotTestable = (projectDir, messages) => readYamlList(projectDir, "not-testable.yaml", "criteria", messages);
const readAttestations = (projectDir, messages) => readYamlList(projectDir, "attestations.yaml", "attestations", messages);

// Parses a spec file's two-line provenance header: `// criterion: @<ID> v<n>` then
// `// provenance: <blind|unverified>, spec@<sha>, derived <date>`. Shared by `checkTests`
// below, which verifies the claim, and `runSuite` (`src/testrun/playwright.mjs`), which
// maps a Playwright report row back to the criterion it exercises — so the header format
// lives in one regex, not two. `label` is what an error names the file as; `checkTests`
// passes the project-relative path it already reports everything else against.
export function readHeader(absPath, label = absPath) {
  const lines = readText(absPath).split("\n");
  const m1 = CRITERION_LINE_RE.exec(lines[0] ?? "");
  if (!m1) return { error: `${label}:1: expected "// criterion: @<ID> v<n>"` };
  const m2 = PROVENANCE_LINE_RE.exec(lines[1] ?? "");
  if (!m2) return { error: `${label}:2: expected "// provenance: <blind|unverified>, spec@<sha>, derived <YYYY-MM-DD>"` };
  return { id: m1[1], version: Number(m1[2]), provenance: m2[1] };
}

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
//
// Both `git status` and `git log` run inside one try/catch rather than probing first with
// `gitOk` and then repeating the same call for real: a project that is not a git
// repository at all (or a file `git log` otherwise can't answer for) has no history to
// verify a blind claim against either way, so it degrades to `unverified` the same as an
// uncommitted file outside `derive-tests`, instead of throwing and taking the whole check
// down with it.
function resolveProvenance(projectDir, relFile, claim) {
  if (claim === "unverified") return "unverified";
  try {
    const dirty = git(["status", "--porcelain", "--", relFile], projectDir).length > 0;
    if (dirty) return process.env.SDLC_STAGE === "derive-tests" ? "blind" : "unverified";
    const subject = git(["log", "-1", "--format=%s", "--", relFile], projectDir);
    return DERIVE_TESTS_SUBJECT_RE.test(subject) ? "blind" : "unverified";
  } catch {
    return "unverified";
  }
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
  // Read once, with `messages` so either file's own YAML parse failure is reported by
  // name instead of silently read back as empty — the same file each is used from below.
  const notTestable = readNotTestable(projectDir, messages);
  const attestations = readAttestations(projectDir, messages);

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
      } else if (!ACCEPTANCE_FILES.has(entry)) {
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
    const header = readHeader(f.abs, f.relPath);
    if (header.error) { messages.push(header.error); continue; }
    const { id: headerId, version, provenance: provenanceClaim } = header;

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
        const attested = attestations.some((a) => a && a.file === f.relPath && a.by);
        if (!attested)
          messages.push(`${f.relPath}: unverified provenance at tier ${tier} needs an entry in tests/acceptance/attestations.yaml naming the file and a "by"`);
      }
    }
  }

  for (const entry of notTestable) {
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

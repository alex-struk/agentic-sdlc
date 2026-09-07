import { existsSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fsx.mjs";
import { parseAll } from "../spec/criteria.mjs";

// `spec/criteria-index.json` is what every stage after ratify reads instead of the
// domain files, so an index that has drifted from them is worse than no index: a stage
// builds against criteria the spec no longer holds, and nothing says so. Compared on the
// identity of each criterion rather than on the whole record — id, domain, version,
// confidence, state and statement — which is what a later stage actually consumes and
// what a hand edit to a domain file changes.
function indexSignature(criteria) {
  return criteria
    .map((c) => [c.domain, c.id, c.version, c.confidence, c.state, c.statement].join("\u0000"))
    .sort()
    .join("\n");
}

// `checkCriteria` reads the old application at `<projectDir>/sources/old` only to
// resolve `cites` paths against it. That checkout is materialised on demand (see
// `ensureSources`) and is never a project artifact, so a project that has not run
// archaeology yet — or a check running outside a full pipeline session — simply has no
// sources to check citations against. A missing directory turns citation checks into
// warnings rather than failures: the criterion itself may well be fine, there is just
// nothing here to verify it against right now.
export function checkCriteria(projectDir, ctx = {}) {
  const id = "criteria";
  const parsed = parseAll(projectDir);
  const messages = [];
  const warnings = [];

  for (const e of parsed.errors) messages.push(`${e.file}:${e.line}: ${e.message}`);

  const seenBy = new Map();
  const all = [];
  for (const [domain, criteria] of Object.entries(parsed.domains)) {
    for (const c of criteria) {
      all.push({ ...c, domain });
      if (seenBy.has(c.id)) messages.push(`duplicate id ${c.id}: ${seenBy.get(c.id)} and ${domain}`);
      else seenBy.set(c.id, domain);
    }
  }

  const sourcesDir = join(projectDir, "sources", "old");
  const sourcesExist = existsSync(sourcesDir);

  for (const c of all) {
    const where = `${c.domain}: ${c.id}`;

    if (c.origin === "recovered" && c.cites.length === 0)
      messages.push(`${where}: recovered but has no cites`);

    for (const cite of c.cites) {
      if (!sourcesExist) {
        warnings.push(`${where}: cites ${cite.path} but sources/old is not present to check it against`);
        continue;
      }
      if (!existsSync(join(sourcesDir, cite.path)))
        messages.push(`${where}: cites ${cite.path}, which does not exist under sources/old`);
    }

    if (c.state === "accepted" && (c.confidence === "inferred" || c.confidence === "open"))
      messages.push(`${where}: accepted while still ${c.confidence}`);

    // Any note satisfies a `defect` with no `replaces` — the check does not require a
    // specific phrase ("no replacement yet" and the like); the point is that the absence
    // of a replacement was noticed and recorded, not that it is worded a particular way.
    if (c.reconciliation === "defect" && !c.replaces && c.notes.length === 0)
      messages.push(`${where}: defect reconciliation has no replaces and no note explaining why`);
  }

  return { id, ok: messages.length === 0, messages, warnings };
}

// The generated index against the domain files it was generated from. Its own check
// rather than part of `checkCriteria` above, because the two are asked at different
// moments: every stage that touches `spec/domains` runs `checkCriteria` on its own
// output, and `archaeology` legitimately leaves the index behind — recovering a domain
// is exactly the act of adding criteria the index does not have yet, and ratify is the
// stage that catches it up. So this runs where a stale index is a real fault: `sdlc
// checks` (and therefore the checks a ruling persona is shown), and `ratify`'s own
// post-checks, which are its promise that the index it just regenerated matches.
//
// A missing index is not a failure: a project that has not ratified anything yet has
// nothing to be stale.
export function checkCriteriaIndex(projectDir) {
  const id = "criteria-index";
  const path = join(projectDir, "spec", "criteria-index.json");
  if (!existsSync(path)) return { id, ok: true, messages: [], warnings: [] };

  let indexed;
  try { indexed = JSON.parse(readText(path)).criteria; } catch (e) {
    return { id, ok: false, messages: [`spec/criteria-index.json does not parse: ${e.message}`], warnings: [] };
  }
  if (!Array.isArray(indexed)) return { id, ok: false, messages: ["spec/criteria-index.json has no criteria array"], warnings: [] };

  const parsed = parseAll(projectDir);
  const all = [];
  for (const [domain, criteria] of Object.entries(parsed.domains)) for (const c of criteria) all.push({ ...c, domain });
  if (indexSignature(indexed) === indexSignature(all)) return { id, ok: true, messages: [], warnings: [] };
  return {
    id, ok: false, warnings: [],
    messages: [`spec/criteria-index.json is stale: it holds ${indexed.length} criteria and spec/domains/*.md holds ${all.length}, or their ids, versions, confidences, states or statements differ. Run 'sdlc run ratify --domain <d>' to regenerate it.`],
  };
}

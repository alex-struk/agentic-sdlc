import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseAll } from "../spec/criteria.mjs";

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

    if (c.reconciliation === "defect" && !c.replaces && !c.notes.some((n) => /no replacement/i.test(n)))
      messages.push(`${where}: defect reconciliation has no replaces and no note saying there is none`);
  }

  return { id, ok: messages.length === 0, messages, warnings };
}

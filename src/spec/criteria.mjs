import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readText, writeText } from "../lib/fsx.mjs";
import { git, gitOk } from "../lib/git.mjs";
import { loadConfig } from "../config/load.mjs";

// The separator between the four heading fields is the middle dot (U+00B7), the way
// the format is written by hand and by agents; a plain hyphen surrounded by spaces is
// accepted too, since it is the character an agent (or a person) reaches for when the
// real one is not on the keyboard. `raw` below always normalises back to the dot, so
// whichever separator a domain file was written with, what this module treats as the
// canonical heading text is the same.
const DOT = "·";
const SEP = `\\s*(?:${DOT}|-)\\s*`;
const HEADING_RE = new RegExp(`^### (D-[a-z0-9-]+-\\d+|R-\\d+\\.\\d+)${SEP}v(\\d+)${SEP}(confirmed|inferred|open)${SEP}(recovered|authored)\\s*$`);
const BULLET_RE = /^- ([a-z-]+):\s*(.*)$/;
const CITE_RE = /^([^:]+)(?::(\d+))?$/;

// States a criterion's own `state` bullet may hold; used both to validate the
// `checkCriteria` "accepted while still inferred/open" rule and to order the coverage
// counts `renderSpecIndex` prints.
export const STATES = ["proposed", "accepted", "implemented", "verified", "monitored"];

function domainOf(id) {
  const m = /^D-(.+)-\d+$/.exec(id);
  return m ? m[1] : null;
}

// The trailing digits of an ID — `D-<domain>-<n>` and `R-<domain-number>.<n>` both end
// in the criterion's own sequence number — used to order criteria numerically within a
// domain rather than lexically (which would put `-10` before `-2`).
function idNumber(id) {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

function compareIds(a, b) {
  return idNumber(a) - idNumber(b) || a.localeCompare(b);
}

// One criterion block: `### <ID> · v<version> · <confidence> · <origin>`, one sentence
// (the statement), then `- key: value` bullets. Parses everything it can and collects
// what it cannot into `errors` rather than throwing, so a single malformed block in a
// domain file never hides every criterion after it.
export function parseDomainFile(text, domain) {
  const lines = text.split("\n");
  const criteria = [];
  const errors = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (!line.startsWith("### ")) {
      errors.push({ line: i + 1, message: `expected a heading (### ID ${DOT} vN ${DOT} confidence ${DOT} origin), got: ${line}` });
      i++;
      continue;
    }
    const headingLine = i + 1;
    const m = HEADING_RE.exec(line);
    if (!m) {
      errors.push({ line: headingLine, message: `malformed heading: ${line}` });
      i++;
      continue;
    }
    const [, id, version, confidence, origin] = m;
    const idDomain = domainOf(id);
    if (idDomain !== null && idDomain !== domain)
      errors.push({ line: headingLine, message: `heading ID ${id} belongs to domain "${idDomain}", not "${domain}"` });
    i++;

    // The statement is every non-empty, non-bullet line up to the first bullet (or the
    // next heading, or end of file), trimmed and joined with a space.
    const statementLines = [];
    while (i < lines.length) {
      const raw = lines[i];
      const t = raw.trim();
      if (raw.startsWith("### ") || t.startsWith("- ")) break;
      if (t !== "") statementLines.push(t);
      i++;
    }
    const statement = statementLines.join(" ");

    const cites = [];
    const notes = [];
    let reconciliation, given, when, then, state, tier, replaces, supersededBy;
    while (i < lines.length) {
      const raw = lines[i];
      const t = raw.trim();
      if (t === "") { i++; continue; }
      if (raw.startsWith("### ")) break;
      const bm = BULLET_RE.exec(t);
      if (!bm) {
        errors.push({ line: i + 1, message: `expected a bullet (- key: value), got: ${raw}` });
        i++;
        continue;
      }
      const [, key, rawValue] = bm;
      const value = rawValue.trim();
      if (key === "cites") {
        const cm = CITE_RE.exec(value);
        if (!cm) errors.push({ line: i + 1, message: `malformed cites value: ${value}` });
        else cites.push(cm[2] !== undefined ? { path: cm[1], line: Number(cm[2]) } : { path: cm[1] });
      } else if (key === "given") { given = given ? `${given} and ${value}` : value; }
      else if (key === "when") { when = when ? `${when} and ${value}` : value; }
      else if (key === "then") { then = then ? `${then} and ${value}` : value; }
      else if (key === "note") { notes.push(value); }
      else if (key === "reconciliation") reconciliation = value;
      else if (key === "state") state = value;
      else if (key === "tier") tier = value;
      else if (key === "replaces") replaces = value;
      else if (key === "superseded-by") supersededBy = value;
      else errors.push({ line: i + 1, message: `unknown key: ${key}` });
      i++;
    }

    criteria.push({
      id, version: Number(version), confidence, origin, statement,
      cites, reconciliation, given, when, then, notes,
      state: state ?? "proposed", tier, replaces, supersededBy,
      raw: `### ${id} ${DOT} v${version} ${DOT} ${confidence} ${DOT} ${origin}`,
      line: headingLine,
    });
  }

  return { criteria, errors };
}

// Every domain file under `spec/domains/*.md`, domain = file basename. A project with
// no `spec/domains` directory yet (nothing to parse) returns an empty result rather
// than throwing, so a caller (like `checkLayout`, which is what requires the directory
// exist in the first place) can decide what a missing directory means.
export function parseAll(projectDir) {
  const dir = join(projectDir, "spec", "domains");
  const domains = {};
  const errors = [];
  if (!existsSync(dir)) return { domains, errors };
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  for (const f of files) {
    const domain = f.replace(/\.md$/, "");
    const { criteria, errors: fileErrors } = parseDomainFile(readText(join(dir, f)), domain);
    domains[domain] = criteria;
    for (const e of fileErrors) errors.push({ file: `spec/domains/${f}`, ...e });
  }
  return { domains, errors };
}

// `spec/criteria-index.json`: `{generated_from, criteria}`, one entry per criterion
// carrying its `domain` and source `file` alongside everything `parseDomainFile`
// already collected. No timestamp is written anywhere in this file — `generated_from`
// is the only provenance, and it is the commit the working tree was at, not when the
// index was built, so regenerating from an unchanged working tree produces byte-for-
// byte identical output.
export function writeIndex(projectDir, parsed) {
  const generatedFrom = gitOk(["rev-parse", "HEAD"], projectDir) ? git(["rev-parse", "HEAD"], projectDir) : "";
  const criteria = [];
  for (const domain of Object.keys(parsed.domains).sort()) {
    for (const c of parsed.domains[domain]) criteria.push({ ...c, domain, file: `spec/domains/${domain}.md` });
  }
  criteria.sort((a, b) => (a.domain === b.domain ? compareIds(a.id, b.id) : a.domain.localeCompare(b.domain)));
  const path = join(projectDir, "spec", "criteria-index.json");
  writeText(path, `${JSON.stringify({ generated_from: generatedFrom, criteria }, null, 2)}\n`);
  return path;
}

function domainOrder(projectDir, domains) {
  const cfgPath = join(projectDir, ".sdlc", "config.yaml");
  let configured = null;
  if (existsSync(cfgPath)) {
    const { config } = loadConfig(cfgPath);
    if (Array.isArray(config?.project?.domains)) configured = config.project.domains;
  }
  if (!configured) return [...domains].sort();
  const rank = new Map(configured.map((d, i) => [d, i]));
  return [...domains].sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a) : Infinity;
    const rb = rank.has(b) ? rank.get(b) : Infinity;
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
}

// `spec/spec.md`: the generated, technology-free index a reader opens instead of the
// domain files themselves — one table per domain (ordered by `config.project.domains`
// where the config loads, else alphabetically; ties and unlisted domains fall back to
// alphabetical too) and a coverage count across every domain by `state`.
export function renderSpecIndex(projectDir, parsed) {
  const domains = domainOrder(projectDir, Object.keys(parsed.domains));
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  const sections = domains.map((domain) => {
    const criteria = [...parsed.domains[domain]].sort((a, b) => compareIds(a.id, b.id));
    const rows = criteria.map((c) => {
      counts[c.state] = (counts[c.state] ?? 0) + 1;
      return `| ${c.id} | ${c.version} | ${c.confidence} | ${c.state} | ${c.statement} |`;
    });
    return [`## ${domain}`, "", "| ID | Version | Confidence | State | Statement |", "| --- | --- | --- | --- | --- |", ...rows, ""].join("\n");
  });
  const coverage = ["## Coverage", "", "| State | Criteria |", "| --- | --- |",
    ...STATES.map((s) => `| ${s} | ${counts[s]} |`), ""].join("\n");
  const text = ["# Spec", "", "Generated by `sdlc run ratify`. Do not edit directly.", "", ...sections, coverage].join("\n");
  const path = join(projectDir, "spec", "spec.md");
  writeText(path, text);
  return path;
}

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
// Exactly one whitespace character on each side of the separator — not `\s*` — so a
// heading missing its spacing (`v1-confirmed`) fails to parse instead of silently
// matching; the format is written with single spaces around the separator and nothing
// looser is a valid heading.
const SEP = `(?:\\s${DOT}\\s|\\s-\\s)`;
const HEADING_RE = new RegExp(`^### (D-[a-z0-9-]+-\\d+|R-\\d+\\.\\d+)${SEP}v(\\d+)${SEP}(confirmed|inferred|open)${SEP}(recovered|authored)\\s*$`);
const BULLET_RE = /^- ([a-z-]+):\s*(.*)$/;
const CITE_RE = /^([^:]+)(?::(\d+))?$/;

// States a criterion's own `state` bullet may hold; used both to validate the
// `checkCriteria` "accepted while still inferred/open" rule and to order the coverage
// counts `renderSpecIndex` prints. `obsolete` covers a criterion that is no longer
// wanted at all (as opposed to `superseded-by`, which points at its replacement).
export const STATES = ["proposed", "accepted", "implemented", "verified", "monitored", "obsolete"];

// The closed vocabularies for `reconciliation` and `tier`. Like `state`, a value outside
// these lists is a parse error rather than being accepted verbatim — an unrecognised
// value here is exactly as dangerous as an unrecognised bullet key: it disarms whatever
// check or report reads the field, silently, unless it is rejected at parse time.
export const RECONCILIATIONS = ["aligned", "implemented-only", "documented-only", "conflicting", "defect"];
export const TIERS = ["LOW", "STANDARD", "HIGH", "CRITICAL"];

// Bullet keys that hold a single value rather than repeating (`cites`, `given`, `when`,
// `then` and `note` all repeat by design). A second occurrence of one of these is a
// parse error — silently keeping "the last one wins" would let a later duplicate bullet
// overwrite an earlier one with no record that it happened.
const SINGLE_KEYS = new Set(["reconciliation", "state", "tier", "replaces", "superseded-by"]);

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
// `expectedOrdinal`, when given, is the domain's 1-based position in
// `config.project.domains` — `parseAll` passes it through when a config is available;
// direct callers (and every existing test) that omit it get the parser's original,
// config-free behaviour: an `R-<k>.<n>` heading is accepted for any `k` at all. When it
// is given, a heading `R-<k>.<n>` whose `k` does not match is a parse error the same way
// a `D-` heading whose domain does not match the file is — a permanent id has drifted
// into the wrong file (most likely a domain reorder in `config.project.domains` after
// some ids were already minted under the old ordinal) and that is worth surfacing rather
// than silently accepting.
export function parseDomainFile(text, domain, expectedOrdinal) {
  const lines = text.split("\n");
  const criteria = [];
  const errors = [];
  let i = 0;
  let sawHeadingMarker = false;
  // Everything before the first `### ` line, captured byte for byte: a domain file's
  // title, whatever prose a person or an agent wrote under it, a table of sources. It is
  // not part of the criterion format and nothing here reads it, but `serialiseDomainFile`
  // writes it back unchanged, so a ratify pass no longer silently deletes it.
  // Sliced off the original text by offset rather than rebuilt from `lines`, so the
  // newline that terminates the last preamble line — which `split("\n")` consumes — is
  // still there when it is written back.
  const firstBlock = /^### /m.exec(text);
  const preamble = firstBlock ? text.slice(0, firstBlock.index) : text;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (!line.startsWith("### ")) {
      // Before the first `### ` block, a domain file may open with a `#`/`##` title or
      // any other prose (a short intro, a heading naming the domain) — that text is not
      // part of the criterion format and is ignored rather than flagged. Once the first
      // `### ` line has been seen (whether it went on to parse or not), the file is past
      // that point and a stray line here is again a real error.
      if (!sawHeadingMarker) { i++; continue; }
      errors.push({ line: i + 1, message: `expected a heading (### ID ${DOT} vN ${DOT} confidence ${DOT} origin), got: ${line}` });
      i++;
      continue;
    }
    sawHeadingMarker = true;
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
    if (expectedOrdinal !== undefined) {
      const rm = /^R-(\d+)\.\d+$/.exec(id);
      if (rm && Number(rm[1]) !== expectedOrdinal)
        errors.push({ line: headingLine, message: `heading ID ${id} belongs to domain ordinal ${rm[1]}, not ${expectedOrdinal} ("${domain}")` });
    }
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
    const singleSeen = new Set();
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
      // A single-value key repeated is a parse error rather than "last one wins": that
      // would silently discard whichever occurrence came first with nothing recorded.
      if (SINGLE_KEYS.has(key) && singleSeen.has(key)) {
        errors.push({ line: i + 1, message: `repeated key: ${key} (already set earlier in this block)` });
        i++;
        continue;
      }
      if (key === "cites") {
        const cm = CITE_RE.exec(value);
        if (!cm) errors.push({ line: i + 1, message: `malformed cites value: ${value}` });
        else cites.push(cm[2] !== undefined ? { path: cm[1], line: Number(cm[2]) } : { path: cm[1] });
      } else if (key === "given") { given = given ? `${given} and ${value}` : value; }
      else if (key === "when") { when = when ? `${when} and ${value}` : value; }
      else if (key === "then") { then = then ? `${then} and ${value}` : value; }
      else if (key === "note") { notes.push(value); }
      else if (key === "reconciliation") {
        singleSeen.add(key);
        if (RECONCILIATIONS.includes(value)) reconciliation = value;
        else errors.push({ line: i + 1, message: `invalid reconciliation: ${value} (expected one of ${RECONCILIATIONS.join(", ")})` });
      } else if (key === "state") {
        singleSeen.add(key);
        if (STATES.includes(value)) state = value;
        else errors.push({ line: i + 1, message: `invalid state: ${value} (expected one of ${STATES.join(", ")})` });
      } else if (key === "tier") {
        singleSeen.add(key);
        if (TIERS.includes(value)) tier = value;
        else errors.push({ line: i + 1, message: `invalid tier: ${value} (expected one of ${TIERS.join(", ")})` });
      } else if (key === "replaces") { singleSeen.add(key); replaces = value; }
      else if (key === "superseded-by") { singleSeen.add(key); supersededBy = value; }
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

  return { criteria, errors, preamble };
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

  // The ordinal check in `parseDomainFile` only fires when a config is actually
  // available and lists the domain — a domain file for a name `project.domains` does
  // not (yet) know about parses exactly as it always has, with no ordinal check at all.
  const cfgPath = join(projectDir, ".sdlc", "config.yaml");
  let configuredDomains = null;
  if (existsSync(cfgPath)) {
    const { config } = loadConfig(cfgPath);
    if (Array.isArray(config?.project?.domains)) configuredDomains = config.project.domains;
  }

  for (const f of files) {
    const domain = f.replace(/\.md$/, "");
    const ordinal = configuredDomains && configuredDomains.includes(domain) ? configuredDomains.indexOf(domain) + 1 : undefined;
    const { criteria, errors: fileErrors } = parseDomainFile(readText(join(dir, f)), domain, ordinal);
    domains[domain] = criteria;
    for (const e of fileErrors) errors.push({ file: `spec/domains/${f}`, ...e });
  }
  return { domains, errors };
}

// `spec/criteria-index.json`: `{generated_from, criteria}`, one entry per criterion
// carrying its `domain` and source `file` alongside everything `parseDomainFile`
// already collected. No timestamp is written anywhere in this file — `generated_from`
// is the only provenance, and it is the commit the criteria were read at rather than
// when the index was built.
//
// `generated_from` is only rewritten when the criteria themselves changed. Regenerating
// is cheap and happens on every ratify run, but every ratify run also *commits*, so a
// `generated_from` refreshed on content that did not change would leave the index dirty
// after every run, which would be committed, which would move HEAD again: a stage that
// can never reach a fixed point. Pinning it to the commit the current criteria were
// actually read at is both stable and the more truthful claim.
export function writeIndex(projectDir, parsed) {
  const criteria = [];
  for (const domain of Object.keys(parsed.domains).sort()) {
    for (const c of parsed.domains[domain]) criteria.push({ ...c, domain, file: `spec/domains/${domain}.md` });
  }
  criteria.sort((a, b) => (a.domain === b.domain ? compareIds(a.id, b.id) : a.domain.localeCompare(b.domain)));
  const path = join(projectDir, "spec", "criteria-index.json");

  let existing = null;
  if (existsSync(path)) { try { existing = JSON.parse(readText(path)); } catch { existing = null; } }
  // An empty `generated_from` is the "no commit existed yet" placeholder, not a commit
  // worth preserving, so it is refreshed as soon as there is a real HEAD to name.
  const keep = existing !== null && existing.generated_from
    && JSON.stringify(existing.criteria) === JSON.stringify(criteria);
  const generatedFrom = keep ? existing.generated_from
    : (gitOk(["rev-parse", "HEAD"], projectDir) ? git(["rev-parse", "HEAD"], projectDir) : "");
  writeText(path, `${JSON.stringify({ generated_from: generatedFrom, criteria }, null, 2)}\n`);
  return path;
}

// Pure ordering rule shared with `status.mjs`'s coverage board: domains named in
// `configured` (`config.project.domains`) sort by their position there; any domain not
// listed (and the whole set, when no config is available at all) falls back to
// alphabetical. Split out from `domainOrder` below so a caller that has already loaded
// its config (`buildSite` does) does not have to read `.sdlc/config.yaml` a second time
// just to order a set of domain names.
export function orderDomains(configured, domains) {
  if (!configured) return [...domains].sort();
  const rank = new Map(configured.map((d, i) => [d, i]));
  return [...domains].sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a) : Infinity;
    const rb = rank.has(b) ? rank.get(b) : Infinity;
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
}

function domainOrder(projectDir, domains) {
  const cfgPath = join(projectDir, ".sdlc", "config.yaml");
  let configured = null;
  if (existsSync(cfgPath)) {
    const { config } = loadConfig(cfgPath);
    if (Array.isArray(config?.project?.domains)) configured = config.project.domains;
  }
  return orderDomains(configured, domains);
}

// A `|` inside a free-text cell (a statement can contain one) would otherwise split the
// Markdown table into extra columns, so it is escaped on the way into every cell.
function escapeCell(s) {
  return String(s).replaceAll("|", "\\|");
}

// `spec/spec.md`: the generated, technology-free index a reader opens instead of the
// domain files themselves — one table per domain (ordered by `config.project.domains`
// where the config loads, else alphabetically; ties and unlisted domains fall back to
// alphabetical too) and a coverage count across every domain by `state`. `state` is
// validated by the parser against the closed `STATES` vocabulary (an unrecognised value
// is a parse error, not a silent pass-through), so every criterion reaching this
// function always carries a known state and no row's count is ever lost off the end of
// the coverage table.
export function renderSpecIndex(projectDir, parsed) {
  const domains = domainOrder(projectDir, Object.keys(parsed.domains));
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  const sections = domains.map((domain) => {
    const criteria = [...parsed.domains[domain]].sort((a, b) => compareIds(a.id, b.id));
    const rows = criteria.map((c) => {
      counts[c.state]++;
      return `| ${escapeCell(c.id)} | ${c.version} | ${c.confidence} | ${c.state} | ${escapeCell(c.statement)} |`;
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

// The product-owner's ruling vocabulary (see `templates/project/.sdlc/personas/product-owner.md`,
// "Ruling format"): one condition per line, `<verb> <ID>` or `<verb> <ID>: <text>`. `contract` and
// `confirm` take no text; the rest require it. Anything else — an unrecognised verb, a missing
// colon where one is required — is not this function's business to guess at, and is left for
// `applyConditions` to report as unknown rather than thrown here.
// No `/s` (dotAll) flag on any of these: `.` does not match a newline, so a value that
// tries to smuggle a second line in — `spike D-x-1: q\n- tier: CRITICAL`, hoping the
// injected `- tier:` line gets serialised into the domain file as its own bullet — fails
// to match at all (a bare `$`, with neither `/s` nor `/m`, only ever lands at the true
// end of the string, which a line with more content after an embedded `\n` never
// reaches), so the whole condition is reported as `unknown` rather than half-applied.
// What *is* still captured is run through `collapseWhitespace` so any internal run of
// whitespace a legitimate single-line value happens to carry (extra spaces, a stray tab)
// comes out normalised, rather than reproduced byte-for-byte into the domain file.
function collapseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

// The grammar itself, in words, for the two places that have to restate it to an agent:
// a persona whose first reply carried a line this could not parse, and the follow-up
// proposal page that asks it to close out the criteria still left open. Kept next to
// `parseCondition` so the two cannot drift apart.
export const CONDITION_GRAMMAR = [
  "One condition per line, and exactly one of these forms:",
  "",
  "- `contract <ID>` — leave as recovered. It does not promote the criterion — only `confirm` does — so",
  "  this is a no-op on anything still `inferred` or `open`. No text after the ID.",
  "- `confirm <ID>` — the evidence now supports raising its confidence to `confirmed`. No text after the ID.",
  "- `edit <ID>: <new statement>` — the behaviour is right, the wording is not.",
  "- `defect <ID>: <replacement statement>` — the old system does this and the new one should not; the row is kept as the record and the replacement is filed against it.",
  "- `spike <ID>: <question>` — not yet decided; confidence drops to `open` and the question is recorded.",
  "- `obsolete <ID>: <why>` or `drop <ID>: <why>` — not to be carried forward at all.",
  "",
  "The ID is the criterion's own id exactly as the domain file spells it. `contract` and `confirm`",
  "take no text; every other verb requires a colon and text on the same line. A condition may not",
  "span more than one line.",
].join("\n");

// True when `line` is a condition this grammar accepts. Used before a ruling is written,
// so a line the persona meant as a condition is caught while it can still be corrected
// rather than surfacing as an "unknown condition" in a ratify journal weeks later.
export function conditionParses(line) {
  return parseCondition(line) !== null;
}

export function unparsedConditions(lines) {
  return (lines ?? []).filter((l) => !conditionParses(l));
}

function parseCondition(line) {
  const t = line.trim();
  let m;
  if ((m = /^contract\s+(\S+)\s*$/.exec(t))) return { verb: "contract", id: m[1] };
  if ((m = /^confirm\s+(\S+)\s*$/.exec(t))) return { verb: "confirm", id: m[1] };
  if ((m = /^defect\s+(\S+):\s*(.+)$/.exec(t))) return { verb: "defect", id: m[1], text: collapseWhitespace(m[2]) };
  if ((m = /^edit\s+(\S+):\s*(.+)$/.exec(t))) return { verb: "edit", id: m[1], text: collapseWhitespace(m[2]) };
  if ((m = /^obsolete\s+(\S+):\s*(.+)$/.exec(t))) return { verb: "obsolete", id: m[1], text: collapseWhitespace(m[2]) };
  if ((m = /^drop\s+(\S+):\s*(.+)$/.exec(t))) return { verb: "drop", id: m[1], text: collapseWhitespace(m[2]) };
  if ((m = /^spike\s+(\S+):\s*(.+)$/.exec(t))) return { verb: "spike", id: m[1], text: collapseWhitespace(m[2]) };
  return null;
}

// Applies `ratify`'s gate-file conditions to a domain's parsed criteria. Every condition
// names an ID the product owner ruled on; a line this cannot parse, or whose ID is not in
// `criteria`, is reported in `unknown` rather than silently dropped — a persona's typo
// must surface somewhere a person will read it (the ratify journal), not vanish.
//
// `defect <ID>: <replacement>` is the one verb that adds a row rather than editing one:
// the old behaviour (`<ID>`) is kept, marked `reconciliation: defect`, and a new
// `authored`/`confirmed` criterion carries the corrected statement with `replaces: <ID>`.
// Its own provisional ID is minted here (`D-<domain>-<n>`, continuing from the highest
// number already used for that domain across both the input and any earlier addition in
// this same call) — `mintIds`, run right after, promotes it to a permanent `R-` id the
// same pass promotes its `replaces` target to, so the two end up pointing at each other's
// final IDs rather than one permanent and one provisional. The old row also gets
// `superseded-by` pointing at the replacement and a note naming it, both written once at
// creation — `checkCriteria` fails a `defect` row that has neither a `replaces` nor a
// note, and an inherited criterion that arrives already marked defect (recovered that
// way, with no note of its own) would otherwise trip that check the moment it is ratified.
//
// Every verb here is applied against whatever is already on the row, not blindly: a
// second (or third) `ratify` run over the same gate file's conditions — which happens
// whenever some other criterion in the domain is still `inferred`/`open` and so the
// domain file still has *a* `D-` row left in it, the signal `execute` used to use to
// decide whether to do anything at all — must leave the row exactly as the first run
// left it, not duplicate the note, bump the version again, or mint a second replacement.
// `confirm` and `contract` are naturally idempotent (setting `confidence` to the same
// value, or changing nothing, twice is still just that value); the rest check first.
export function applyConditions(criteria, conditions) {
  const out = criteria.map((c) => ({ ...c, notes: [...(c.notes ?? [])] }));
  const byId = new Map(out.map((c) => [c.id, c]));
  const additions = [];
  const applied = [];
  const unknown = [];

  const nextInDomain = (domain) => {
    const nums = [...out, ...additions].filter((c) => domainOf(c.id) === domain).map((c) => idNumber(c.id));
    return (nums.length ? Math.max(...nums) : 0) + 1;
  };

  for (const line of conditions) {
    const parsed = parseCondition(line);
    const target = parsed ? byId.get(parsed.id) : null;
    if (!parsed || !target) { unknown.push(line); continue; }
    const { verb, id, text } = parsed;

    switch (verb) {
      case "contract":
        // A no-op marker: recorded as applied so the journal can say the persona looked
        // at this ID and left it as the contract, without changing the row itself.
        break;
      case "confirm":
        target.confidence = "confirmed";
        break;
      case "edit":
        // Only a real change costs a version: replaying the same `edit` condition
        // against a row it already brought up to date must not keep bumping the
        // version every run.
        if (target.statement !== text) {
          target.statement = text;
          target.version += 1;
        }
        break;
      case "obsolete":
      case "drop":
        target.state = "obsolete";
        if (!target.notes.includes(text)) target.notes.push(text);
        break;
      case "spike":
        target.confidence = "open";
        if (!target.notes.includes(text)) target.notes.push(text);
        break;
      case "defect": {
        target.reconciliation = "defect";
        const domain = domainOf(target.id) ?? domainOf(id);
        // Idempotency check: a replacement for this exact defect — same target, same
        // corrected text — may already exist, either as an earlier addition in this same
        // call or (the ordinary case, replaying a prior ratify run's condition against a
        // row that survived as `D-` because it never got confirmed) one already sitting
        // in `criteria` from disk. `replaces` is checked against both the target's
        // *current* id and the condition's own `id` (the id as the ruling named it),
        // since the two coincide except when the target was minted on an earlier pass —
        // in which case this same condition line would already have failed the `byId`
        // lookup above and never reached here at all, so this covers the case that
        // matters: a target that stayed `D-` across repeated runs.
        const already = [...out, ...additions].find((c) => (c.replaces === target.id || c.replaces === id) && c.statement === text);
        if (!already) {
          const newId = `D-${domain}-${nextInDomain(domain)}`;
          const addition = {
            id: newId, version: 1, confidence: "confirmed", origin: "authored",
            statement: text, cites: [], reconciliation: undefined,
            given: undefined, when: undefined, then: undefined, notes: [],
            state: "proposed", tier: undefined, replaces: id, supersededBy: undefined,
            raw: `### ${newId} · v1 · confirmed · authored`, line: undefined,
          };
          additions.push(addition);
          byId.set(newId, addition);
          // Written once, here, using the replacement's provisional id: `mintIds`, run
          // right after, rewrites both `supersededBy` and this note's mention of `newId`
          // to the replacement's permanent id when it mints in the same pass (the
          // ordinary case, since the replacement is always authored `confirmed`).
          target.supersededBy = newId;
          target.notes.push(`superseded by ${newId}`);
        }
        break;
      }
    }
    applied.push({ line, id, verb });
  }

  return { criteria: [...out, ...additions], applied, unknown };
}

// Promotes every provisional criterion the product owner has confirmed to a permanent
// ID: `D-<domain>-<n>` with `confidence: confirmed` and a state other than `obsolete`
// becomes `R-<domainOrdinal>.<n>`, `n` continuing from `existingMax` (the highest `.<n>`
// already minted for this domain — a fresh domain passes 0). A criterion still `inferred`
// or `open` is not ready and keeps its `D-` id and `proposed` state untouched — ratify
// mints only what was actually ruled on. `replaces`/`superseded-by` references are
// rewritten to the new permanent id when the criterion they point at was minted in this
// same pass (a `defect` row and its replacement are minted together, so both end up
// pointing at final IDs); a reference to an id minted on an earlier run, or never minted
// at all, is left exactly as written. A note is free text, not a reference field, but a
// `defect` note (`applyConditions`) names its replacement by whatever id that replacement
// had at the moment the note was written — almost always its provisional one, since
// `applyConditions` runs before this function does — so any occurrence of an id this pass
// mints is rewritten inside every note too, the same way `replaces`/`superseded-by` are,
// rather than leaving a note as the one place a fully-ratified domain file still mentions
// a provisional id that no longer exists anywhere else in it.
export function mintIds(criteria, domainOrdinal, existingMax) {
  const out = criteria.map((c) => ({ ...c, notes: [...(c.notes ?? [])] }));
  const minted = new Map();
  let next = existingMax + 1;
  for (const c of out) {
    if (c.id.startsWith("D-") && c.confidence === "confirmed" && c.state !== "obsolete") {
      const newId = `R-${domainOrdinal}.${next}`;
      minted.set(c.id, newId);
      c.id = newId;
      c.state = "accepted";
      next += 1;
    }
  }
  const rewriteNote = (note) => {
    let rewritten = note;
    for (const [oldId, newId] of minted) {
      // `(?!\d)` keeps `D-x-1` from matching as a prefix of `D-x-10` — an id's trailing
      // number has no fixed width, so a plain substring replace could rewrite the wrong
      // (longer) id's mention by accident.
      const re = new RegExp(`${oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`, "g");
      rewritten = rewritten.replace(re, newId);
    }
    return rewritten;
  };
  for (const c of out) {
    if (c.replaces && minted.has(c.replaces)) c.replaces = minted.get(c.replaces);
    if (c.supersededBy && minted.has(c.supersededBy)) c.supersededBy = minted.get(c.supersededBy);
    if (minted.size && c.notes.length) c.notes = c.notes.map(rewriteNote);
  }
  return out;
}

// Writes a domain file back in the canonical format: one block per criterion, ids
// ordered numerically, bullets in the fixed order the format documents (spec/README.md)
// — cites, reconciliation, given, when, then, state, tier, replaces, superseded-by,
// note. `given`/`when`/`then` were already merged by the parser when several bullets of
// the same key repeated (`parseDomainFile` joins them with " and "), so each is written
// back as the single merged line it now is; re-parsing that line yields the identical
// merged string, which is what makes parse → serialise → parse round-trip. `state` is
// always written explicitly, even when it is the default `proposed`, so the file never
// depends on a reader knowing what an absent bullet defaults to.
export function serialiseDomainFile(criteria, domain, preamble) {
  // `preamble` is `parseDomainFile`'s own capture of everything before the first
  // criterion block, written back byte for byte. A caller that has none (a fresh file
  // being authored from criteria alone) gets the minimal title this format has always
  // produced; passing the empty string is a real value meaning "no preamble at all", so
  // only `undefined` falls back.
  const head = preamble === undefined ? `# ${domain}\n\n` : preamble;
  const sorted = [...criteria].sort((a, b) => compareIds(a.id, b.id));
  const blocks = sorted.map((c) => {
    const lines = [`### ${c.id} ${DOT} v${c.version} ${DOT} ${c.confidence} ${DOT} ${c.origin}`, c.statement];
    for (const cite of c.cites ?? []) lines.push(`- cites: ${cite.line !== undefined ? `${cite.path}:${cite.line}` : cite.path}`);
    if (c.reconciliation) lines.push(`- reconciliation: ${c.reconciliation}`);
    if (c.given) lines.push(`- given: ${c.given}`);
    if (c.when) lines.push(`- when: ${c.when}`);
    if (c.then) lines.push(`- then: ${c.then}`);
    lines.push(`- state: ${c.state ?? "proposed"}`);
    if (c.tier) lines.push(`- tier: ${c.tier}`);
    if (c.replaces) lines.push(`- replaces: ${c.replaces}`);
    if (c.supersededBy) lines.push(`- superseded-by: ${c.supersededBy}`);
    for (const note of c.notes ?? []) lines.push(`- note: ${note}`);
    return lines.join("\n");
  });
  // A file with no criteria at all is its preamble and nothing else; the trailing
  // newline is added only when the preamble does not already end in one, so the empty
  // result is `""` rather than a lone blank line.
  if (blocks.length === 0) return head && !head.endsWith("\n") ? `${head}\n` : head;
  return `${head}${blocks.join("\n\n")}\n`;
}

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
// The two shapes a criterion id takes: `D-<domain>-<n>` while it is provisional and
// `R-<domain ordinal>.<n>` once ratify has minted it. Exported as a pattern rather than a
// compiled regex because it is used two ways — anchored in the heading below, and scanned
// out of running prose (a proposal page, a diff, a path) by anything that has to work out
// which criteria a piece of work is about. One grammar, so the two readings cannot drift.
export const CRITERION_ID_PATTERN = "D-[a-z0-9-]+-\\d+|R-\\d+\\.\\d+";

const HEADING_RE = new RegExp(`^### (${CRITERION_ID_PATTERN})${SEP}v(\\d+)${SEP}(confirmed|inferred|open)${SEP}(recovered|authored)\\s*$`);
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

// Exported so callers outside this module (the suite runner's row sort, at least) order
// ids the same numeric way rather than falling back to a lexical sort that would put
// `R-1.10` before `R-1.2`.
export function compareIds(a, b) {
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

// A domain's 1-based position in an already-loaded `project.domains` list, or
// `undefined` when the list does not name it (including when there is no list at all).
// Pure, so `parseAll` below can call it once per file from a `configuredDomains` array
// it has already loaded, and `domainOrdinal` (also below) can call it after loading the
// config itself, without either one repeating the other's lookup.
function ordinalOf(configuredDomains, domain) {
  return configuredDomains && configuredDomains.includes(domain) ? configuredDomains.indexOf(domain) + 1 : undefined;
}

// `ordinalOf`, reading `config.project.domains` from disk itself — for a caller that
// has a project directory and a domain name and nothing already loaded, such as
// `readRulings` (`registry.mjs`) deciding which domain an `R-<k>.<n>` condition on a
// shared `contract-v<n>` ruling belongs to. `undefined` the same way `ordinalOf` is,
// including when `.sdlc/config.yaml` does not exist yet.
export function domainOrdinal(projectDir, domain) {
  const cfgPath = join(projectDir, ".sdlc", "config.yaml");
  if (!existsSync(cfgPath)) return undefined;
  const { config } = loadConfig(cfgPath);
  return ordinalOf(config?.project?.domains, domain);
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
    const ordinal = ordinalOf(configuredDomains, domain);
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
  "- `contract <ID>` — leave as recovered. It does not promote the criterion — `confirm`, `edit` and",
  "  `defect` all do — so this is a no-op on anything still `inferred` or `open`. No text after the ID.",
  "- `confirm <ID>` — the evidence now supports raising its confidence to `confirmed`. No text after the ID.",
  "- `edit <ID>: <new statement>` — the behaviour is right, the wording is not; confidence rises to",
  "  `confirmed` too, since the deliberate rewording is itself a second witness.",
  "- `defect <ID>: <replacement statement>` — the old system does this and the new one should not; the row",
  "  is kept as the record, its confidence rises to `confirmed` (it is a confirmed record of current",
  "  behaviour, marked defect), and the replacement is filed against it.",
  "- `spike <ID>: <question>` — not yet decided; confidence drops to `open` and the question is recorded.",
  "- `recovery-wrong <ID>: <what the evidence actually shows>` — the row does not record the old system's",
  "  behaviour at all: its statement, its citations and its given/when/then describe something the old",
  "  application does not do, so there is no statement to edit and nothing to mark defect or obsolete. The",
  "  criterion is sent back to `archaeology` to be recovered again, carrying this text; its confidence drops",
  "  to `open` so it cannot mint while it is out, and every other criterion in the domain ratifies as usual.",
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

// The id a ratification condition line names, without applying anything — `readRulings`
// (`registry.mjs`) uses this to decide which domain a `contract-v<n>` gate's condition
// belongs to before any of that gate's lines are folded into a domain's own ratify pass,
// the same way `calibrateConditionIds` (below) serves `calibrate`. `null` for a line the
// grammar cannot parse at all, which carries no id to judge ownership by and is
// reported instead as `unparsed_conditions`.
export function conditionTargetId(line) {
  return parseCondition(line)?.id ?? null;
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
  if ((m = /^recovery-wrong\s+(\S+):\s*(.+)$/.exec(t))) return { verb: "recovery-wrong", id: m[1], text: collapseWhitespace(m[2]) };
  return null;
}

// The product owner's ruling vocabulary at a *calibration* proposal — a different
// question from ratification's, so a different grammar: ratify asks which recovered
// criteria become the contract, calibrate asks what a criterion the old target fails
// actually means. `src/commands/rule.mjs` picks between the two by proposal name, and
// the calibrate follow-up page (`src/stages/registry.mjs`) restates this verbatim.
export const CALIBRATE_GRAMMAR = [
  "One condition per line, and exactly one of these forms:",
  "",
  "- `defect-in-old <ID>` — the old application really does fail this and the criterion is right",
  "  anyway. The test stands as written and the rebuild has to pass it; the criterion keeps a note",
  "  saying so. No text after the ID.",
  "- `spec-wrong <ID>: <corrected statement>` — the criterion misdescribes what the old application",
  "  does. The statement is replaced and its version bumped, which marks the test stale so",
  "  `derive-tests --stale` writes it again from the corrected criterion.",
  "- `test-wrong <ID>: <why>` — the criterion is right and the test is not. The id goes to",
  "  `tests/acceptance/redo.yaml` for `derive-tests` to redo, still blind, and `<why>` records what",
  "  the test got wrong without describing how the application is built.",
  "",
  "The ID is the criterion's own id exactly as `spec/criteria-index.json` spells it. `defect-in-old`",
  "takes no text; the other two require a colon and text on the same line. A condition may not span",
  "more than one line.",
].join("\n");

// The reviewer's grammar for sorting a calibration's failures before any reach the product
// owner. Whether the harness bound a page correctly is a technical question with a right
// answer in the adapter's code, and the product owner is the wrong role to ask it: a real
// product owner would never be asked whether a test's browser driver read the right element,
// and a simulated one should not be either. So every failing row is looked at first by the
// persona that already rules on adapters, and only the ones it passes on are put to the
// product owner at all (`docs/decisions/0008-adapter-wrong.md`).
export const TRIAGE_GRAMMAR = [
  "One condition per line, one for every failing criterion the page lists, in exactly one of these forms:",
  "",
  "- `adapter-wrong <ID>: <why>` — the criterion and the test are both fine, and this target's adapter",
  "  is what failed: it read the wrong thing off the page, reported a control missing that the page",
  "  does render, or answered empty where it never reached the page. `<why>` names what the adapter",
  "  did wrong, specifically enough for the next binding run to fix it. The criterion is not touched.",
  "- `product-question <ID>` — nothing in the evidence points at the adapter. The failure goes to the",
  "  product owner, who decides whether the application, the criterion or the test is wrong. No text",
  "  after the ID.",
  "",
  "The ID is the criterion's own id exactly as `spec/criteria-index.json` spells it. A condition may",
  "not span more than one line. When the evidence is genuinely unclear, it is a `product-question`:",
  "a failure wrongly sent to the product owner is answered there, while one wrongly blamed on the",
  "adapter comes back from the next binding run unchanged and costs a run to find out.",
].join("\n");

// The note `defect-in-old` leaves on the criterion, without its date. Matched as a
// suffix when deciding whether the note is already there, so re-applying the same ruling
// on a later day appends nothing rather than a second, differently dated copy.
const DEFECT_IN_OLD_NOTE = "the old target fails this; kept, the rebuild must pass it";

// No `/s` flag, and a bare `$`, for the same reason `parseCondition` above has neither: a
// value carrying an embedded newline fails to match at all rather than smuggling a second
// line into the domain file as its own bullet.
function parseCalibrateCondition(line) {
  const t = line.trim();
  let m;
  if ((m = /^defect-in-old\s+(\S+)\s*$/.exec(t))) return { verb: "defect-in-old", id: m[1] };
  if ((m = /^spec-wrong\s+(\S+):\s*(.+)$/.exec(t))) return { verb: "spec-wrong", id: m[1], text: collapseWhitespace(m[2]) };
  if ((m = /^test-wrong\s+(\S+):\s*(.+)$/.exec(t))) return { verb: "test-wrong", id: m[1], text: collapseWhitespace(m[2]) };
  return null;
}

// The condition form for the third thing an unbound verdict can mean: the criterion is
// right, and the acceptance test derived from it reaches past what it asks for. The test
// drives a capability the criterion never names, the adapter has nothing to bind it to,
// and what comes back is an accurate message naming the wrong culprit — the application is
// reported as lacking a surface that was never in the contract in the first place.
//
// It is read out of a ruling's conditions at whatever gate the ruling was made, rather than
// belonging to one proposal family's own grammar, because it is a statement about a
// criterion and its derived test and neither of those belongs to the proposal being ruled.
// A ruling that carries it is asking for one test to be written again, and for nothing
// else: it resolves no criterion, promotes nothing and verifies nothing.
export const OVERREACH_VERB = "test-overreaches";

// Restated wherever a ruler has to be told the form exists — `verify`'s unbound
// remediation, and the error a malformed line is refused with — so the wording cannot
// drift between the place that offers it and the place that reads it.
export const OVERREACH_CONDITION_FORM =
  `${OVERREACH_VERB} <ID>: <what the test demands that the criterion does not ask for>`;

// No `/s` flag and a bare `$`, for the same reason `parseCondition` has neither. The
// reason is required and a reason that collapses to nothing is not one: an entry filed
// without it would send the criterion back to a writer with nothing to write differently,
// which is the whole defect this form exists to close.
function parseOverreachCondition(line) {
  const m = new RegExp(`^${OVERREACH_VERB}\\s+(\\S+):\\s*(.+)$`).exec(String(line).trim());
  if (!m) return null;
  const text = collapseWhitespace(m[2]);
  return text ? { verb: OVERREACH_VERB, id: m[1], text } : null;
}

// Every readable `test-overreaches` line in a ruling's conditions. Lines in any other
// shape are somebody else's business and are left exactly as they are: at G3 a condition
// list is free text a writer reads, and this form is the one line in it a stage acts on.
export function overreachConditions(lines) {
  return (lines ?? []).map(parseOverreachCondition).filter(Boolean);
}

// Lines that open with the verb and are not a condition — a bare id, a colon with nothing
// after it, a reason that is only whitespace. Reported separately from "not this form at
// all" because the two call for opposite handling: an ordinary free-text line is kept
// verbatim for the writer, and one of these is a ruling that would be filed as a request
// nobody can act on, so the ruling is refused until it says something.
export function malformedOverreachConditions(lines) {
  return (lines ?? []).filter((l) => new RegExp(`^${OVERREACH_VERB}\\b`).test(String(l).trim()) && !parseOverreachCondition(l));
}

// Which grammar a G1 ruling's conditions are read in. Two proposals reach G1 carrying
// conditions and they ask different questions: an archaeology or ratify follow-up asks
// which recovered criteria become the contract (the ratification grammar), and a
// calibration proposal asks what a criterion the old target fails actually means (the
// calibration grammar). The proposal's own name is what tells them apart — every
// calibration proposal is `calibrate-<target>-<n>` — because a condition read in the
// wrong grammar is not a parse error, it is a ruling that would be dropped in silence.
//
// A third family, `calibrate-triage-<target>-<n>`, is checked first because its name also
// starts `calibrate-`: the reviewer's sorting of a calibration's failures, read in its own
// two-verb grammar at G3, before any failure reaches the product owner.
export function conditionGrammarFor(name) {
  if (name.startsWith("calibrate-triage-"))
    return { label: "triage", text: TRIAGE_GRAMMAR, unparsed: unparsedTriageConditions, checked: true };
  return name.startsWith("calibrate-")
    ? { label: "calibration", text: CALIBRATE_GRAMMAR, unparsed: unparsedCalibrateConditions, checked: false }
    : { label: "ratification", text: CONDITION_GRAMMAR, unparsed: unparsedConditions, checked: false };
}

// Whether this proposal's conditions are an instruction a stage applies through a closed
// vocabulary, rather than free-text lines a writer reads. Three families are: ratification
// and calibration at G1, and the reviewer's triage page at G3. Everything else at G3 and
// every other gate carries free text.
//
// It decides where the cross-stage forms are read — `test-overreaches` and `addressed-to`
// both. A closed grammar is closed on purpose — a
// line it cannot parse is a ruling that would otherwise be dropped in silence, so it is
// recorded verbatim under `unparsed_conditions` for a person to rewrite, and the stage that
// owns the grammar refuses to act on the gate file until they have. Reading a second,
// unrelated verb out of those same lines would file a request off a ruling that has been
// declared unreadable, and jam the owning stage while doing it. Where the conditions are
// free text there is no such contract to break and nothing else is reading them.
export function conditionsAreExecutable(gate, name) {
  return gate === "G1" || conditionGrammarFor(name).checked;
}

// The stage a `test-overreaches` line is addressed to. The form names a criterion rather
// than a stage, because that is what it is about, but the work it asks for is one stage's
// and the routing has to be able to say which.
export const OVERREACH_STAGE = "derive-tests";

// The condition form for a ruling whose work is not the stage being ruled's at all: the
// reviewer at one gate sees something about an artifact another stage produced, and often
// an artifact that gate has already approved. The build is what proves a slice claims more
// than it can demonstrate, and nothing about that was knowable when the plan was ruled.
//
// A verb, a target and a reason, the same three parts `test-overreaches` has. The target
// here is a stage name rather than a criterion id, and the reason is what that stage is
// handed in place of everything it cannot see: the gate it was raised at, the proposal it
// was raised on and the evidence behind it all belong to the ruling, not to the stage the
// request arrives at.
export const ADDRESSED_VERB = "addressed-to";

// Restated wherever a ruler has to be told the form exists — the persona briefs, and the
// error a malformed line is refused with — so the wording cannot drift between the place
// that offers it and the place that reads it.
export const ADDRESSED_CONDITION_FORM =
  `${ADDRESSED_VERB} <stage>: <what that stage has to change, and what showed it>`;

// No `/s` flag and a bare `$`, for the same reason `parseCondition` has neither. The
// reason is required and a reason that collapses to nothing is not one: a request filed
// without it reaches the addressed stage saying only that somebody was unhappy, which is
// the defect this form exists to close.
function parseAddressedCondition(line) {
  const m = new RegExp(`^${ADDRESSED_VERB}\\s+(\\S+):\\s*(.+)$`).exec(String(line).trim());
  if (!m) return null;
  const text = collapseWhitespace(m[2]);
  return text ? { verb: ADDRESSED_VERB, stage: m[1], text } : null;
}

// Every readable `addressed-to` line in a ruling's conditions. Lines in any other shape
// are the ruled stage's own business and are left exactly as they are.
export function addressedConditions(lines) {
  return (lines ?? []).map(parseAddressedCondition).filter(Boolean);
}

// Lines that open with the verb and are not a condition — a bare stage name, a colon with
// nothing after it, a reason that is only whitespace. Reported separately from "not this
// form at all" because the two call for opposite handling: an ordinary free-text line is
// kept verbatim for the writer, and one of these would file a request nobody can act on,
// so the ruling is refused until it says something.
export function malformedAddressedConditions(lines) {
  return (lines ?? []).filter((l) => new RegExp(`^${ADDRESSED_VERB}\\b`).test(String(l).trim()) && !parseAddressedCondition(l));
}

// The two verbs a ruler accounts for an earlier ruling's condition with. A plain condition
// on a return is an instruction the stage it goes back to is meant to carry out, and until
// one of these is written nothing says whether it ever was: the revision is ruled on its own
// merits, and the condition simply stops being mentioned.
//
// Two verbs rather than one, because the two claims are different and the record exists to
// keep them apart. `condition-met` says the work was done and says where it can be seen.
// `condition-withdrawn` says it should not be done after all. Collapsing them into a single
// "resolved" would lose exactly the distinction anyone reading the ledger afterwards came
// for. A condition nobody writes either line about stays open, which is what carrying it
// forward is: it keeps surfacing on every run until a ruler says something.
//
// The target is a reference — `<proposal>#<n>` — rather than the condition's own text,
// because a condition is a sentence and quoting a sentence back exactly is not something to
// ask of a turn. `sdlc checks` prints the reference next to every open condition.
export const CONDITION_MET_VERB = "condition-met";
export const CONDITION_WITHDRAWN_VERB = "condition-withdrawn";

// Restated wherever a ruler has to be told the forms exist — the ruling prompt, and the
// error a malformed line is refused with — so the wording cannot drift between the place
// that offers them and the place that reads them.
export const CONDITION_MET_FORM = `${CONDITION_MET_VERB} <ref>: <what was done, and where it can be seen>`;
export const CONDITION_WITHDRAWN_FORM = `${CONDITION_WITHDRAWN_VERB} <ref>: <why it is no longer asked for>`;

// No `/s` flag and a bare `$`, for the same reason `parseCondition` has neither. The reason
// is required on both: an entry closed with nothing after the colon records that somebody
// closed it and nothing about why, which is the state this whole ledger exists to end.
function parseAccountCondition(line) {
  const m = new RegExp(`^(${CONDITION_MET_VERB}|${CONDITION_WITHDRAWN_VERB})\\s+(\\S+):\\s*(.+)$`).exec(String(line).trim());
  if (!m) return null;
  const text = collapseWhitespace(m[3]);
  return text ? { verb: m[1], outcome: m[1] === CONDITION_MET_VERB ? "met" : "withdrawn", ref: m[2], text } : null;
}

// Every readable accounting line in a ruling's conditions. Lines in any other shape are
// somebody else's business and are left exactly as they are.
export function accountedConditions(lines) {
  return (lines ?? []).map(parseAccountCondition).filter(Boolean);
}

// Lines that open with one of the verbs and are not a condition — a bare reference, a colon
// with nothing after it, a reason that is only whitespace. Reported separately from "not
// this form at all" for the same reason the other verbs report it separately: an ordinary
// free-text line is kept verbatim for the writer, and one of these would close a ruling's
// instruction while recording nothing about why.
export function malformedAccountedConditions(lines) {
  return (lines ?? []).filter((l) => new RegExp(`^(${CONDITION_MET_VERB}|${CONDITION_WITHDRAWN_VERB})\\b`).test(String(l).trim())
    && !parseAccountCondition(l));
}

// Which verdicts each condition form may ride on, and the sentence that says why.
//
// One table, read twice and written once. The guards in `src/commands/rule.mjs` refuse a
// verdict carrying a form this table says it may not, in these words; the ruling prompt
// (`conditionFormsNote`, `src/runner/persona.mjs`) states the same rule to the ruler before
// it rules, out of the same entries. A ruler is therefore told the rule it will be held to
// rather than a second copy of it, which is the property the deliverability note already
// has: what the prompt promises and what the code enforces cannot drift apart, because
// there is only one of them.
//
// `because` is a clause, not a sentence, so both readers can frame it — the refusal as
// "an `x` condition <because>", the prompt as "it <because>".
export const CONDITION_FORM_RULES = [
  {
    verb: OVERREACH_VERB,
    form: OVERREACH_CONDITION_FORM,
    onApproval: false,
    because: "asks for a criterion's test to be written again, and the criterion stays unverified"
      + " until a regenerated test binds and passes",
  },
  {
    verb: ADDRESSED_VERB,
    form: ADDRESSED_CONDITION_FORM,
    onApproval: false,
    because: "asks another stage to produce its artifact again, and says the work being ruled"
      + " was built against something that has to change",
  },
  {
    verb: CONDITION_MET_VERB,
    form: CONDITION_MET_FORM,
    onApproval: true,
    because: "records that an instruction an earlier ruling left owed has been carried out, which"
      + " a revision is ordinarily approved for doing",
  },
  {
    verb: CONDITION_WITHDRAWN_VERB,
    form: CONDITION_WITHDRAWN_FORM,
    onApproval: true,
    because: "records that an instruction an earlier ruling left owed is no longer asked for,"
      + " which is as true of an approval as of a return",
  },
];

// The rule for one verb, or null where the verb is not one this table governs.
export function conditionFormRule(verb) {
  return CONDITION_FORM_RULES.find((r) => r.verb === verb) ?? null;
}

// The forms only a return may carry, and the forms either verdict may. Separate readers
// rather than a filter at each call site, so the prompt and the guards agree on the split
// by construction.
export function returnOnlyConditionForms() {
  return CONDITION_FORM_RULES.filter((r) => !r.onApproval);
}
export function approvableConditionForms() {
  return CONDITION_FORM_RULES.filter((r) => r.onApproval);
}

// Every path-like token in a free-text condition line. A ruler writes a condition as prose
// and names a file in it the way anyone does, in backticks or bare, so the tokens are read
// out of the sentence rather than required in a form.
//
// A token counts only when it looks like a path rather than like a word: it either carries
// a separator or an extension. "Rework the plan so the second slice stands alone" names no
// file, and reading `plan` out of it as one would refuse most of the rulings anyone writes.
// Trailing sentence punctuation is dropped, since a path at the end of a sentence has some.
//
// `owned` decides which of those tokens this pipeline has any say over; the caller supplies
// it, and a token outside it belongs to the project and is left alone. The default is every
// token, which is what a caller testing the reading itself wants.
export function conditionPaths(line, owned = null) {
  const found = [];
  for (const raw of String(line ?? "").match(/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*/g) ?? []) {
    const token = raw.replace(/[.,;:!?)\]}'"`]+$/, "");
    if (!token.includes("/") && !token.includes(".")) continue;
    if (/^\d+(\.\d+)*$/.test(token)) continue;
    if (owned && !owned(token)) continue;
    if (!found.includes(token)) found.push(token);
  }
  return found;
}

// A ruling's conditions split into the ones the stage being asked to revise is to act on
// and the ones addressed to some other stage. Both cross-stage forms are read here, since
// both leave the same hole in a revise prompt: `test-overreaches` names a criterion whose
// test another stage writes, and `addressed-to` names the stage outright.
//
// A stage handed a condition it cannot act on — and in the plain case, one naming a file
// outside its own overlay — either fails or finds a way, and neither is what the ruler
// asked for. What `mine` leaves out, `elsewhere` accounts for by name.
// `accounted` is the third bucket, and it is neither: an accounting line is about a ruling
// that has already been made, not work for anybody. A stage handed one would read it as a
// thing to do and have no way to do it.
export function splitConditionsByAddressee(lines) {
  const mine = [];
  const elsewhere = [];
  const accounted = [];
  for (const line of lines ?? []) {
    const account = parseAccountCondition(line);
    if (account) { accounted.push(account); continue; }
    const addressed = parseAddressedCondition(line);
    if (addressed) { elsewhere.push({ stage: addressed.stage, text: addressed.text }); continue; }
    const overreach = parseOverreachCondition(line);
    if (overreach) { elsewhere.push({ stage: OVERREACH_STAGE, text: overreach.text }); continue; }
    mine.push(line);
  }
  return { mine, elsewhere, accounted };
}

// The reviewer's two triage verbs, read on their own so a triage line can never be taken for
// a product ruling or the other way round: each proposal family is read in its own grammar.
function parseTriageCondition(line) {
  const t = line.trim();
  let m;
  if ((m = /^adapter-wrong\s+(\S+):\s*(.+)$/.exec(t))) return { verb: "adapter-wrong", id: m[1], text: collapseWhitespace(m[2]) };
  if ((m = /^product-question\s+(\S+)\s*$/.exec(t))) return { verb: "product-question", id: m[1] };
  return null;
}

export function triageConditionParses(line) {
  return parseTriageCondition(line) !== null;
}

export function unparsedTriageConditions(lines) {
  return (lines ?? []).filter((l) => !triageConditionParses(l));
}

export function parseTriageConditions(lines) {
  return (lines ?? []).map((line) => ({ line, ...(parseTriageCondition(line) ?? {}) })).filter((c) => c.verb);
}

export function calibrateConditionParses(line) {
  return parseCalibrateCondition(line) !== null;
}

export function unparsedCalibrateConditions(lines) {
  return (lines ?? []).filter((l) => !calibrateConditionParses(l));
}

// The criterion each readable condition line names, without applying anything. `calibrate`
// uses it to say which conditions a domain file it refused to rewrite was holding up —
// the ids are known from the line itself, while the criteria behind them are exactly what
// a file that does not parse cannot supply.
export function calibrateConditionIds(lines) {
  return (lines ?? []).map((line) => ({ line, id: parseCalibrateCondition(line)?.id ?? null })).filter((e) => e.id);
}

// Applies one calibration ruling's conditions to a domain's parsed criteria, for the
// `today` the run is happening on. A condition naming an id this domain does not hold is
// simply not this domain's business — `calibrate` applies the same condition list to
// every domain file in turn and reports the lines no domain claimed — so nothing is
// collected here beyond what was actually applied.
//
// Every verb is idempotent against a row it has already changed, because `calibrate`
// applies a ruling once and records that it did (`tests/results/<t>/applied.yaml`), and a
// re-run must not be able to undo that promise by a different route: the note is appended
// only when the row does not already carry one saying the same thing, and `spec-wrong`
// bumps the version only when the statement actually differs. Confidence is untouched by
// all three — a criterion's confidence is a claim about the evidence behind it, which a
// failing test against the old target does not change.
//
// `test-wrong` changes no criterion at all: it returns a `redo` entry the caller writes
// to `tests/acceptance/redo.yaml` (`src/spec/owed.mjs`), which is what `derive-tests
// --stale` reads to know a criterion needs its test written again even though the
// criterion itself has not moved.
export function applyCalibrateRulings(criteria, conditions, today) {
  const out = criteria.map((c) => ({ ...c, notes: [...(c.notes ?? [])] }));
  const byId = new Map(out.map((c) => [c.id, c]));
  const applied = [];
  const redo = [];

  for (const line of conditions) {
    const parsed = parseCalibrateCondition(line);
    const target = parsed ? byId.get(parsed.id) : null;
    if (!parsed || !target) continue;
    const { verb, id, text } = parsed;

    switch (verb) {
      case "defect-in-old":
        if (!target.notes.some((n) => n.endsWith(DEFECT_IN_OLD_NOTE))) target.notes.push(`calibrate ${today}: ${DEFECT_IN_OLD_NOTE}`);
        break;
      case "spec-wrong":
        if (target.statement !== text) {
          target.statement = text;
          target.version += 1;
        }
        break;
      case "test-wrong":
        // The version is the one the criterion carries now, so a `derive-tests --stale`
        // run that later acts on the entry, and the person reading the file after it,
        // both know which statement the test was judged wrong against.
        redo.push({ id, version: target.version, why: text });
        break;
    }
    // The version recorded is the one the criterion carries *after* the ruling, so a row
    // is read as ruled only while the criterion is still the one that was ruled on.
    applied.push({ line, id, verb, version: target.version });
  }

  return { criteria: out, applied, redo };
}

// The evidence a criterion rests on, as one comparable string: its statement, its
// citations, its given/when/then, the confidence those fields were graded at, its
// reconciliation class and its notes. Everything a re-recovery is asked to look at again,
// and nothing that moves for an unrelated reason — the id (`ratify` may mint it), the
// version counter and the criterion's line number in the file are all left out.
//
// `archaeology` compares this across a run — the row as `HEAD` had it against the row the
// run leaves behind — which is what tells a criterion that was recovered again from one
// that came back exactly as it went out. Fields are listed
// explicitly rather than serialised wholesale so two rows that say the same thing
// fingerprint the same regardless of which pass built them.
export function criterionFingerprint(c) {
  return JSON.stringify({
    statement: c.statement ?? "",
    cites: (c.cites ?? []).map((cite) => (cite.line !== undefined ? `${cite.path}:${cite.line}` : cite.path)),
    given: c.given ?? null,
    when: c.when ?? null,
    then: c.then ?? null,
    confidence: c.confidence ?? null,
    reconciliation: c.reconciliation ?? null,
    notes: [...(c.notes ?? [])],
  });
}

// The note a `recovery-wrong` condition leaves on the row it sends back, so the domain
// file itself says why the criterion is out for re-recovery rather than that fact living
// only in `spec/recovery.yaml`.
export const RECOVERY_NOTE_PREFIX = "sent back for re-recovery: ";

// Applies `ratify`'s gate-file conditions to a domain's parsed criteria. Every condition
// names an ID the product owner ruled on; a line this cannot parse, or whose ID is not in
// `criteria`, is reported in `unknown` rather than silently dropped — a persona's typo
// must surface somewhere a person will read it (the ratify journal), not vanish.
//
// `recovery-wrong <ID>: <what the evidence shows>` is the one verb that changes no wording:
// it marks the row as out for re-recovery (a note, and `recoveryRequests` on the criterion
// object for `ratify` to read back once ids are minted), drops a provisional row's
// confidence to `open` so it cannot mint while it is out, and leaves the correction itself
// to the next `archaeology` run for the domain. Idempotent on a row it has already marked:
// the note is pushed only when it is not already there, and the confidence it sets is the
// one the row already carries.
//
// `defect <ID>: <replacement>` is the one verb that adds a row rather than editing one:
// the old behaviour (`<ID>`) is kept, marked `reconciliation: defect`, and a new
// `authored`/`confirmed` criterion carries the corrected statement with `replaces: <ID>`.
// The old row's own confidence is also set to `confirmed` — it is a confirmed record of
// what the old system actually does, merely marked as a defect rather than carried
// forward as-is — so a `defect`ed row mints alongside its replacement in the same pass
// instead of being left `inferred`/`open` for the closing-loop sweep to reach later.
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
// `filed` is every re-recovery request already on `spec/recovery.yaml` for this domain
// (`readRecovery`), which is what tells a `recovery-wrong` condition that has already been
// carried out from one still waiting: a request carries a stamp once an archaeology run has
// answered it, and nothing else sets that. A caller with none — every caller but `ratify`,
// and every domain nothing has ever been sent back from — passes nothing and the verb
// behaves as it does the first time it is read.
export function applyConditions(criteria, conditions, filed = []) {
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
        // version every run. Confidence is set to `confirmed` every time regardless —
        // idempotent on a row already there — because the persona's deliberate
        // rewording is itself the second witness that resolves the criterion; a
        // criterion `edit`ed on a follow-up must not be left `inferred`/`open` for the
        // closing-loop sweep to force-obsolete later (see `registry.mjs`'s ratify
        // `execute`).
        if (target.statement !== text) {
          target.statement = text;
          target.version += 1;
        }
        target.confidence = "confirmed";
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
      case "recovery-wrong": {
        // The one verb that changes no wording at all, because there is no wording to
        // write: the row misreports what the old application does, so the correction has
        // to come from reading the old application again. What is recorded here is the
        // request — on the row, as a note, and on the criterion object as
        // `recoveryRequests`, which `ratify` reads after minting to write the entries
        // `archaeology` picks the work up from (`src/spec/owed.mjs`).
        //
        // A ruling is read again on every pass — a gate file is never consumed — so this
        // verb has to know when its own work is done. It is done when an archaeology run
        // has answered the request and stamped it (`answerRecoveries`,
        // `src/stages/registry.mjs`): re-applying the condition then would push the note back
        // onto a row that had been recovered again, drop it to `open`, and put it back in a
        // queue it has already left. Anything short of that stamp leaves the request
        // outstanding, including a row some other verb has since changed — an `edit` or a
        // `spike` on this criterion is not somebody going back to the old application, and
        // reading it as the answer would retire a request whose work was never done.
        if (filed.some((e) => e?.id === target.id && e?.why === text && e?.answered != null)) break;
        const note = `${RECOVERY_NOTE_PREFIX}${text}`;
        if (!target.notes.includes(note)) target.notes.push(note);
        // A provisional row is dropped to `open` so it cannot mint a permanent id while
        // its evidence is out for re-recovery; an already-minted `R-` row keeps the
        // confidence the contract already depends on, since withdrawing a permanent
        // criterion is `obsolete`'s decision to make and not this verb's.
        if (target.id.startsWith("D-")) target.confidence = "open";
        // A list, not a field: one ruling may name the same criterion twice, for two
        // different things wrong with it, and each reason is its own request owed its own
        // answer. Keeping only the last would leave the first filed nowhere, unanswerable,
        // and able to send the row back again after a recovery had already dealt with it.
        target.recoveryRequests = [...(target.recoveryRequests ?? []), text].filter((t, i, all) => all.indexOf(t) === i);
        break;
      }
      case "defect": {
        target.reconciliation = "defect";
        target.confidence = "confirmed";
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

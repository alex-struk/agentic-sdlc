import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { parseDomainFile, parseAll, writeIndex, renderSpecIndex, applyConditions, mintIds, serialiseDomainFile, domainOrdinal, conditionTargetId } from "../src/spec/criteria.mjs";
import { checkCriteria } from "../src/checks/criteria.mjs";

function repo() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-criteria-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  return d;
}

function domainsDir(d) {
  const dir = join(d, "spec", "domains");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeDomain(d, domain, text) {
  writeFileSync(join(domainsDir(d), `${domain}.md`), text);
}

// A representative, fully-populated criterion block in a generic domain (permits),
// exercising every bullet key at once; reused across several tests below.
const SAMPLE = `### D-permits-1 · v1 · inferred · recovered
When an applicant submits a completed permit application, its status shall change to
"Under review" and the assigned reviewer shall be notified.
- cites: src/lib/permits/application.ts:88
- cites: src/lib/permits/notify.ts:12
- reconciliation: implemented-only
- given: a permit application with all required fields completed
- when: the applicant submits it
- then: the application's status changes to "Under review"
- note: the old system logs this transition but has no automated test for it
`;

test("parseDomainFile: parses the sample block", () => {
  const { criteria, errors } = parseDomainFile(SAMPLE, "permits");
  assert.deepEqual(errors, []);
  assert.equal(criteria.length, 1);
  const c = criteria[0];
  assert.equal(c.id, "D-permits-1");
  assert.equal(c.version, 1);
  assert.equal(c.confidence, "inferred");
  assert.equal(c.origin, "recovered");
  assert.match(c.statement, /^When an applicant submits a completed permit application/);
  assert.ok(!c.statement.includes("\n"), "the statement is one joined line, not the raw source lines");
  assert.deepEqual(c.cites, [
    { path: "src/lib/permits/application.ts", line: 88 },
    { path: "src/lib/permits/notify.ts", line: 12 },
  ]);
  assert.equal(c.reconciliation, "implemented-only");
  assert.equal(c.given, "a permit application with all required fields completed");
  assert.equal(c.when, "the applicant submits it");
  assert.equal(c.then, "the application's status changes to \"Under review\"");
  assert.deepEqual(c.notes, ["the old system logs this transition but has no automated test for it"]);
  assert.equal(c.state, "proposed", "state defaults to proposed when the bullet is absent");
  assert.equal(c.line, 1);
  assert.match(c.raw, /^### D-permits-1 · v1 · inferred · recovered$/);
});

test("parseDomainFile: the plain-hyphen separator is accepted", () => {
  const text = "### D-permits-2 - v1 - confirmed - authored\nA plain statement.\n";
  const { criteria, errors } = parseDomainFile(text, "permits");
  assert.deepEqual(errors, []);
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0].id, "D-permits-2");
  assert.match(criteria[0].raw, /·/, "raw normalises the separator to the middle dot on write");
});

test("parseDomainFile: a separator missing its space on one side is a malformed heading", () => {
  const text = "### D-permits-1 ·v1 · confirmed · authored\nA statement.\n";
  const { criteria, errors } = parseDomainFile(text, "permits");
  assert.equal(criteria.length, 0);
  assert.ok(errors.some((e) => e.line === 1 && /malformed heading/.test(e.message)));
});

test("parseDomainFile: a separator with no spaces at all is a malformed heading, not a loose match", () => {
  const text = "### D-permits-1-v1-confirmed-authored\nA statement.\n";
  const { criteria, errors } = parseDomainFile(text, "permits");
  assert.equal(criteria.length, 0);
  assert.ok(errors.some((e) => e.line === 1 && /malformed heading/.test(e.message)));
});

test("parseDomainFile: three-criterion round trip", () => {
  const text = `### D-permits-1 · v1 · confirmed · authored
The permit office accepts a new application only when every required field is present.
- reconciliation: aligned
- given: a permit application missing a required field
- when: the applicant attempts to submit it
- then: the submission is rejected with the missing field named

### D-permits-2 · v2 · confirmed · recovered
An approved permit is visible to the applicant on their dashboard.
- cites: src/lib/permits/dashboard.ts:41
- reconciliation: aligned
- state: accepted

### D-permits-3 · v1 · open · authored
A permit nearing its expiry date sends a renewal reminder.
- reconciliation: documented-only
- note: timing of the reminder is still under discussion
`;
  const { criteria, errors } = parseDomainFile(text, "permits");
  assert.deepEqual(errors, []);
  assert.equal(criteria.length, 3);
  assert.deepEqual(criteria.map((c) => c.id), ["D-permits-1", "D-permits-2", "D-permits-3"]);
  assert.equal(criteria[1].version, 2);
  assert.equal(criteria[1].state, "accepted");
  assert.equal(criteria[2].confidence, "open");
});

test("parseDomainFile: repeated given/when/then join with 'and'; notes collect", () => {
  const text = `### D-permits-1 · v1 · confirmed · authored
Two conditions both hold.
- given: the applicant is signed in
- given: the applicant has a draft application
- then: the draft is listed
- then: the draft is editable
- note: first note
- note: second note
`;
  const { criteria } = parseDomainFile(text, "permits");
  assert.equal(criteria[0].given, "the applicant is signed in and the applicant has a draft application");
  assert.equal(criteria[0].then, "the draft is listed and the draft is editable");
  assert.deepEqual(criteria[0].notes, ["first note", "second note"]);
});

test("parseDomainFile: a malformed heading is an error but later criteria still parse", () => {
  const text = `### not a heading at all\nfoo\n### D-permits-1 · v1 · confirmed · authored\nA fine statement.\n`;
  const { criteria, errors } = parseDomainFile(text, "permits");
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0].id, "D-permits-1");
  assert.ok(errors.length >= 1);
  assert.ok(errors.some((e) => e.line === 1));
});

test("parseDomainFile: an unknown bullet key is an error", () => {
  const text = `### D-permits-1 · v1 · confirmed · authored\nA statement.\n- unknown-key: something\n`;
  const { criteria, errors } = parseDomainFile(text, "permits");
  assert.equal(criteria.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /unknown key: unknown-key/);
});

test("parseDomainFile: state, reconciliation and tier are validated against closed vocabularies", () => {
  const text = `### D-permits-1 · v1 · confirmed · authored
A statement.
- state: bogus
- reconciliation: not-a-value
- tier: EXTREME
`;
  const { criteria, errors } = parseDomainFile(text, "permits");
  assert.equal(criteria.length, 1, "still parsed, so the bad values are reported rather than swallowing the criterion");
  assert.equal(criteria[0].state, "proposed", "an invalid state is not assigned; it falls back to the default like an absent bullet");
  assert.equal(criteria[0].reconciliation, undefined);
  assert.equal(criteria[0].tier, undefined);
  assert.equal(errors.length, 3);
  assert.match(errors[0].message, /invalid state: bogus/);
  assert.match(errors[1].message, /invalid reconciliation: not-a-value/);
  assert.match(errors[2].message, /invalid tier: EXTREME/);
});

test("parseDomainFile: obsolete is a valid state", () => {
  const text = "### D-permits-1 · v1 · confirmed · authored\nA statement.\n- state: obsolete\n";
  const { criteria, errors } = parseDomainFile(text, "permits");
  assert.deepEqual(errors, []);
  assert.equal(criteria[0].state, "obsolete");
});

test("parseDomainFile: a repeated single-value key is a parse error; the first occurrence wins", () => {
  const text = `### D-permits-1 · v1 · confirmed · authored
A statement.
- state: accepted
- state: proposed
`;
  const { criteria, errors } = parseDomainFile(text, "permits");
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0].state, "accepted", "the repeat is flagged, not silently applied over the first value");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /repeated key: state/);
});

test("parseDomainFile: a title and prose before the first ### block are ignored, not errors", () => {
  const text = `# Permits domain

A short introduction to this domain, written before any criterion block.

### D-permits-1 · v1 · confirmed · authored
A statement.
`;
  const { criteria, errors } = parseDomainFile(text, "permits");
  assert.deepEqual(errors, []);
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0].id, "D-permits-1");
});

test("parseDomainFile: a D- heading whose domain does not match the file is an error", () => {
  const text = "### D-other-1 · v1 · confirmed · authored\nA statement.\n";
  const { criteria, errors } = parseDomainFile(text, "permits");
  assert.equal(criteria.length, 1, "still parsed, so the mismatch is reported rather than swallowing the criterion");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /domain "other".*not "permits"/);
});

test("parseAll: reads every *.md under spec/domains, domain = file basename", () => {
  const d = repo();
  writeDomain(d, "permits", "### D-permits-1 · v1 · confirmed · authored\nA statement.\n");
  writeDomain(d, "renewals", "### D-renewals-1 · v1 · confirmed · authored\nAnother statement.\n- unknown-key: x\n");
  const { domains, errors } = parseAll(d);
  assert.deepEqual(Object.keys(domains).sort(), ["permits", "renewals"]);
  assert.equal(domains.permits.length, 1);
  assert.equal(domains.renewals.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, "spec/domains/renewals.md");
});

test("parseAll: no spec/domains directory yields an empty result, not a throw", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-criteria-empty-"));
  assert.deepEqual(parseAll(d), { domains: {}, errors: [] });
});

test("parseDomainFile: without an ordinal argument, an R- id of any ordinal is accepted (usable without a config)", () => {
  const { criteria, errors } = parseDomainFile("### R-99.1 · v1 · confirmed · authored\nNo ordinal to check against.\n", "permits");
  assert.deepEqual(errors, []);
  assert.equal(criteria[0].id, "R-99.1");
});

test("parseDomainFile: an R- id whose ordinal does not match the one given is an error", () => {
  const { criteria, errors } = parseDomainFile("### R-2.1 · v1 · confirmed · authored\nWrong ordinal for this file.\n", "permits", 1);
  assert.equal(criteria.length, 1, "still parsed, so the mismatch is reported rather than swallowing the criterion");
  assert.ok(errors.some((e) => /belongs to domain ordinal 2, not 1/.test(e.message)));
});

test("parseAll: when a config is present, an R- id whose ordinal does not match its domain's position in project.domains is an error", () => {
  const d = repo();
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "config.yaml"), "profile: rebuild\nproject: { name: p, domains: [permits, renewals] }\n");
  writeDomain(d, "permits", "### R-2.1 · v1 · confirmed · authored\nMinted under the wrong ordinal.\n");
  const { errors } = parseAll(d);
  assert.ok(errors.some((e) => e.file === "spec/domains/permits.md" && /belongs to domain ordinal 2, not 1/.test(e.message)));
});

test("parseAll: a domain not listed in project.domains gets no ordinal check at all", () => {
  const d = repo();
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "config.yaml"), "profile: rebuild\nproject: { name: p, domains: [permits] }\n");
  writeDomain(d, "renewals", "### R-99.1 · v1 · confirmed · authored\nrenewals is not in project.domains.\n");
  const { errors } = parseAll(d);
  assert.deepEqual(errors, []);
});

test("domainOrdinal: a domain's 1-based position in project.domains, or undefined when there is no config or the domain is not listed", () => {
  const d = repo();
  assert.equal(domainOrdinal(d, "fees"), undefined, "no .sdlc/config.yaml at all yet");
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "config.yaml"), "profile: rebuild\nproject: { name: p, domains: [applications, fees] }\n");
  assert.equal(domainOrdinal(d, "applications"), 1);
  assert.equal(domainOrdinal(d, "fees"), 2);
  assert.equal(domainOrdinal(d, "renewals"), undefined, "not in project.domains");
});

test("conditionTargetId: the id every ratification verb names, and null for a line the grammar cannot read at all", () => {
  assert.equal(conditionTargetId("confirm D-fees-2"), "D-fees-2");
  assert.equal(conditionTargetId("edit R-1.1: a corrected statement"), "R-1.1");
  assert.equal(conditionTargetId("defect D-permits-1: the old system does this"), "D-permits-1");
  assert.equal(conditionTargetId("obsolete D-permits-2: no longer needed"), "D-permits-2");
  assert.equal(conditionTargetId("spike D-permits-3: does this hold on renewal?"), "D-permits-3");
  assert.equal(conditionTargetId("please just drop the second one"), null);
});

test("writeIndex: deterministic ordering (domain, then id numeric) and no timestamps", () => {
  const d = repo();
  writeDomain(d, "b-domain", "### D-b-domain-10 · v1 · confirmed · authored\nTen.\n\n### D-b-domain-2 · v1 · confirmed · authored\nTwo.\n");
  writeDomain(d, "a-domain", "### D-a-domain-1 · v1 · confirmed · authored\nOne.\n");
  const parsed = parseAll(d);
  const path = writeIndex(d, parsed);
  const index = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(index.criteria.map((c) => c.id), ["D-a-domain-1", "D-b-domain-2", "D-b-domain-10"],
    "a-domain sorts before b-domain, and within b-domain id 2 sorts before id 10 (numeric, not lexical)");
  for (const c of index.criteria) {
    assert.equal(c.domain, c.id.match(/^D-(.+)-\d+$/)[1]);
    assert.equal(c.file, `spec/domains/${c.domain}.md`);
    assert.ok(Number.isInteger(c.line));
  }
  assert.ok(!("generated_at" in index), "no timestamp field anywhere in the index");
  assert.ok(!JSON.stringify(index).match(/\d{4}-\d{2}-\d{2}T/), "no ISO timestamp anywhere in the index");
});

test("writeIndex: generated_from is the git HEAD, empty when there is no commit yet", () => {
  const d = repo();
  writeDomain(d, "permits", "### D-permits-1 · v1 · confirmed · authored\nA statement.\n");
  const parsed = parseAll(d);
  const before = JSON.parse(readFileSync(writeIndex(d, parsed), "utf8"));
  assert.equal(before.generated_from, "", "no commits yet");
  git(["add", "-A"], d); git(["commit", "-q", "-m", "first"], d);
  const head = git(["rev-parse", "HEAD"], d);
  const after = JSON.parse(readFileSync(writeIndex(d, parsed), "utf8"));
  assert.equal(after.generated_from, head);
});

test("writeIndex: two runs on unchanged input produce identical bytes", () => {
  const d = repo();
  writeDomain(d, "permits", "### D-permits-1 · v1 · confirmed · authored\nA statement.\n");
  const parsed = parseAll(d);
  const path = writeIndex(d, parsed);
  const first = readFileSync(path, "utf8");
  writeIndex(d, parseAll(d));
  const second = readFileSync(path, "utf8");
  assert.equal(second, first);
});

test("renderSpecIndex: domains ordered by config.project.domains; falls back to alphabetical", () => {
  const d = repo();
  writeDomain(d, "renewals", "### D-renewals-1 · v1 · confirmed · authored\nRenewal criterion.\n");
  writeDomain(d, "permits", "### D-permits-1 · v1 · confirmed · authored\nPermit criterion.\n");

  // No config: falls back to alphabetical (permits, renewals).
  let text = readFileSync(renderSpecIndex(d, parseAll(d)), "utf8");
  assert.ok(text.indexOf("## permits") < text.indexOf("## renewals"));

  // Config says renewals before permits: that order wins even though it is not alphabetical.
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "config.yaml"), "profile: rebuild\nproject: { name: p, domains: [renewals, permits] }\n");
  text = readFileSync(renderSpecIndex(d, parseAll(d)), "utf8");
  assert.ok(text.indexOf("## renewals") < text.indexOf("## permits"));
});

test("renderSpecIndex: one table per domain, ids sorted numerically, and coverage counts per state", () => {
  const d = repo();
  writeDomain(d, "permits", `### D-permits-2 · v1 · confirmed · authored
Second criterion.
- state: accepted

### D-permits-1 · v1 · confirmed · authored
First criterion.
- state: proposed
`);
  const text = readFileSync(renderSpecIndex(d, parseAll(d)), "utf8");
  assert.match(text, /generated by `sdlc run ratify`/i);
  const iOne = text.indexOf("D-permits-1");
  const iTwo = text.indexOf("D-permits-2");
  assert.ok(iOne > 0 && iTwo > 0 && iOne < iTwo, "ids within a domain are ordered numerically");
  assert.match(text, /\| proposed \| 1 \|/);
  assert.match(text, /\| accepted \| 1 \|/);
  assert.match(text, /\| implemented \| 0 \|/);
});

test("renderSpecIndex: a `|` in a statement is escaped, not left to split the table row", () => {
  const d = repo();
  writeDomain(d, "permits", `### D-permits-1 · v1 · confirmed · authored
A permit is either "Approved" | "Denied" once reviewed.
- reconciliation: aligned
`);
  const text = readFileSync(renderSpecIndex(d, parseAll(d)), "utf8");
  const row = text.split("\n").find((l) => l.includes("D-permits-1"));
  assert.equal(row, `| D-permits-1 | 1 | confirmed | proposed | A permit is either "Approved" \\| "Denied" once reviewed. |`);
  // 5 columns means 4 unescaped separators between them plus the leading/trailing border —
  // splitting on a bare `|` (one not preceded by `\`) must yield exactly 6 pieces.
  assert.equal(row.split(/(?<!\\)\|/).length, 7);
});

// --- checkCriteria ---------------------------------------------------------

test("checkCriteria: a well-formed domain with cites resolving under sources/old passes clean", () => {
  const d = repo();
  writeDomain(d, "permits", `### D-permits-1 · v1 · confirmed · recovered
A clean criterion.
- cites: app.js:10
- reconciliation: aligned
`);
  mkdirSync(join(d, "sources", "old"), { recursive: true });
  writeFileSync(join(d, "sources", "old", "app.js"), "// old app\n");
  const r = checkCriteria(d, {});
  assert.equal(r.ok, true, r.messages.join("\n"));
  assert.deepEqual(r.warnings, []);
});

test("checkCriteria: a parse error fails the check", () => {
  const d = repo();
  writeDomain(d, "permits", "### D-permits-1 · v1 · confirmed · authored\nA statement.\n- unknown-key: x\n");
  const r = checkCriteria(d, {});
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("unknown key: unknown-key")));
});

test("checkCriteria: the same ID in two domain files is a duplicate", () => {
  const d = repo();
  writeDomain(d, "permits", "### D-permits-1 · v1 · confirmed · authored\nOne statement.\n");
  writeDomain(d, "renewals", "### D-permits-1 · v1 · confirmed · authored\nA colliding ID, wrong domain even, but the point is the duplicate.\n");
  const r = checkCriteria(d, {});
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("duplicate id D-permits-1")));
});

test("checkCriteria: a recovered criterion with no cites fails", () => {
  const d = repo();
  writeDomain(d, "permits", "### D-permits-1 · v1 · confirmed · recovered\nNo citation given.\n- reconciliation: aligned\n");
  const r = checkCriteria(d, {});
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("recovered but has no cites")));
});

test("checkCriteria: a cites path missing under sources/old fails when sources/old exists", () => {
  const d = repo();
  writeDomain(d, "permits", "### D-permits-1 · v1 · confirmed · recovered\nCites something absent.\n- cites: nope.js:1\n");
  mkdirSync(join(d, "sources", "old"), { recursive: true });
  writeFileSync(join(d, "sources", "old", "README.md"), "present, but nope.js is not\n");
  const r = checkCriteria(d, {});
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("nope.js") && m.includes("does not exist under sources/old")));
});

test("checkCriteria: a cites path is only a warning when sources/old does not exist at all", () => {
  const d = repo();
  writeDomain(d, "permits", "### D-permits-1 · v1 · confirmed · recovered\nCites something, but there is no sources/old to check it against.\n- cites: whatever.js:1\n");
  const r = checkCriteria(d, {});
  assert.equal(r.ok, true, r.messages.join("\n"));
  assert.ok(r.warnings.some((w) => w.includes("whatever.js") && w.includes("sources/old is not present")));
});

test("checkCriteria: accepted while still inferred or open fails", () => {
  const d = repo();
  writeDomain(d, "permits", "### D-permits-1 · v1 · inferred · authored\nStill inferred but marked accepted.\n- state: accepted\n");
  const r = checkCriteria(d, {});
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("accepted while still inferred")));
});

test("checkCriteria: a defect reconciliation needs a replaces or a note saying there is none", () => {
  const d = repo();
  writeDomain(d, "permits", "### D-permits-1 · v1 · confirmed · authored\nA defect with nothing to explain it.\n- reconciliation: defect\n");
  let r = checkCriteria(d, {});
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("defect reconciliation has no replaces")));

  writeDomain(d, "permits", "### D-permits-1 · v1 · confirmed · authored\nA defect with a replacement.\n- reconciliation: defect\n- replaces: D-permits-9\n");
  r = checkCriteria(d, {});
  assert.equal(r.ok, true, r.messages.join("\n"));

  writeDomain(d, "permits", "### D-permits-1 · v1 · confirmed · authored\nA defect with no replacement yet.\n- reconciliation: defect\n- note: no replacement has been drafted yet\n");
  r = checkCriteria(d, {});
  assert.equal(r.ok, true, r.messages.join("\n"));
});

test("checkCriteria: a heading ID whose domain does not match its file fails", () => {
  const d = repo();
  writeDomain(d, "permits", "### D-renewals-1 · v1 · confirmed · authored\nWrong domain in the ID.\n");
  const r = checkCriteria(d, {});
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("belongs to domain \"renewals\"")));
});

// --- applyConditions --------------------------------------------------------

test("applyConditions: contract is a no-op marker, still recorded as applied", () => {
  const { criteria } = parseDomainFile("### D-permits-1 · v1 · confirmed · authored\nA statement.\n", "permits");
  const { criteria: out, applied, unknown } = applyConditions(criteria, ["contract D-permits-1"]);
  assert.deepEqual(unknown, []);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].verb, "contract");
  assert.deepEqual(out, criteria);
});

test("applyConditions: confirm upgrades confidence to confirmed", () => {
  const { criteria } = parseDomainFile("### D-permits-1 · v1 · inferred · authored\nA statement.\n", "permits");
  const { criteria: out, applied } = applyConditions(criteria, ["confirm D-permits-1"]);
  assert.equal(out[0].confidence, "confirmed");
  assert.equal(applied[0].verb, "confirm");
});

test("applyConditions: edit replaces the statement and bumps the version", () => {
  const { criteria } = parseDomainFile("### D-permits-1 · v1 · confirmed · authored\nOld statement.\n", "permits");
  const { criteria: out } = applyConditions(criteria, ["edit D-permits-1: A corrected statement."]);
  assert.equal(out[0].statement, "A corrected statement.");
  assert.equal(out[0].version, 2);
});

test("applyConditions: edit raises confidence to confirmed, the same as confirm — the deliberate rewording is the second witness", () => {
  const { criteria } = parseDomainFile("### D-permits-1 · v1 · inferred · authored\nOld statement.\n", "permits");
  const { criteria: out } = applyConditions(criteria, ["edit D-permits-1: A corrected statement."]);
  assert.equal(out[0].confidence, "confirmed");

  const { criteria: openCriteria } = parseDomainFile("### D-permits-1 · v1 · open · authored\nOld statement.\n", "permits");
  const { criteria: openOut } = applyConditions(openCriteria, ["edit D-permits-1: A corrected statement."]);
  assert.equal(openOut[0].confidence, "confirmed");
});

test("applyConditions: edit works on a permanent R- id, not just a provisional D- one, and is idempotent against a row it already edited", () => {
  const { criteria } = parseDomainFile("### R-1.1 · v1 · confirmed · recovered\nOld statement.\n- state: accepted\n", "applications", 1);
  const { criteria: out } = applyConditions(criteria, ["edit R-1.1: A corrected statement."]);
  assert.equal(out[0].statement, "A corrected statement.");
  assert.equal(out[0].version, 2);
  assert.equal(out[0].confidence, "confirmed");

  // Replaying the same condition against the row it already edited must not bump the
  // version a second time — the same content comparison that keeps a D- id's edit
  // idempotent (see the test above) applies here too, since `applyConditions` never
  // branches on which id prefix it is looking at.
  const { criteria: replayed } = applyConditions(out, ["edit R-1.1: A corrected statement."]);
  assert.equal(replayed[0].version, 2, "no second bump — the statement already matches");
});

test("applyConditions: obsolete and drop both set state obsolete with a note recording why", () => {
  const { criteria: c1 } = parseDomainFile("### D-permits-1 · v1 · confirmed · authored\nA statement.\n", "permits");
  const { criteria: out1 } = applyConditions(c1, ["obsolete D-permits-1: no longer needed"]);
  assert.equal(out1[0].state, "obsolete");
  assert.deepEqual(out1[0].notes, ["no longer needed"]);

  const { criteria: c2 } = parseDomainFile("### D-permits-2 · v1 · confirmed · authored\nAnother.\n", "permits");
  const { criteria: out2 } = applyConditions(c2, ["drop D-permits-2: superseded by a policy change"]);
  assert.equal(out2[0].state, "obsolete");
  assert.deepEqual(out2[0].notes, ["superseded by a policy change"]);
});

test("applyConditions: spike downgrades confidence to open with the question recorded as a note", () => {
  const { criteria } = parseDomainFile("### D-permits-1 · v1 · confirmed · authored\nA statement.\n", "permits");
  const { criteria: out } = applyConditions(criteria, ["spike D-permits-1: does this hold for renewals too?"]);
  assert.equal(out[0].confidence, "open");
  assert.deepEqual(out[0].notes, ["does this hold for renewals too?"]);
});

test("applyConditions: defect keeps the old row, marks it, and appends a replacement continuing the domain's own numbering", () => {
  const { criteria } = parseDomainFile(`### D-permits-1 · v1 · confirmed · recovered
The fee is fixed at intake.
- cites: app.js:1

### D-permits-2 · v1 · confirmed · recovered
Something unrelated.
- cites: app.js:2
`, "permits");
  const { criteria: out, applied, unknown } = applyConditions(criteria,
    ["defect D-permits-1: the fee is recalculated when the application is edited"]);
  assert.deepEqual(unknown, []);
  assert.equal(out.length, 3);
  const original = out.find((c) => c.id === "D-permits-1");
  assert.equal(original.reconciliation, "defect");
  assert.equal(original.confidence, "confirmed", "a defect row is a confirmed record of current behaviour");
  const addition = out.find((c) => c.id === "D-permits-3");
  assert.ok(addition, "the replacement's provisional id continues from the highest id already in the domain (2), not from 1");
  assert.equal(addition.origin, "authored");
  assert.equal(addition.confidence, "confirmed");
  assert.equal(addition.state, "proposed");
  assert.equal(addition.replaces, "D-permits-1");
  assert.equal(addition.statement, "the fee is recalculated when the application is edited");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].verb, "defect");
});

test("applyConditions: defect raises an inferred/open target's confidence to confirmed, not just a confirmed one's", () => {
  const { criteria: inferredCriteria } = parseDomainFile(
    "### D-permits-1 · v1 · inferred · recovered\nThe fee is fixed at intake.\n- cites: app.js:1\n", "permits");
  const { criteria: inferredOut } = applyConditions(inferredCriteria,
    ["defect D-permits-1: the fee is recalculated when the application is edited"]);
  assert.equal(inferredOut.find((c) => c.id === "D-permits-1").confidence, "confirmed");

  const { criteria: openCriteria } = parseDomainFile(
    "### D-permits-1 · v1 · open · recovered\nThe fee is fixed at intake.\n- cites: app.js:1\n", "permits");
  const { criteria: openOut } = applyConditions(openCriteria,
    ["defect D-permits-1: the fee is recalculated when the application is edited"]);
  assert.equal(openOut.find((c) => c.id === "D-permits-1").confidence, "confirmed");
});

test("applyConditions: defect on a target with no note gives it one and points superseded-by at the replacement, satisfying checkCriteria", () => {
  const { criteria } = parseDomainFile(`### D-permits-1 · v1 · confirmed · recovered
The fee is fixed at intake.
- cites: app.js:1
`, "permits");
  const { criteria: out } = applyConditions(criteria,
    ["defect D-permits-1: the fee is recalculated when the application is edited"]);
  const target = out.find((c) => c.id === "D-permits-1");
  assert.equal(target.reconciliation, "defect");
  assert.ok(target.notes.length > 0, "a note is added, so a defect target that arrived with none still satisfies checkCriteria");
  const addition = out.find((c) => c.id !== "D-permits-1");
  assert.equal(target.supersededBy, addition.id);
  assert.ok(target.notes[0].includes(addition.id), "the note names the replacement");

  const d = repo();
  writeDomain(d, "permits", serialiseDomainFile(out, "permits"));
  const r = checkCriteria(d, {});
  assert.equal(r.ok, true, r.messages.join("\n"));
});

test("applyConditions + mintIds: replaying spike, edit and defect conditions three times settles after one pass — edit and defect mint immediately (they resolve confidence), spike's target stays D- (never confirmed) and its condition keeps applying idempotently", () => {
  let text = `### D-x-1 · v1 · inferred · authored
Statement to edit.

### D-x-2 · v1 · open · authored
Statement to spike.
- note: initial

### D-x-3 · v1 · inferred · recovered
Statement to defect.
- cites: app.js:1
`;
  const conditions = [
    "edit D-x-1: A corrected statement.",
    "spike D-x-2: does this hold for renewals too?",
    "defect D-x-3: the fee is recalculated when the application is edited",
  ];
  const textByPass = [];
  for (let pass = 0; pass < 3; pass++) {
    const { criteria, errors } = parseDomainFile(text, "x");
    assert.deepEqual(errors, [], `pass ${pass}: domain file still parses`);
    const { criteria: withConditions } = applyConditions(criteria, conditions);
    let existingMax = 0;
    const re = /^R-1\.(\d+)$/;
    for (const c of withConditions) { const m = re.exec(c.id); if (m) existingMax = Math.max(existingMax, Number(m[1])); }
    const minted = mintIds(withConditions, 1, existingMax);
    text = serialiseDomainFile(minted, "x");
    textByPass.push(text);
  }
  assert.equal(textByPass[1], textByPass[0], "pass 2 leaves the file exactly as pass 1 wrote it");
  assert.equal(textByPass[2], textByPass[0], "pass 3 leaves the file exactly as pass 1 wrote it");
  const { criteria: final } = parseDomainFile(text, "x");

  assert.ok(!final.some((c) => c.id.startsWith("D-x-1") || c.id.startsWith("D-x-3")),
    "edit and defect both raise confidence to confirmed, so their targets mint to R- ids on the first pass rather than staying D-");

  const edited = final.find((c) => c.statement === "A corrected statement.");
  assert.ok(edited, "the edited criterion, now under its minted id");
  assert.equal(edited.confidence, "confirmed");
  assert.equal(edited.version, 2, "edited exactly once across three passes, not bumped again each time");

  const spiked = final.find((c) => c.id === "D-x-2");
  assert.ok(spiked, "spike never raises confidence, so its target is never eligible to mint and keeps its D- id");
  assert.equal(spiked.confidence, "open");
  assert.deepEqual(spiked.notes, ["initial", "does this hold for renewals too?"], "the spike note appears exactly once, replayed idempotently every pass");

  const replacements = final.filter((c) => c.statement === "the fee is recalculated when the application is edited");
  assert.equal(replacements.length, 1, "defect appended exactly one replacement across three passes");
  const defectTarget = final.find((c) => c.statement === "Statement to defect.");
  assert.ok(defectTarget, "the defect target, now under its minted id");
  assert.equal(defectTarget.reconciliation, "defect");
  assert.equal(defectTarget.confidence, "confirmed");
  assert.equal(defectTarget.notes.length, 1, "the defect target carries exactly one note across three passes");
});

test("applyConditions: a multi-line condition value cannot inject a bullet into the domain file", () => {
  const { criteria } = parseDomainFile("### D-permits-1 · v1 · confirmed · authored\nA statement.\n", "permits");
  const injected = "spike D-permits-1: q\n- tier: CRITICAL";
  const { criteria: out, unknown } = applyConditions(criteria, [injected]);
  assert.deepEqual(unknown, [injected], "a value with an embedded newline and more content after it fails to parse as any verb");
  assert.equal(out[0].tier, undefined, "no tier bullet was created");
  assert.deepEqual(out[0].notes, [], "no note was created from the injected line either");
});

test("applyConditions: internal whitespace in a condition's captured text is collapsed to single spaces", () => {
  const { criteria } = parseDomainFile("### D-permits-1 · v1 · confirmed · authored\nA statement.\n", "permits");
  const { criteria: out } = applyConditions(criteria, ["edit D-permits-1: A   corrected\tstatement."]);
  assert.equal(out[0].statement, "A corrected statement.");
});

test("applyConditions: an id that does not exist in this domain is reported as unknown, not applied", () => {
  const { criteria } = parseDomainFile("### D-permits-1 · v1 · inferred · authored\nA statement.\n", "permits");
  const { criteria: out, applied, unknown } = applyConditions(criteria, ["confirm D-permits-9"]);
  assert.deepEqual(applied, []);
  assert.deepEqual(unknown, ["confirm D-permits-9"]);
  assert.equal(out[0].confidence, "inferred", "the one real criterion in the domain is untouched");
});

test("applyConditions: a line that does not parse as any known verb is reported as unknown", () => {
  const { criteria } = parseDomainFile("### D-permits-1 · v1 · confirmed · authored\nA statement.\n", "permits");
  const { unknown } = applyConditions(criteria, ["edit D-permits-1 missing the colon", "bogus D-permits-1: whatever"]);
  assert.deepEqual(unknown, ["edit D-permits-1 missing the colon", "bogus D-permits-1: whatever"]);
});

// --- mintIds -----------------------------------------------------------------

test("mintIds: mints R-<ordinal>.<n> for confirmed, non-obsolete D- criteria; inferred and obsolete stay D-", () => {
  const { criteria } = parseDomainFile(`### D-permits-1 · v1 · confirmed · authored
First.

### D-permits-2 · v1 · inferred · authored
Second, still inferred.

### D-permits-3 · v1 · confirmed · authored
Third, but already obsolete.
- state: obsolete
`, "permits");
  const out = mintIds(criteria, 2, 0);
  assert.equal(out[0].id, "R-2.1");
  assert.equal(out[0].state, "accepted");
  assert.equal(out[1].id, "D-permits-2", "still inferred, so it stays provisional");
  assert.equal(out[1].state, "proposed");
  assert.equal(out[2].id, "D-permits-3", "obsolete is never minted even though it is confirmed");
  assert.equal(out[2].state, "obsolete");
});

test("mintIds: numbering continues from existingMax rather than restarting at 1", () => {
  const { criteria } = parseDomainFile("### D-permits-5 · v1 · confirmed · authored\nFifth.\n", "permits");
  const out = mintIds(criteria, 3, 4);
  assert.equal(out[0].id, "R-3.5");
});

test("mintIds: a replaces reference is rewritten to the new id when both are minted in the same pass", () => {
  const { criteria } = parseDomainFile(`### D-permits-1 · v1 · confirmed · recovered
Old behaviour.
- cites: app.js:1
- reconciliation: defect

### D-permits-2 · v1 · confirmed · authored
Corrected behaviour.
- replaces: D-permits-1
`, "permits");
  const out = mintIds(criteria, 1, 0);
  const replacement = out.find((c) => c.statement === "Corrected behaviour.");
  assert.equal(replacement.replaces, "R-1.1", "rewritten to the id its target was just minted to");
});

test("mintIds: a replaces reference to an id not minted in this pass is left as written", () => {
  const { criteria } = parseDomainFile(`### D-permits-2 · v1 · confirmed · authored
Corrected behaviour, replacing something already ratified on an earlier run.
- replaces: R-1.9
`, "permits");
  const out = mintIds(criteria, 1, 9);
  const replacement = out.find((c) => c.statement.startsWith("Corrected behaviour"));
  assert.equal(replacement.replaces, "R-1.9");
});

// --- serialiseDomainFile -----------------------------------------------------

test("serialiseDomainFile: round trip — parse, serialise, parse yields equal objects", () => {
  const text = `### D-permits-1 · v1 · inferred · recovered
When an applicant submits a completed permit application, its status shall change to "Under review" and the assigned reviewer shall be notified.
- cites: src/lib/permits/application.ts:88
- cites: src/lib/permits/notify.ts:12
- reconciliation: implemented-only
- given: a permit application with all required fields completed
- when: the applicant submits it
- then: the application's status changes to "Under review"
- note: the old system logs this transition but has no automated test for it

### R-1.2 · v2 · confirmed · authored
A second criterion with a replaces reference and no cites.
- reconciliation: aligned
- state: accepted
- replaces: D-permits-9
`;
  const { criteria: first, errors: firstErrors } = parseDomainFile(text, "permits");
  assert.deepEqual(firstErrors, []);
  const serialised = serialiseDomainFile(first, "permits");
  const { criteria: second, errors: secondErrors } = parseDomainFile(serialised, "permits");
  assert.deepEqual(secondErrors, []);
  // `raw` and `line` are positional/textual artifacts of where a heading landed in the
  // source, not part of what the criterion means, so the round trip is judged on
  // everything else.
  const strip = (c) => { const { raw, line, ...rest } = c; return rest; };
  assert.deepEqual(second.map(strip), first.map(strip));
});

test("parseDomainFile captures everything above the first block as the preamble", () => {
  const text = "# billing\n\nRecovered from the ledger service.\n\n### D-billing-1 · v1 · confirmed · recovered\nA statement.\n- cites: a.js\n- state: proposed\n";
  const { preamble, criteria } = parseDomainFile(text, "billing");
  assert.equal(preamble, "# billing\n\nRecovered from the ledger service.\n\n");
  assert.equal(criteria.length, 1);
});

test("parseDomainFile: a file with no blocks at all is all preamble", () => {
  const { preamble, criteria } = parseDomainFile("# billing\n\nnothing recovered yet\n", "billing");
  assert.equal(preamble, "# billing\n\nnothing recovered yet\n");
  assert.equal(criteria.length, 0);
});

test("serialiseDomainFile writes the preamble back verbatim and round-trips", () => {
  const text = "# billing\n\n> a blockquote\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n### D-billing-1 · v1 · confirmed · recovered\nA statement.\n- cites: a.js\n- state: proposed\n";
  const { criteria, preamble } = parseDomainFile(text, "billing");
  const out = serialiseDomainFile(criteria, "billing", preamble);
  assert.equal(out, text);
  assert.equal(parseDomainFile(out, "billing").preamble, preamble);
});

test("serialiseDomainFile without a preamble keeps the minimal title it always wrote", () => {
  const { criteria } = parseDomainFile("### D-billing-1 · v1 · confirmed · recovered\nA statement.\n- state: proposed\n", "billing");
  assert.ok(serialiseDomainFile(criteria, "billing").startsWith("# billing\n\n### D-billing-1"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { parseDomainFile, parseAll, writeIndex, renderSpecIndex } from "../src/spec/criteria.mjs";
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

// The sample block from the brief, restated in a generic domain (permits, not
// procurement) so nothing here names a real system.
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

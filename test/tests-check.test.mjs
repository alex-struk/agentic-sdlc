import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { checkTests, coverage } from "../src/checks/tests.mjs";
import { checkGenerated } from "../src/checks/generated.mjs";
import { writeGenerated } from "../src/spec/surface.mjs";

function project() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-tests-check-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  return d;
}

// A plain temp directory, deliberately never `git init`-ed — for the case where a project
// is not a git repository at all.
function nonRepoProject() {
  return mkdtempSync(join(tmpdir(), "sdlc-tests-check-nogit-"));
}

function write(dir, relPath, text) {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
}

function commit(dir, message) {
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", message], dir);
}

function writeIndex(dir, criteria) {
  write(dir, "spec/criteria-index.json", `${JSON.stringify({ generated_from: "0000000", criteria }, null, 2)}\n`);
}

// One accepted, STANDARD-tier criterion, ready for a spec file to reference.
const R11 = { id: "R-1.1", version: 1, confidence: "confirmed", origin: "authored",
  statement: "A vendor can view a published opportunity.", state: "accepted", tier: "STANDARD", domain: "opportunities", file: "spec/domains/opportunities.md" };

const CONFIG_STANDARD = { policy: { default_tier: "STANDARD" } };

function specHeader(id, version, provenance, sha = "a1b2c3d", date = "2026-09-07") {
  return `// criterion: @${id} v${version}\n// provenance: ${provenance}, spec@${sha}, derived ${date}\n`;
}

// ---- header parsing ----

test("checkTests: a missing criterion line fails", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", '// provenance: blind, spec@a1b2c3d, derived 2026-09-07\nimport {} from "x";\n');
  commit(d, "stage(derive-tests): R-1.1");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes(":1:") && m.includes('// criterion: @<ID> v<n>')));
});

test("checkTests: a missing provenance line fails", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", "// criterion: @R-1.1 v1\nimport {} from \"x\";\n");
  commit(d, "stage(derive-tests): R-1.1");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes(":2:") && m.includes("// provenance:")));
});

// ---- filename must match the header id ----

test("checkTests: a filename that does not match the header's ID fails", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/opportunities/wrong-name.spec.ts", specHeader("R-1.1", 1, "blind"));
  commit(d, "stage(derive-tests): R-1.1");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("filename must be R-1.1.spec.ts")));
});

// ---- unknown / non-accepted criterion ----

test("checkTests: a header ID not in the index fails", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/opportunities/R-9.9.spec.ts", specHeader("R-9.9", 1, "blind"));
  commit(d, "stage(derive-tests): R-9.9");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("@R-9.9 is not an accepted criterion")));
});

test("checkTests: a header ID whose criterion is still proposed (not accepted) fails", () => {
  const d = project();
  writeIndex(d, [{ ...R11, id: "R-1.2", state: "proposed" }]);
  write(d, "tests/acceptance/opportunities/R-1.2.spec.ts", specHeader("R-1.2", 1, "blind"));
  commit(d, "stage(derive-tests): R-1.2");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("@R-1.2 is not an accepted criterion")));
});

// ---- stale vs newer version ----

test("checkTests: a header version lower than the index's is a warning (stale), not a failure", () => {
  const d = project();
  writeIndex(d, [{ ...R11, version: 2 }]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1, "blind"));
  commit(d, "stage(derive-tests): R-1.1");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, true, r.messages.join("\n"));
  assert.deepEqual(r.stale, ["R-1.1"]);
  assert.ok(r.warnings.some((w) => w.includes("stale")));
});

test("checkTests: a header version higher than the index's fails", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 2, "blind"));
  commit(d, "stage(derive-tests): R-1.1");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("header is v2") && m.includes("v1")));
});

// ---- provenance: blind, verified by the commit that wrote the file ----

test("checkTests: a blind claim backed by a derive-tests commit passes", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1, "blind"));
  commit(d, "propose(G3): derive-tests-opportunities");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, true, r.messages.join("\n"));
});

test("checkTests: a blind claim on a file whose last commit is unrelated is unverified, and fails at STANDARD with no attestation", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1, "blind"));
  commit(d, "chore: hand-edit the spec file");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("unverified provenance") && m.includes("attestations.yaml")));
});

test("checkTests: header says unverified explicitly and is unverified regardless of the git history", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1, "unverified"));
  commit(d, "propose(G3): derive-tests-opportunities"); // a derive-tests commit, but the header itself claims unverified
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("unverified provenance")));
});

test("checkTests: an unverified file with a matching attestation passes at STANDARD", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1, "blind"));
  write(d, "tests/acceptance/attestations.yaml",
    'attestations:\n  - { file: tests/acceptance/opportunities/R-1.1.spec.ts, by: tech-lead, reason: "reviewed by hand" }\n');
  commit(d, "chore: hand-edit the spec file");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, true, r.messages.join("\n"));
});

test("checkTests: unverified at HIGH tier fails even with a matching attestation", () => {
  const d = project();
  writeIndex(d, [{ ...R11, tier: "HIGH" }]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1, "blind"));
  write(d, "tests/acceptance/attestations.yaml",
    'attestations:\n  - { file: tests/acceptance/opportunities/R-1.1.spec.ts, by: tech-lead, reason: "reviewed by hand" }\n');
  commit(d, "chore: hand-edit the spec file");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("fails outright at tier HIGH")));
});

test("checkTests: an uncommitted blind file counts as blind only when SDLC_STAGE is derive-tests", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1, "blind"));
  // Never committed at all: git has no history to check the claim against.
  const withoutStage = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(withoutStage.ok, false, "without SDLC_STAGE=derive-tests, an uncommitted file is unverified");

  const prev = process.env.SDLC_STAGE;
  process.env.SDLC_STAGE = "derive-tests";
  try {
    const withStage = checkTests(d, { config: CONFIG_STANDARD });
    assert.equal(withStage.ok, true, withStage.messages.join("\n"));
  } finally {
    if (prev === undefined) delete process.env.SDLC_STAGE; else process.env.SDLC_STAGE = prev;
  }
});

test("checkTests: a project that is not a git repository degrades a blind claim to unverified instead of throwing", () => {
  const d = nonRepoProject();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1, "blind"));
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("unverified provenance") && m.includes("attestations.yaml")));
});

// ---- tests must live under a domain folder ----

test("checkTests: a .gitkeep directly under tests/acceptance/ is not a test and passes", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/.gitkeep", "");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.ok(!r.messages.some((m) => m.includes(".gitkeep")), r.messages.join("\n"));
});


test("checkTests: a spec file directly under tests/acceptance/, with no domain folder, fails", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/R-1.1.spec.ts", specHeader("R-1.1", 1, "blind"));
  commit(d, "stage(derive-tests): R-1.1");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m === "tests/acceptance/R-1.1.spec.ts: tests live under a domain folder"));
});

test("checkTests: not-testable.yaml and attestations.yaml at the top level are not flagged as misplaced", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/not-testable.yaml", "criteria: []\n");
  write(d, "tests/acceptance/attestations.yaml", "attestations: []\n");
  commit(d, "chore: harness scaffolding");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, true, r.messages.join("\n"));
});

// ---- not-testable.yaml ----

test("checkTests: a not-testable entry for an accepted criterion with a reason, and no test file, passes", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/not-testable.yaml", "criteria:\n  - { id: R-1.1, version: 1, reason: \"no path through the surface\" }\n");
  commit(d, "chore: harness scaffolding");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, true, r.messages.join("\n"));
});

test("checkTests: a not-testable entry with an empty reason fails", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/not-testable.yaml", "criteria:\n  - { id: R-1.1, version: 1, reason: \"\" }\n");
  commit(d, "chore: harness scaffolding");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("R-1.1 has no reason")));
});

test("checkTests: a not-testable entry naming a criterion that also has a test file fails", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1, "blind"));
  write(d, "tests/acceptance/not-testable.yaml", "criteria:\n  - { id: R-1.1, version: 1, reason: \"no path through the surface\" }\n");
  commit(d, "stage(derive-tests): R-1.1");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("R-1.1 also has a test")));
});

test("checkTests: a malformed not-testable.yaml fails the check, naming the file, instead of reading back as empty", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/not-testable.yaml", "criteria:\n  - { id: R-1.1\n"); // unclosed flow mapping
  commit(d, "chore: harness scaffolding");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("tests/acceptance/not-testable.yaml") && m.includes("does not parse")));
});

test("checkTests: a malformed attestations.yaml fails the check, naming the file, instead of reading back as empty", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1, "blind"));
  write(d, "tests/acceptance/attestations.yaml", "attestations:\n  - { file: x\n"); // unclosed flow mapping
  commit(d, "chore: hand-edit the spec file"); // unverified: falls through to the attestations read
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("tests/acceptance/attestations.yaml") && m.includes("does not parse")));
});

test("checkTests: a not-testable entry for a criterion that is not accepted fails", () => {
  const d = project();
  writeIndex(d, [R11]);
  write(d, "tests/acceptance/not-testable.yaml", "criteria:\n  - { id: R-9.9, version: 1, reason: \"does not exist\" }\n");
  commit(d, "chore: harness scaffolding");
  const r = checkTests(d, { config: CONFIG_STANDARD });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("R-9.9 is not an accepted criterion")));
});

// ---- no index yet: nothing to check ----

test("checkTests: a project with no spec/criteria-index.json yet passes with nothing to check", () => {
  const d = project();
  const r = checkTests(d, {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages, []);
});

// ---- coverage ----

test("coverage: a two-criterion domain with one covered and one not-testable", () => {
  const d = project();
  const R12 = { ...R11, id: "R-1.2" };
  writeIndex(d, [R11, R12]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1, "blind"));
  write(d, "tests/acceptance/not-testable.yaml", "criteria:\n  - { id: R-1.2, version: 1, reason: \"no path through the surface\" }\n");
  const c = coverage(d, "opportunities");
  assert.deepEqual(c, { covered: ["R-1.1"], missing: [], notTestable: ["R-1.2"] });
});

test("coverage: an accepted criterion with neither a test nor a not-testable entry is missing", () => {
  const d = project();
  writeIndex(d, [R11]);
  const c = coverage(d, "opportunities");
  assert.deepEqual(c, { covered: [], missing: ["R-1.1"], notTestable: [] });
});

// ---- checkGenerated ----

test("checkGenerated: passes when tests/generated does not exist yet", () => {
  const d = project();
  const r = checkGenerated(d);
  assert.equal(r.ok, true);
});

test("checkGenerated: drift between the contract and tests/generated is detected", () => {
  const d = project();
  write(d, "spec/contract/surface.yaml", "pages:\n  - id: opportunity\n    route: /opportunities/:id\n");
  write(d, "spec/contract/personas.yaml", "personas: []\n");
  write(d, "tests/seed/manifest.yaml", "description: seed handles\n");
  mkdirSync(join(d, "tests", "generated"), { recursive: true });
  writeFileSync(join(d, "tests/generated/surface.d.ts"), "// stale, hand-edited\n");
  const r = checkGenerated(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("tests/generated/surface.d.ts") && m.includes("does not match the contract")));
  assert.ok(r.messages.some((m) => m.includes("tests/generated/personas.ts") && m.includes("missing")));
});

test("checkGenerated: passes when every generated file matches the contract exactly", () => {
  const d = project();
  write(d, "spec/contract/surface.yaml", "pages:\n  - id: opportunity\n    route: /opportunities/:id\n");
  write(d, "spec/contract/personas.yaml", "personas: []\n");
  write(d, "tests/seed/manifest.yaml", "description: seed handles\n");
  // writeGenerated is Task 1's own function; used here only to produce a genuinely
  // matching tests/generated for the "no drift" case.
  writeGenerated(d);
  const r = checkGenerated(d);
  assert.equal(r.ok, true, r.messages.join("\n"));
});

test("checkGenerated: a file under tests/generated/ that the generator would never produce fails, the reverse direction from drift", () => {
  const d = project();
  write(d, "spec/contract/surface.yaml", "pages:\n  - id: opportunity\n    route: /opportunities/:id\n");
  write(d, "spec/contract/personas.yaml", "personas: []\n");
  write(d, "tests/seed/manifest.yaml", "description: seed handles\n");
  // writeGenerated produces exactly the three real files; this one is added by hand
  // afterwards and the generator has no idea it exists.
  writeGenerated(d);
  writeFileSync(join(d, "tests/generated/leftover.ts"), "// not produced by generateTypes\n");
  const r = checkGenerated(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m === "tests/generated/leftover.ts: not produced by the generator"));
});

test("checkGenerated: a contract with load errors is reported as a failure", () => {
  const d = project();
  write(d, "spec/contract/surface.yaml", "pages:\n  - route: /opportunities\n"); // no id: a load error
  mkdirSync(join(d, "tests", "generated"), { recursive: true });
  const r = checkGenerated(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes('is missing "id"')));
});

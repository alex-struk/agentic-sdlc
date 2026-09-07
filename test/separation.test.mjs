import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSeparation } from "../src/checks/separation.mjs";

function project() {
  return mkdtempSync(join(tmpdir(), "sdlc-separation-"));
}

function write(dir, relPath, text) {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
}

// ---- adapters: expect( ----

test("separation: an adapter asserting with expect( fails, naming the file and line", () => {
  const d = project();
  write(d, "tests/adapters/old/opportunity.ts", 'export function opportunity() {\n  expect(true).toBe(true);\n}\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m === "tests/adapters/old/opportunity.ts:2: adapters must not assert: contains expect("));
});

test("separation: an adapter with no expect( passes that rule", () => {
  const d = project();
  write(d, "tests/adapters/old/opportunity.ts", 'export function opportunity() {\n  return "ok";\n}\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, true);
});

// ---- adapters: import from acceptance or app ----

test("separation: an adapter importing from tests/acceptance fails", () => {
  const d = project();
  write(d, "tests/adapters/old/opportunity.ts", 'import { helper } from "../acceptance/shared";\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("adapters must not import from tests/acceptance or app/") && m.includes("../acceptance/shared")));
});

test("separation: an adapter importing from app/ fails", () => {
  const d = project();
  write(d, "tests/adapters/old/opportunity.ts", 'import { db } from "app/lib/db";\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("app/lib/db")));
});

test("separation: an adapter importing from playwright is fine", () => {
  const d = project();
  write(d, "tests/adapters/old/opportunity.ts", 'import { Page } from "playwright";\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, true);
});

// ---- adapters: test( ----

test("separation: an adapter defining its own test() fails", () => {
  const d = project();
  write(d, "tests/adapters/old/opportunity.ts", 'test("smoke", () => {});\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m === "tests/adapters/old/opportunity.ts:1: adapters must not define a test(): contains test("));
});

// ---- acceptance: import from adapters or app ----

test("separation: an acceptance test importing from tests/adapters fails", () => {
  const d = project();
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", 'import { opportunity } from "../../adapters/old/opportunity";\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("tests must not import from tests/adapters or app/") && m.includes("/adapters/")));
});

test("separation: an acceptance test importing ../../app fails", () => {
  const d = project();
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", 'import { db } from "../../app/lib/db";\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, false);
});

test("separation: an acceptance test importing from fixtures is fine", () => {
  const d = project();
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", 'import { test, expect, persona, seed } from "../../fixtures";\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, true);
});

// ---- acceptance: page. ----

test("separation: a test touching page. fails", () => {
  const d = project();
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", 'test("x", async ({ page }) => {\n  await page.click("button");\n});\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m === "tests/acceptance/opportunities/R-1.1.spec.ts:2: a test must not touch the page object: contains page."));
});

// ---- acceptance: locator( ----

test("separation: a test calling locator( fails", () => {
  const d = project();
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", 'const el = locator("#id");\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("a test must not call a locator directly: contains locator(")));
});

// ---- acceptance: getBy ----

test("separation: a test calling getByRole fails", () => {
  const d = project();
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", 'const btn = page.getByRole("button");\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("contains getBy")));
});

// ---- acceptance: data-testid ----

test("separation: a test referencing data-testid fails", () => {
  const d = project();
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", 'const sel = \'[data-testid="publish"]\';\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("contains data-testid")));
});

// ---- acceptance: querySelector ----

test("separation: a test calling querySelector fails", () => {
  const d = project();
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", 'document.querySelector(".x");\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("contains querySelector")));
});

// ---- acceptance: route literal ----

test("separation: a hardcoded https:// route literal fails", () => {
  const d = project();
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", 'const url = "https://example.test/opportunities";\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("a test must not hardcode a route")));
});

test("separation: a hardcoded /path route literal fails", () => {
  const d = project();
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", 'await surface.opportunity.open({ path: "/opportunities/123" });\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, false);
});

test("separation: a lone \"/\" literal is allowed", () => {
  const d = project();
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", 'const sep = "/";\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, true);
});

// ---- acceptance: goto( ----

test("separation: a test calling goto( fails", () => {
  const d = project();
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", 'await page.goto("/opportunities");\n');
  const r = checkSeparation(d);
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("contains goto(")));
});

// ---- comment lines never trip the route/locator family, including the provenance header ----

test("separation: the provenance header and prose comments about routes/locators do not trip the rules", () => {
  const d = project();
  write(
    d,
    "tests/acceptance/opportunities/R-1.1.spec.ts",
    [
      "// criterion: @R-1.1 v1",
      "// provenance: blind, spec@a1b2c3d, derived 2026-09-07",
      "// a test never calls locator( or getByRole, and never hardcodes \"/opportunities\"",
      'import { test, expect, persona, seed } from "../../fixtures";',
      'test("x", async ({ surface }) => {',
      "  await surface.opportunity.open();",
      "});",
      "",
    ].join("\n"),
  );
  const r = checkSeparation(d);
  assert.equal(r.ok, true, r.messages.join("\n"));
});

// ---- a clean adapter and a clean test both pass together ----

test("separation: a well-formed adapter and a well-formed test both pass", () => {
  const d = project();
  write(
    d,
    "tests/adapters/old/opportunity.ts",
    [
      'import type { OpportunityPage } from "../../generated/surface";',
      "export function opportunityAdapter(page): OpportunityPage {",
      "  return {",
      "    async open() { await page.click('a[href=\"/opportunities\"]'); },",
      "    async publish() { await page.click('button'); },",
      "    async status() { return page.textContent('.status'); },",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  write(
    d,
    "tests/acceptance/opportunities/R-1.1.spec.ts",
    [
      "// criterion: @R-1.1 v1",
      "// provenance: blind, spec@a1b2c3d, derived 2026-09-07",
      'import { test, expect, persona, seed } from "../../fixtures";',
      'test("publishes", async ({ surface }) => {',
      "  await surface.signIn(persona.publicSectorAdmin);",
      "  await surface.opportunity.open({ id: seed.opportunities.draft });",
      "  await surface.opportunity.publish();",
      '  expect(await surface.opportunity.status()).toBe("published");',
      "});",
      "",
    ].join("\n"),
  );
  const r = checkSeparation(d);
  assert.equal(r.ok, true, r.messages.join("\n"));
});

// ---- not-testable.yaml and attestations.yaml are not TypeScript and are skipped ----

test("separation: not-testable.yaml and attestations.yaml are never scanned", () => {
  const d = project();
  write(d, "tests/acceptance/not-testable.yaml", 'criteria:\n  - { id: R-1.4, version: 1, reason: "no path through the surface, see https://example.test" }\n');
  write(d, "tests/acceptance/attestations.yaml", "attestations: []\n");
  const r = checkSeparation(d);
  assert.equal(r.ok, true, r.messages.join("\n"));
});

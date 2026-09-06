import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { checkConstitution } from "../src/checks/constitution.mjs";
import { checkEgress } from "../src/checks/egress.mjs";
import { checkLayout } from "../src/checks/layout.mjs";

function repo() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-chk-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  return d;
}

const GOOD_CONSTITUTION = `# Constitution — Example
## Platform articles
### P1 — Accessibility
All interfaces SHALL meet WCAG 2.1 AA.
Source: https://digital.gov.bc.ca/design/wcag/intro/
### P2 — Design system
Use the design system.
Source: convention
`;

test("constitution: placeholders and missing sources fail", () => {
  const d = repo();
  writeFileSync(join(d, "constitution.md"), GOOD_CONSTITUTION.replace("Source: convention", ""));
  let r = checkConstitution(d, {});
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("P2")));
  writeFileSync(join(d, "constitution.md"), GOOD_CONSTITUTION + "### P3 — {{FILL ME}}\nSource: convention\n");
  r = checkConstitution(d, {});
  assert.equal(r.ok, false);
  writeFileSync(join(d, "constitution.md"), GOOD_CONSTITUTION);
  assert.equal(checkConstitution(d, {}).ok, true);
});

test("egress: ticket numbers, notes paths and listed names are caught in tracked files only", () => {
  const d = repo();
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, "a.md"), "See ticket AB-1234 and the folder !Private/notes\n");
  writeFileSync(join(d, "b.md"), "Jane Example agreed on the Teams call\n");
  writeFileSync(join(d, ".sdlc/egress.local.txt"), "Jane Example\n");
  writeFileSync(join(d, "untracked.md"), "AB-9999\n");
  git(["add", "a.md", "b.md"], d);
  const r = checkEgress(d, {});
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("a.md") && m.includes("ticket")));
  assert.ok(r.messages.some((m) => m.includes("a.md") && m.includes("private notes")));
  assert.ok(r.messages.some((m) => m.includes("b.md") && m.includes("name")));
  assert.ok(r.messages.some((m) => m.includes("b.md") && m.includes("meeting")));
  assert.ok(!r.messages.some((m) => m.includes("untracked.md")));
});

test("egress: no name list is a warning, not a failure", () => {
  const d = repo();
  writeFileSync(join(d, "clean.md"), "nothing here\n"); git(["add", "clean.md"], d);
  // Isolate from the real machine's default names file. nameList() stops at
  // the first EXISTING candidate in [env, .sdlc/egress.local.txt, default] —
  // so pointing SDLC_EGRESS_NAMES at a path that doesn't exist would still
  // fall through to a developer's real ~/.config/agentic-sdlc/egress-names.txt
  // if one happens to be present. Pointing it at an existing-but-empty file
  // instead makes it win that lookup outright, so the default path is never
  // consulted regardless of machine state.
  const prev = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(d, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  try {
    const r = checkEgress(d, {});
    assert.equal(r.ok, true);
    assert.ok(r.warnings.length === 1 && r.warnings[0].includes("egress-names.txt"));
  } finally {
    if (prev === undefined) delete process.env.SDLC_EGRESS_NAMES;
    else process.env.SDLC_EGRESS_NAMES = prev;
  }
});

test("egress: self scope excludes docs/superpowers/ (working plans and briefs) but still scans other docs/", () => {
  const d = repo();
  mkdirSync(join(d, "docs", "superpowers"), { recursive: true });
  writeFileSync(join(d, "docs", "superpowers", "plan.md"), "See ticket AB-1234\n");
  writeFileSync(join(d, "docs", "other.md"), "See ticket AB-1234\n");
  git(["add", "-A"], d);
  const r = checkEgress(d, { self: true });
  assert.equal(r.ok, false);
  assert.ok(!r.messages.some((m) => m.includes("docs/superpowers/plan.md")));
  assert.ok(r.messages.some((m) => m.includes("docs/other.md") && m.includes("ticket")));
});

test("layout: required paths for a rebuild project", () => {
  const d = repo();
  const r = checkLayout(d, { config: { profile: "rebuild" } });
  assert.equal(r.ok, false);
  for (const p of ["constitution.md", ".sdlc/config.yaml", "spec", "tests/acceptance", "evidence/pr-evidence.md"]) {
    mkdirSync(join(d, p.includes(".") ? p.split("/").slice(0, -1).join("/") || "." : p), { recursive: true });
    if (p.includes(".")) writeFileSync(join(d, p), "");
  }
  for (const p of ["intent", "design", "plan", "app", "tests/adapters", "tests/seed", "spec/features", "spec/contract"]) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, ".sdlc/lock.json"), "{}");
  assert.equal(checkLayout(d, { config: { profile: "rebuild" } }).ok, true);
});

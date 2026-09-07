import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { checkConstitution } from "../src/checks/constitution.mjs";
import { checkEgress, defaultNamesPath } from "../src/checks/egress.mjs";
import { checkLayout } from "../src/checks/layout.mjs";
import { checkConfig } from "../src/checks/config.mjs";
import { checkCriteriaIndex } from "../src/checks/criteria.mjs";
import { parseAll, writeIndex } from "../src/spec/criteria.mjs";

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

// Fixture strings are assembled from pieces so this file does not trip the very
// patterns it is testing: the self-check scans every tracked text file, tests included.
const TICKET = "AB" + "-1234";
const OTHER_TICKET = "AB" + "-9999";
const NOTES_PATH = "!Pri" + "vate/notes";
const MEETING = "Teams " + "call";
const LISTED_NAME = "Jane " + "Example";
const HOME_PATH = "/ho" + "me/someone/notes.txt";

test("egress: ticket numbers, notes paths and listed names are caught in tracked files only", () => {
  const d = repo();
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, "a.md"), `See ticket ${TICKET} and the folder ${NOTES_PATH}\n`);
  writeFileSync(join(d, "b.md"), `${LISTED_NAME} agreed on the ${MEETING}\n`);
  writeFileSync(join(d, ".sdlc/egress.local.txt"), `${LISTED_NAME}\n`);
  writeFileSync(join(d, "untracked.md"), `${OTHER_TICKET}\n`);
  git(["add", "a.md", "b.md"], d);
  const r = checkEgress(d, {});
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes("a.md") && m.includes("ticket")));
  assert.ok(r.messages.some((m) => m.includes("a.md") && m.includes("private notes")));
  assert.ok(r.messages.some((m) => m.includes("b.md") && m.includes("name")));
  assert.ok(r.messages.some((m) => m.includes("b.md") && m.includes("meeting")));
  assert.ok(!r.messages.some((m) => m.includes("untracked.md")));
});

test("egress: a local home path is a finding", () => {
  const d = repo();
  writeFileSync(join(d, "script.py"), `sys.path.insert(0, "${HOME_PATH}")\n`);
  writeFileSync(join(d, "win.md"), "See C:" + "\\Us" + "ers\\someone\\Documents\n");
  writeFileSync(join(d, "mac.md"), "/Us" + "ers/someone/Library\n");
  git(["add", "-A"], d);
  const r = checkEgress(d, {});
  assert.equal(r.ok, false);
  for (const f of ["script.py", "win.md", "mac.md"])
    assert.ok(r.messages.some((m) => m.startsWith(`${f}:`) && m.includes("local home path")), f);
});

test("egress: a tracked path that is gone from disk is skipped, not read", () => {
  const d = repo();
  writeFileSync(join(d, "gone.md"), "nothing here\n");
  git(["add", "-A"], d); git(["commit", "-q", "-m", "add"], d);
  rmSync(join(d, "gone.md"));
  assert.doesNotThrow(() => checkEgress(d, {}));
});

test("egress: self scope is every tracked text file except the working-note exclusions", () => {
  const d = repo();
  mkdirSync(join(d, "docs", "superpowers"), { recursive: true });
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "docs", "superpowers", "plan.md"), `See ticket ${TICKET}\n`);
  writeFileSync(join(d, "docs", "other.md"), `See ticket ${TICKET}\n`);
  // Neither src/ nor the repository root was in the old allow list, so a leak in
  // either went unreported by `sdlc checks --self`.
  writeFileSync(join(d, "src", "thing.mjs"), `// ticket ${TICKET}\n`);
  writeFileSync(join(d, "README.md"), `ticket ${TICKET}\n`);
  git(["add", "-A"], d);
  const r = checkEgress(d, { self: true });
  assert.equal(r.ok, false);
  assert.ok(!r.messages.some((m) => m.includes("docs/superpowers/plan.md")));
  for (const f of ["docs/other.md", "src/thing.mjs", "README.md"])
    assert.ok(r.messages.some((m) => m.startsWith(`${f}:`) && m.includes("ticket")), f);
});

test("egress: no name list is a warning, not a failure", () => {
  const d = repo();
  writeFileSync(join(d, "clean.md"), "nothing here\n"); git(["add", "clean.md"], d);
  // Isolate from the real machine's default names file. nameList() stops at the first
  // EXISTING candidate in [env, .sdlc/egress.local.txt, default], so pointing
  // SDLC_EGRESS_NAMES at a path that does not exist would still fall through to a
  // developer's real list. Pointing it at an existing-but-empty file makes it win the
  // lookup outright, so the default path is never consulted regardless of machine state.
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

test("egress: the default name list follows XDG_CONFIG_HOME", () => {
  const prevEnv = process.env.SDLC_EGRESS_NAMES, prevXdg = process.env.XDG_CONFIG_HOME;
  const cfg = mkdtempSync(join(tmpdir(), "sdlc-xdg-"));
  delete process.env.SDLC_EGRESS_NAMES;
  process.env.XDG_CONFIG_HOME = cfg;
  try {
    assert.equal(defaultNamesPath(), join(cfg, "agentic-sdlc", "egress-names.txt"));
    process.env.SDLC_EGRESS_NAMES = "/tmp/explicit-names.txt";
    assert.equal(defaultNamesPath(), "/tmp/explicit-names.txt");
  } finally {
    if (prevEnv === undefined) delete process.env.SDLC_EGRESS_NAMES; else process.env.SDLC_EGRESS_NAMES = prevEnv;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("config: malformed YAML is reported, not thrown", () => {
  const d = repo();
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), "policy: { gates: [G1\nprofile: rebuild\n");
  const r = checkConfig(d, {});
  assert.equal(r.ok, false);
  assert.equal(r.config, null);
  assert.ok(r.messages.some((m) => /not valid YAML/.test(m)), r.messages.join("\n"));
});

test("layout: required paths for a rebuild project", () => {
  const d = repo();
  const r = checkLayout(d, { config: { profile: "rebuild" } });
  assert.equal(r.ok, false);
  for (const p of ["constitution.md", ".sdlc/config.yaml", "spec", "tests/acceptance", "evidence/pr-evidence.md"]) {
    mkdirSync(join(d, p.includes(".") ? p.split("/").slice(0, -1).join("/") || "." : p), { recursive: true });
    if (p.includes(".")) writeFileSync(join(d, p), "");
  }
  for (const p of ["intent", "design", "plan", "app", "tests/adapters", "tests/seed", "spec/features", "spec/domains", "spec/contract"]) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, ".sdlc/lock.json"), "{}");
  assert.equal(checkLayout(d, { config: { profile: "rebuild" } }).ok, true);
});

test("layout: spec/domains is required", () => {
  const d = repo();
  for (const p of ["constitution.md", ".sdlc/config.yaml", ".sdlc/lock.json", "evidence/pr-evidence.md"]) {
    mkdirSync(join(d, p.split("/").slice(0, -1).join("/") || "."), { recursive: true });
    writeFileSync(join(d, p), "");
  }
  for (const p of ["intent", "design", "plan", "app", "tests/acceptance", "tests/adapters", "tests/seed", "spec", "spec/features", "spec/contract"]) mkdirSync(join(d, p), { recursive: true });
  const r = checkLayout(d, { config: { profile: "rebuild" } });
  assert.equal(r.ok, false);
  assert.ok(r.messages.includes("missing: spec/domains"));
  mkdirSync(join(d, "spec/domains"), { recursive: true });
  assert.equal(checkLayout(d, { config: { profile: "rebuild" } }).ok, true);
});

test("criteria-index check: a stale index fails, naming ratify as the fix", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-idx-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, "spec", "domains"), { recursive: true });
  writeFileSync(join(d, "spec/domains/permits.md"),
    "# permits\n\n### D-permits-1 · v1 · confirmed · authored\nA statement.\n- state: proposed\n");

  // No index at all: nothing to be stale.
  assert.equal(checkCriteriaIndex(d).ok, true);

  const parsed = parseAll(d);
  writeIndex(d, parsed);
  assert.equal(checkCriteriaIndex(d).ok, true, "a freshly written index matches");

  // The domain file moves on without the index being regenerated.
  writeFileSync(join(d, "spec/domains/permits.md"),
    "# permits\n\n### D-permits-1 · v2 · confirmed · authored\nA restated statement.\n- state: proposed\n");
  const stale = checkCriteriaIndex(d);
  assert.equal(stale.ok, false);
  assert.match(stale.messages[0], /stale/);
  assert.match(stale.messages[0], /sdlc run ratify/);
});

test("criteria-index check: an index that does not parse fails", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-idx-bad-"));
  mkdirSync(join(d, "spec", "domains"), { recursive: true });
  writeFileSync(join(d, "spec/criteria-index.json"), "{not json");
  const r = checkCriteriaIndex(d);
  assert.equal(r.ok, false);
  assert.match(r.messages[0], /does not parse/);
});

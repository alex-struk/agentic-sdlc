import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../src/commands/status.mjs";
import { git } from "../src/lib/git.mjs";

const COMMIT = ["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m"];

test("site pages summarise criteria, gates and runs", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-site-"));
  mkdirSync(join(d, ".sdlc/gates"), { recursive: true }); mkdirSync(join(d, ".sdlc/runs"), { recursive: true }); mkdirSync(join(d, "spec"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), "profile: rebuild\nproject: { name: p, domains: [a] }\n");
  writeFileSync(join(d, "spec/criteria-index.json"), JSON.stringify({ criteria: [{ id: "R-1.1", domain: "a", state: "accepted" }, { id: "R-1.2", domain: "a", state: "proposed" }] }));
  writeFileSync(join(d, ".sdlc/gates/x.yaml"), "gate: G1\nverdict: approve\nby: agent:product-owner\nheld_by: agent\nnote: \"\"\nat: 2026-01-01T00:00:00Z\n");
  writeFileSync(join(d, ".sdlc/runs/2026-01-01.md"), "# Run record 2026-01-01\n\n- 10:00:00 init\n");
  const { pages } = buildSite(d);
  // index, gates, runs, results, journal, and one criteria page (domain "a", the only
  // domain present in the index) — no .sdlc/journal or .sdlc/proposals directory here, so
  // the journal page is still written (empty) and there are no proposal pages.
  assert.equal(pages.filter((p) => p.endsWith(".md")).length, 6);
  const index = readFileSync(join(d, "site/index.md"), "utf8");
  assert.match(index, /\| a \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \| 2 \|/);
  assert.match(index, /\[a\]\(criteria\/a\.md\)/);
  assert.match(readFileSync(join(d, "site/gates.md"), "utf8"), /agent-held/);
  assert.match(readFileSync(join(d, "site/runs.md"), "utf8"), /10:00:00 init/);
});

// A fully valid config (all six policy gates, the shape `loadConfig` accepts without
// errors) so gate holders and G3's sampling rate resolve the way a real project's would.
const CONFIG = `pipeline: { repo: x, ref: main }
profile: rebuild
stack: node
project: { name: p, domains: [a] }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead, human_sample_per_week: 1 }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [] }
`;

function bigFixture() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-site-big-"));
  mkdirSync(join(d, ".sdlc/gates"), { recursive: true });
  mkdirSync(join(d, ".sdlc/runs"), { recursive: true });
  mkdirSync(join(d, ".sdlc/journal"), { recursive: true });
  mkdirSync(join(d, ".sdlc/proposals"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), CONFIG);

  // Journal: two entries, newest last on disk (numeric order), newest first on the page.
  writeFileSync(join(d, ".sdlc/journal/001-init.md"),
    `---\nstage: "init"\ntitle: "Initial"\nat: "2026-01-01T00:00:00.000Z"\ncost: 1.5\nturns: 3\nsession: "s1"\n---\n\nSet things up.\n`);
  writeFileSync(join(d, ".sdlc/journal/002-plan.md"),
    `---\nstage: "plan"\ntitle: "Plan"\nat: "2026-01-02T00:00:00.000Z"\ncost: 2.5\nturns: 5\nsession: "s2"\n---\n\nWrote the plan.\n`);

  // Proposals: one open (no gate file), one ruled by an agent (Ruling appended to the
  // page itself, the way `rule.mjs`'s agent path does it), one escalated (gate file
  // only — escalation never touches the proposal page).
  writeFileSync(join(d, ".sdlc/proposals/p-open.md"),
    `---\ngate: G0\nquestion: "Do we ship X?"\nrecommendation: "Yes"\nopened: 2026-01-03T00:00:00.000Z\n---\n\n# Do we ship X?\n\n**Recommendation.** Yes\n\nSome page content.\n`);
  writeFileSync(join(d, ".sdlc/proposals/p-ruled.md"),
    `---\ngate: G2\nquestion: "Approve refactor?"\nrecommendation: "Approve"\nopened: 2026-01-04T00:00:00.000Z\ntier: STANDARD\n---\n\n# Approve refactor?\n\n**Recommendation.** Approve\n\nSome page content.\n\n## Ruling\n\n**Verdict:** approve\n**By:** agent:architect\n\nLooks fine.\n\n**Conditions:**\nnone\n`);
  writeFileSync(join(d, ".sdlc/proposals/p-escalated.md"),
    `---\ngate: G0\nquestion: "Risky change?"\nrecommendation: "Escalate"\nopened: 2026-01-05T00:00:00.000Z\n---\n\n# Risky change?\n\n**Recommendation.** Escalate\n\nSome content.\n`);

  // The ruled gate carries what its persona turn cost; the escalated one never asked a
  // persona anything, so it carries zeros.
  writeFileSync(join(d, ".sdlc/gates/p-ruled.yaml"),
    `gate: G2\nverdict: approve\nby: agent:architect\nheld_by: agent\nrationale: |2-\n  Looks fine.\nconditions: []\ncost: 0.25\nturns: 4\nsession: "r1"\nat: 2026-01-04T01:00:00.000Z\n`);
  writeFileSync(join(d, ".sdlc/gates/p-escalated.yaml"),
    `gate: G0\nverdict: escalated\nby: agent:product-owner\nheld_by: agent\nescalate_to: tech-lead\nrationale: |2-\n  mandatory escalation: tier HIGH\ncost: 0\nturns: 0\nsession: ""\nat: 2026-01-05T02:00:00.000Z\n`);

  // G3 sampling: three agent-held rulings in the same ISO week (2026-01-05/06/07, all
  // W02), one in the next week (2026-01-12, W03), and a human ruling in the first week
  // that must never be sampled regardless of the count already sampled that week.
  writeFileSync(join(d, ".sdlc/gates/g3-a.yaml"), `gate: G3\nverdict: approve\nby: agent:reviewer\nheld_by: agent\nrationale: |2-\n  ok\nconditions: []\nat: 2026-01-05T00:00:00.000Z\n`);
  writeFileSync(join(d, ".sdlc/gates/g3-b.yaml"), `gate: G3\nverdict: approve\nby: agent:reviewer\nheld_by: agent\nrationale: |2-\n  ok\nconditions: []\nat: 2026-01-06T00:00:00.000Z\n`);
  writeFileSync(join(d, ".sdlc/gates/g3-c.yaml"), `gate: G3\nverdict: approve\nby: agent:reviewer\nheld_by: agent\nrationale: |2-\n  ok\nconditions: []\nat: 2026-01-07T00:00:00.000Z\n`);
  writeFileSync(join(d, ".sdlc/gates/g3-d.yaml"), `gate: G3\nverdict: approve\nby: agent:reviewer\nheld_by: agent\nrationale: |2-\n  ok\nconditions: []\nat: 2026-01-12T00:00:00.000Z\n`);
  writeFileSync(join(d, ".sdlc/gates/g3-human.yaml"), `gate: G3\nverdict: approve\nby: tech-lead\nheld_by: human\nnote: ""\nat: 2026-01-05T12:00:00.000Z\n`);

  return d;
}

test("journal page lists entries newest first with cost lines", () => {
  const d = bigFixture();
  buildSite(d);
  const journal = readFileSync(join(d, "site/journal.md"), "utf8");
  const iInit = journal.indexOf("## 001 · init · 2026-01-01");
  const iPlan = journal.indexOf("## 002 · plan · 2026-01-02");
  assert.ok(iInit >= 0 && iPlan >= 0);
  assert.ok(iPlan < iInit, "newest entry (002) should come before the oldest (001)");
  assert.match(journal, /cost \$1\.5 · turns 3/);
  assert.match(journal, /cost \$2\.5 · turns 5/);
});

test("proposal pages carry a ruling, an open marker, or an escalation", () => {
  const d = bigFixture();
  buildSite(d);
  const ruled = readFileSync(join(d, "site/proposals/p-ruled.md"), "utf8");
  assert.match(ruled, /## Ruling/);
  assert.match(ruled, /Looks fine\./);

  const open = readFileSync(join(d, "site/proposals/p-open.md"), "utf8");
  assert.match(open, /Open, waiting for agent:product-owner/);

  const escalated = readFileSync(join(d, "site/proposals/p-escalated.md"), "utf8");
  assert.match(escalated, /Escalated to tech-lead/);
  assert.match(escalated, /mandatory escalation: tier HIGH/);
});

test("gate sampling marks the first N agent-held rulings per gate per ISO week", () => {
  const d = bigFixture();
  buildSite(d);
  const gates = readFileSync(join(d, "site/gates.md"), "utf8");
  const lines = gates.split("\n").filter((l) => l.startsWith("|") && l.includes("G3"));
  const sampleLines = lines.filter((l) => /\|\s*sample\s*\|\s*$/.test(l));
  assert.equal(sampleLines.length, 2, "one sample per ISO week (W02 and W03)");
  const humanLine = lines.find((l) => l.includes("tech-lead") && l.includes("human"));
  assert.ok(humanLine);
  assert.ok(!/\|\s*sample\s*\|\s*$/.test(humanLine), "a human ruling is never sampled");
  const earliestLine = lines.find((l) => l.includes("2026-01-05T00:00:00.000Z"));
  assert.ok(/\|\s*sample\s*\|\s*$/.test(earliestLine), "the earliest agent-held ruling in the week is the one sampled");
});

test("index totals cost, agent rulings, escalations and open proposals", () => {
  const d = bigFixture();
  buildSite(d);
  const index = readFileSync(join(d, "site/index.md"), "utf8");
  assert.match(index, /Journal cost: \$4/);
  // agent-held, non-escalated rulings: p-ruled (G2) + g3-a..d (G3) = 5
  assert.match(index, /Agent-held rulings: 5/);
  // escalated gate files: p-escalated = 1
  assert.match(index, /Open escalations: 1/);
  // proposals with no gate file: p-open = 1
  assert.match(index, /Open proposals: 1/);
  assert.match(index, /\[p-open\]\(proposals\/p-open\.md\)/);
  assert.match(index, /\[p-ruled\]\(proposals\/p-ruled\.md\)/);
  assert.match(index, /\[Journal\]\(journal\.md\)/);
});

test("gate log carries a cost column and the index totals rulings alongside journal cost", () => {
  const d = bigFixture();
  buildSite(d);
  const gates = readFileSync(join(d, "site/gates.md"), "utf8");
  assert.match(gates, /\| When \| Proposal \| Gate \| Verdict \| By \| Held \| Cost \| Sample \|/);
  const ruled = gates.split("\n").find((l) => l.includes("p-ruled"));
  assert.match(ruled, /\|\s*\$0\.25\s*\|/, ruled);
  // A human ruling has no turn to measure, so its cost cell is blank rather than $0.
  const human = gates.split("\n").find((l) => l.includes("g3-human"));
  assert.match(human, /\|\s*human\s*\|\s*\|/, human);
  const index = readFileSync(join(d, "site/index.md"), "utf8");
  assert.match(index, /Journal cost: \$4\n/);
  assert.match(index, /Rulings cost: \$0\.25\n/);
  assert.match(index, /Total cost: \$4\.25\n/);
});

test("two consecutive builds produce identical pages, so status on an unchanged project changes nothing", () => {
  const d = bigFixture();
  const { pages } = buildSite(d);
  const first = pages.map((p) => readFileSync(join(d, p), "utf8"));
  buildSite(d);
  const second = pages.map((p) => readFileSync(join(d, p), "utf8"));
  assert.deepEqual(second, first);
  assert.ok(!first.join("").includes("generated 20"), "no generation timestamp: git dates the commit");
});

// Config lists domains in the order `billing`, `auth` — the reverse of alphabetical —
// so a coverage table that fell back to alphabetical order would put `auth` first and
// this test would catch it.
function twoDomainFixture() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-site-domains-"));
  mkdirSync(join(d, "spec"), { recursive: true });
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), "profile: rebuild\nproject: { name: p, domains: [billing, auth] }\n");
  writeFileSync(join(d, "spec/criteria-index.json"), JSON.stringify({
    criteria: [
      { id: "D-billing-1", domain: "billing", version: 1, confidence: "inferred", origin: "recovered", statement: "s1", state: "proposed", cites: [] },
      { id: "R-1.1", domain: "billing", version: 1, confidence: "confirmed", origin: "authored", statement: "s2", state: "accepted", cites: [] },
      {
        id: "R-1.2", domain: "billing", version: 2, confidence: "open", origin: "recovered", statement: "Tax is applied at checkout.",
        state: "verified", cites: [{ path: "src/billing.ts", line: 42 }, { path: "README.md" }],
        given: "a cart exists", when: "checkout runs", then: "tax is applied",
        reconciliation: "aligned", notes: ["migrated from spreadsheet"],
      },
      { id: "R-2.1", domain: "auth", version: 1, confidence: "confirmed", origin: "authored", statement: "s4", state: "implemented", cites: [] },
      { id: "R-2.2", domain: "auth", version: 1, confidence: "confirmed", origin: "authored", statement: "s5", state: "monitored", cites: [] },
      { id: "D-auth-1", domain: "auth", version: 1, confidence: "confirmed", origin: "authored", statement: "s6", state: "obsolete", cites: [] },
    ],
  }));
  return d;
}

test("index renders per-domain coverage rows and a totals row", () => {
  const d = twoDomainFixture();
  buildSite(d);
  const index = readFileSync(join(d, "site/index.md"), "utf8");
  assert.match(index, /\| Domain \| proposed \| accepted \| implemented \| verified \| monitored \| obsolete \| open questions \| total \|/);
  assert.match(index, /\| billing \| 1 \| 1 \| 0 \| 1 \| 0 \| 0 \| 1 \| 3 \|/);
  assert.match(index, /\| auth \| 0 \| 0 \| 1 \| 0 \| 1 \| 1 \| 0 \| 3 \|/);
  assert.match(index, /\*\*Totals\*\* \| 1 \| 1 \| 1 \| 1 \| 1 \| 1 \| 1 \| 6 \|/);
});

test("coverage rows follow config.project.domains order, not alphabetical", () => {
  const d = twoDomainFixture();
  buildSite(d);
  const index = readFileSync(join(d, "site/index.md"), "utf8");
  const billingAt = index.indexOf("| billing |");
  const authAt = index.indexOf("| auth |");
  assert.ok(billingAt >= 0 && authAt >= 0);
  assert.ok(billingAt < authAt, "billing is listed first in config.project.domains and must sort first");
});

test("criteria pages carry citations, given/when/then, reconciliation and notes", () => {
  const d = twoDomainFixture();
  buildSite(d);
  const billing = readFileSync(join(d, "site/criteria/billing.md"), "utf8");
  assert.match(billing, /### R-1\.2 · v2 · open · verified/);
  assert.match(billing, /Tax is applied at checkout\./);
  assert.match(billing, /- cites: src\/billing\.ts:42/);
  assert.match(billing, /- cites: README\.md/);
  assert.match(billing, /- reconciliation: aligned/);
  assert.match(billing, /- given: a cart exists/);
  assert.match(billing, /- when: checkout runs/);
  assert.match(billing, /- then: tax is applied/);
  assert.match(billing, /- note: migrated from spreadsheet/);
  // Every criterion in the domain gets a section, not only the one with citations.
  assert.match(billing, /### D-billing-1 · v1 · inferred · proposed/);
  assert.match(billing, /### R-1\.1 · v1 · confirmed · accepted/);
});

// Two accepted criteria in domain "a": R-1.1 backed by a spec file with a valid
// provenance header, R-1.2 recorded not-testable. One results file for target "old"
// (both `latest.json` and the dated file it was written alongside carry the same rows,
// the way `calibrate` itself writes them).
function testsAndCalibrationFixture() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-site-tests-"));
  mkdirSync(join(d, "spec"), { recursive: true });
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  mkdirSync(join(d, "tests", "acceptance", "a"), { recursive: true });
  mkdirSync(join(d, "tests", "results", "old"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), "profile: rebuild\nproject: { name: p, domains: [a] }\n");
  writeFileSync(join(d, "spec/criteria-index.json"), JSON.stringify({
    criteria: [
      { id: "R-1.1", domain: "a", version: 1, state: "accepted", confidence: "confirmed", origin: "authored", statement: "s1", cites: [] },
      { id: "R-1.2", domain: "a", version: 1, state: "accepted", confidence: "confirmed", origin: "authored", statement: "s2", cites: [] },
    ],
  }));
  writeFileSync(join(d, "tests/acceptance/a/R-1.1.spec.ts"),
    "// criterion: @R-1.1 v1\n// provenance: blind, spec@abc1234, derived 2026-01-01\n");
  writeFileSync(join(d, "tests/acceptance/not-testable.yaml"),
    "criteria:\n  - { id: R-1.2, version: 1, reason: \"no observable surface\" }\n");
  const results = {
    target: "old", base_url: "http://old.example", spec: "sha1", at: "2026-01-02T00:00:00.000Z",
    rows: [
      { id: "R-1.1", version: 1, domain: "a", file: "tests/acceptance/a/R-1.1.spec.ts", result: "pass", tests: [] },
      { id: "R-1.2", version: 1, domain: "a", file: null, result: "not-testable", tests: [] },
    ],
  };
  const text = `${JSON.stringify(results, null, 2)}\n`;
  writeFileSync(join(d, "tests/results/old/latest.json"), text);
  writeFileSync(join(d, "tests/results/old/2026-01-02.json"), text);
  return d;
}

test("coverage board gains a tests column and one result column per target", () => {
  const d = testsAndCalibrationFixture();
  buildSite(d);
  const index = readFileSync(join(d, "site/index.md"), "utf8");
  assert.match(index, /\| Domain \| proposed \| accepted \| implemented \| verified \| monitored \| obsolete \| open questions \| total \| tests \| old \|/);
  assert.match(index, /\| a \| 0 \| 2 \| 0 \| 0 \| 0 \| 0 \| 0 \| 2 \| 1\/2 \(n\/t 1\) \| 1 pass · 0 fail · 0 unbound · 0 stale \|/);
  // The totals row has nothing to sum for a per-domain test count or result mix.
  assert.match(index, /\*\*Totals\*\* \| 0 \| 2 \| 0 \| 0 \| 0 \| 0 \| 0 \| 2 \|\s*\|\s*\|/);
  assert.match(index, /\[Results\]\(results\.md\)/);
});

test("criteria page lists each criterion's test file or not-testable reason, and its result per target", () => {
  const d = testsAndCalibrationFixture();
  buildSite(d);
  const page = readFileSync(join(d, "site/criteria/a.md"), "utf8");
  assert.match(page, /\| id \| test \| old \|/);
  assert.match(page, /\| R-1\.1 \| acceptance\/a\/R-1\.1\.spec\.ts \| pass \|/);
  assert.match(page, /\| R-1\.2 \| not testable: no observable surface \| not-testable \|/);
  // The per-criterion sections below the table are untouched by this task.
  assert.match(page, /### R-1\.1 · v1 · confirmed · accepted/);
});

test("criteria page marks a target result ruled when the row carries a ruling verb", () => {
  const d = testsAndCalibrationFixture();
  const latest = JSON.parse(readFileSync(join(d, "tests/results/old/latest.json"), "utf8"));
  latest.rows[0].ruled = "defect-in-old";
  const text = `${JSON.stringify(latest, null, 2)}\n`;
  writeFileSync(join(d, "tests/results/old/latest.json"), text);
  buildSite(d);
  const page = readFileSync(join(d, "site/criteria/a.md"), "utf8");
  assert.match(page, /\| R-1\.1 \| acceptance\/a\/R-1\.1\.spec\.ts \| pass \(ruled: defect-in-old\) \|/);
});

test("results.md lists every results file by date, newest first, with counts and calibration status", () => {
  const d = testsAndCalibrationFixture();
  // A second, earlier dated file so newest-first ordering is actually exercised.
  const earlier = {
    target: "old", base_url: "http://old.example", spec: "sha0", at: "2026-01-01T00:00:00.000Z",
    rows: [{ id: "R-1.1", version: 1, domain: "a", file: "tests/acceptance/a/R-1.1.spec.ts", result: "fail", tests: [], error: "boom" }],
  };
  writeFileSync(join(d, "tests/results/old/2026-01-01.json"), `${JSON.stringify(earlier, null, 2)}\n`);
  buildSite(d);
  const results = readFileSync(join(d, "site/results.md"), "utf8");
  assert.match(results, /^## old$/m);
  assert.match(results, /\| file \| at \| pass \| fail \| unbound \| stale \| not-testable \|/);
  const laterAt = results.indexOf("2026-01-02.json");
  const earlierAt = results.indexOf("2026-01-01.json");
  assert.ok(laterAt >= 0 && earlierAt >= 0);
  assert.ok(laterAt < earlierAt, "the newer results file is listed first");
  assert.match(results, /\| 2026-01-02\.json \| 2026-01-02T00:00:00\.000Z \| 1 \| 0 \| 0 \| 0 \| 1 \|/);
  assert.match(results, /\| 2026-01-01\.json \| 2026-01-01T00:00:00\.000Z \| 0 \| 1 \| 0 \| 0 \| 0 \|/);
  assert.match(results, /no calibration ruling open/);
});

test("results.md names the open calibration proposal for a target when one is waiting on a ruling", () => {
  const d = testsAndCalibrationFixture();
  git(["init", "-q", "-b", "main"], d);
  writeFileSync(join(d, "README.md"), "x\n");
  git(["add", "-A"], d);
  git([...COMMIT, "init"], d);
  git(["checkout", "-q", "-b", "proposal/calibrate-old-1"], d);
  git(["checkout", "-q", "main"], d);
  buildSite(d);
  const results = readFileSync(join(d, "site/results.md"), "utf8");
  assert.match(results, /calibrate-old-1/);
  assert.doesNotMatch(results, /no calibration ruling open/);
});

test("without tests/acceptance, not-testable entries or tests/results, the new columns and the results page are blank", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-site-no-tests-"));
  mkdirSync(join(d, "spec"), { recursive: true });
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), "profile: rebuild\nproject: { name: p, domains: [a] }\n");
  writeFileSync(join(d, "spec/criteria-index.json"), JSON.stringify({
    criteria: [{ id: "R-1.1", domain: "a", version: 1, state: "accepted", confidence: "confirmed", origin: "authored", statement: "s1", cites: [] }],
  }));
  buildSite(d);
  const index = readFileSync(join(d, "site/index.md"), "utf8");
  // No target directory under tests/results/, so there is no per-target column at all —
  // the row ends right after the blank `tests` cell.
  assert.match(index, /\| Domain \| proposed \| accepted \| implemented \| verified \| monitored \| obsolete \| open questions \| total \| tests \|$/m);
  assert.match(index, /\| a \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \| 1 \|\s*\|$/m);
  const page = readFileSync(join(d, "site/criteria/a.md"), "utf8");
  assert.match(page, /\| id \| test \|$/m);
  assert.match(page, /\| R-1\.1 \| — \|$/m);
  const results = readFileSync(join(d, "site/results.md"), "utf8");
  assert.match(results, /no results yet/);
});

test("two consecutive builds of a project with tests and calibration results produce identical pages", () => {
  const d = testsAndCalibrationFixture();
  const { pages } = buildSite(d);
  const first = pages.map((p) => readFileSync(join(d, p), "utf8"));
  buildSite(d);
  const second = pages.map((p) => readFileSync(join(d, p), "utf8"));
  assert.deepEqual(second, first);
});

test("a zero-criteria project still renders the configured domains at zero", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-site-empty-"));
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  mkdirSync(join(d, "spec"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), "profile: rebuild\nproject: { name: p, domains: [a, b] }\n");
  // No spec/criteria-index.json at all: buildSite treats a missing index as zero criteria.
  const { pages } = buildSite(d);
  const index = readFileSync(join(d, "site/index.md"), "utf8");
  assert.match(index, /\| a \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(index, /\| b \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(index, /\*\*Totals\*\* \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \|/);
  // No criterion in the index names either domain, so no criteria page is written.
  assert.ok(!pages.some((p) => p.startsWith("site/criteria/")));
});

test("a latest.json whose rows are not a list is read as no rows rather than taking the site build down", () => {
  const d = testsAndCalibrationFixture();
  // The shape a half-written or hand-edited file can have on disk: valid JSON, but
  // `rows` is not the list every reader of it expects.
  writeFileSync(join(d, "tests/results/old/latest.json"),
    JSON.stringify({ target: "old", base_url: "http://old.example", rows: null }, null, 2) + "\n");
  const { pages } = buildSite(d);
  assert.ok(pages.includes("site/index.md"));
  const index = readFileSync(join(d, "site/index.md"), "utf8");
  // The target's column is still there, reporting zero of everything rather than a crash.
  assert.match(index, /\| a \|.*\| 0 pass · 0 fail · 0 unbound · 0 stale \|/);
  const page = readFileSync(join(d, "site/criteria/a.md"), "utf8");
  assert.match(page, /\| R-1\.1 \| acceptance\/a\/R-1\.1\.spec\.ts \|\s*\|/);
});

test("a latest.json that is not valid JSON at all leaves the target's columns blank", () => {
  const d = testsAndCalibrationFixture();
  writeFileSync(join(d, "tests/results/old/latest.json"), "{ this is not json\n");
  const { pages } = buildSite(d);
  assert.ok(pages.includes("site/index.md"));
  const index = readFileSync(join(d, "site/index.md"), "utf8");
  assert.match(index, /\| Domain \|.*\| old \|/);
});

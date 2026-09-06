import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../src/commands/status.mjs";

test("site pages summarise criteria, gates and runs", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-site-"));
  mkdirSync(join(d, ".sdlc/gates"), { recursive: true }); mkdirSync(join(d, ".sdlc/runs"), { recursive: true }); mkdirSync(join(d, "spec"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), "profile: rebuild\nproject: { name: p, domains: [a] }\n");
  writeFileSync(join(d, "spec/criteria-index.json"), JSON.stringify({ criteria: [{ id: "R-1.1", state: "accepted" }, { id: "R-1.2", state: "proposed" }] }));
  writeFileSync(join(d, ".sdlc/gates/x.yaml"), "gate: G1\nverdict: approve\nby: agent:product-owner\nheld_by: agent\nnote: \"\"\nat: 2026-01-01T00:00:00Z\n");
  writeFileSync(join(d, ".sdlc/runs/2026-01-01.md"), "# Run record 2026-01-01\n\n- 10:00:00 init\n");
  const { pages } = buildSite(d);
  // index, gates, runs, journal — no .sdlc/journal or .sdlc/proposals directory here,
  // so the journal page is still written (empty) and there are no proposal pages.
  assert.equal(pages.length, 4);
  const index = readFileSync(join(d, "site/index.md"), "utf8");
  assert.match(index, /accepted\s*\|\s*1/); assert.match(index, /proposed\s*\|\s*1/);
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

// test/persona-prompt.test.mjs — what a ruling persona is actually shown.
//
// The prompt has a fixed budget, so what fills it decides what the persona can rule on.
// Two rules make that budget spend on evidence: derived files (the state site, the run
// record, the journal) are excluded outright, and the stage's own output is ordered
// first so the cap falls on the least important file rather than on whichever one sorts
// last alphabetically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { buildPersonaPrompt, orderDiffPaths } from "../src/runner/persona.mjs";

const CONFIG = `profile: rebuild
project: { name: permit-intake, domains: [applications, billing] }
policy:
  default_tier: STANDARD
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: "agent:product-owner", escalate_to: tech-lead }
    G2: { holder: tech-lead }
    G3: { holder: tech-lead }
    G4: { holder: tech-lead }
    G5: { holder: tech-lead }
`;

function microProject() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-persona-prompt-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d);
  git(["config", "user.name", "t"], d);
  mkdirSync(join(d, ".sdlc", "personas"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), CONFIG);
  writeFileSync(join(d, ".sdlc/personas/product-owner.md"), "# Persona: product-owner\n\nCares about the contract.\n");
  writeFileSync(join(d, "README.md"), "x\n");
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "init"], d);
  return d;
}

function write(dir, rel, text) {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

test("orderDiffPaths puts the prefixed paths first, longest prefix winning, order otherwise kept", () => {
  const files = ["a.md", "spec/contract/surface.yaml", "z.md", "spec/domains/zeta.md", "intent/brief.md"];
  assert.deepEqual(orderDiffPaths(files, ["spec/domains/", "spec/"]),
    ["spec/domains/zeta.md", "spec/contract/surface.yaml", "a.md", "z.md", "intent/brief.md"]);
  assert.deepEqual(orderDiffPaths(files, ["intent/"]),
    ["intent/brief.md", "a.md", "spec/contract/surface.yaml", "z.md", "spec/domains/zeta.md"]);
  assert.deepEqual(orderDiffPaths(files, []), files);
});

test("a G1 prompt shows the domain file even when the site diff is enormous and the domain sorts last", async () => {
  const dir = microProject();
  const name = "archaeology-zeta";
  git(["checkout", "-q", "-b", `proposal/${name}`], dir);

  // A site far larger than the whole diff budget, and a domain file whose path sorts
  // after every other changed path. Ordered alphabetically — which is how git lists
  // them — `site/*` alone would consume the cap and the domain file would never appear.
  const filler = "a line of generated coverage text that says very little\n".repeat(3000);
  for (const page of ["index", "gates", "runs", "journal"]) write(dir, `site/${page}.md`, filler);
  write(dir, ".sdlc/runs/2026-09-06.md", filler);
  write(dir, ".sdlc/journal/001-archaeology.md", filler);
  write(dir, ".gitattributes", "* text=auto\n");
  write(dir, "spec/contract/surface.yaml", "domain: zeta\n");
  write(dir, "spec/domains/zeta.md", "# zeta\n\n### D-zeta-1 · v1 · confirmed · recovered\nA recovered statement worth ruling on.\n- cites: src/a.js\n- state: proposed\n");
  write(dir, ".sdlc/proposals/" + name + ".md", `---\ngate: G1\nquestion: "Is this what zeta does?"\nrecommendation: "yes"\nopened: 2026-09-06T00:00:00.000Z\n---\n\n# Is this what zeta does?\n`);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "archaeology zeta"], dir);

  const prompt = await buildPersonaPrompt(dir, name, "product-owner", { tier: "STANDARD", gate: "G1" });

  assert.match(prompt, /A recovered statement worth ruling on/, "the domain file is in the prompt");
  // The derived files are excluded outright, so none of their content reaches the budget.
  assert.ok(!prompt.includes("a line of generated coverage text"), "derived files are excluded");
  assert.ok(!/^\+\+\+ b\/site\//m.test(prompt), "no site diff hunk");
  assert.ok(!/^\+\+\+ b\/\.sdlc\/journal\//m.test(prompt), "no journal diff hunk");
  assert.ok(!/^\+\+\+ b\/\.sdlc\/runs\//m.test(prompt), "no run-record diff hunk");
  // Ordering: the stage's own output comes before the rest of the diff.
  assert.ok(prompt.indexOf("spec/domains/zeta.md") < prompt.indexOf("+++ b/.gitattributes"),
    "the domain file comes before the incidental files");
});

test("a G1 archaeology prompt after one domain is already ratified shows no false criteria-index failure", async () => {
  const dir = microProject();

  // `applications` is already ratified: its domain file mints an `R-` id and
  // `spec/criteria-index.json` reflects exactly that one criterion, on `main`.
  write(dir, "spec/domains/applications.md",
    "# applications\n\n### R-1.1 · v1 · confirmed · recovered\nAn already-ratified criterion.\n- cites: src/a.js\n- state: accepted\n");
  write(dir, "spec/criteria-index.json", JSON.stringify({
    generated_from: "",
    criteria: [{
      id: "R-1.1", version: 1, confidence: "confirmed", origin: "recovered",
      statement: "An already-ratified criterion.", cites: [{ path: "src/a.js" }],
      reconciliation: undefined, given: undefined, when: undefined, then: undefined, notes: [],
      state: "accepted", tier: undefined, replaces: undefined, supersededBy: undefined,
      domain: "applications", file: "spec/domains/applications.md",
    }],
  }, null, 2) + "\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "ratify applications"], dir);

  // An archaeology proposal for `billing`, the second domain, adds fresh provisional
  // criteria that `ratify` has never seen — exactly the state that used to make
  // `checkCriteriaIndex` report the index as stale for reasons that have nothing to do
  // with whether this proposal is sound.
  const name = "archaeology-billing";
  git(["checkout", "-q", "-b", `proposal/${name}`], dir);
  write(dir, "spec/domains/billing.md",
    "# billing\n\n### D-billing-1 · v1 · inferred · recovered\nA freshly recovered criterion.\n- cites: src/b.js\n- state: proposed\n");
  write(dir, ".sdlc/proposals/" + name + ".md", `---\ngate: G1\nquestion: "Is this what billing does?"\nrecommendation: "yes"\nopened: 2026-09-06T00:00:00.000Z\n---\n\n# Is this what billing does?\n`);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "archaeology billing"], dir);

  const prompt = await buildPersonaPrompt(dir, name, "product-owner", { tier: "STANDARD", gate: "G1" });
  assert.ok(!prompt.includes("FAIL criteria-index"), "criteria-index must not appear as a failure in the ruling prompt");
  assert.ok(!prompt.includes("criteria-index"), "criteria-index is left out of the prompt's checks entirely, not merely marked ok");
});

test("a G0 prompt orders intent/ first", async () => {
  const dir = microProject();
  const name = "intent-permit-intake";
  git(["checkout", "-q", "-b", `proposal/${name}`], dir);
  write(dir, "constitution.md", "# constitution\n\n### P1 something\nSource: convention\n");
  write(dir, "intent/permit-intake.md", "# permit intake\n\n## Open questions\n\n- none\n");
  write(dir, ".sdlc/proposals/" + name + ".md", `---\ngate: G0\nquestion: "Right problem?"\nrecommendation: "yes"\nopened: 2026-09-06T00:00:00.000Z\n---\n\n# Right problem?\n`);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "intent"], dir);

  const prompt = await buildPersonaPrompt(dir, name, "product-owner", { tier: "STANDARD", gate: "G0" });
  assert.ok(prompt.indexOf("+++ b/intent/permit-intake.md") < prompt.indexOf("+++ b/constitution.md"),
    "intent/ comes before the constitution change");
});

test("a G3 prompt orders the suite and the adapter first, leaves the proposal page out of the diff, and has room for a whole domain's tests", async () => {
  const dir = microProject();
  const name = "derive-tests-applications";
  git(["checkout", "-q", "-b", `proposal/${name}`], dir);

  // A suite the size a real domain produces: 40 spec files of ~2.5 KB each is about
  // 100 KB of diff, past the 60 KB every other gate is capped at and inside G3's own.
  const body = "  // a line of a blind acceptance test that asserts one thing\n".repeat(40);
  for (let i = 1; i <= 40; i++) {
    write(dir, `tests/acceptance/applications/R-1.${i}.spec.ts`,
      `// criterion: @R-1.${i} v1\n// provenance: blind, spec@0000000, derived 2026-09-07\ntest("R-1.${i}", async () => {\n${body}});\n`);
  }
  write(dir, "tests/adapters/old/index.ts", "export default function create() { return {}; }\n");
  write(dir, "evidence/run.md", "the suite ran\n");
  write(dir, ".gitattributes", "* text=auto\n");
  write(dir, ".sdlc/proposals/" + name + ".md", `---\ngate: G3\nquestion: "Do these tests follow from the criteria?"\nrecommendation: "yes"\nopened: 2026-09-07T00:00:00.000Z\n---\n\n# Do these tests follow from the criteria?\n\nA sentence only the proposal page carries.\n`);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "derive tests"], dir);

  const prompt = await buildPersonaPrompt(dir, name, "product-owner", { tier: "STANDARD", gate: "G3" });

  // The suite comes first, the adapter and the evidence after it, everything else last.
  assert.ok(prompt.indexOf("+++ b/tests/acceptance/applications/R-1.1.spec.ts") < prompt.indexOf("+++ b/tests/adapters/old/index.ts"));
  assert.ok(prompt.indexOf("+++ b/tests/adapters/old/index.ts") < prompt.indexOf("+++ b/evidence/run.md"));
  assert.ok(prompt.indexOf("+++ b/evidence/run.md") < prompt.indexOf("+++ b/.gitattributes"));
  // The raised cap is what lets the last spec file into the diff at all.
  assert.match(prompt, /\+\+\+ b\/tests\/acceptance\/applications\/R-1\.40\.spec\.ts/);
  // The proposal page is quoted in full above, so its diff is never spent on again.
  assert.ok(!/^\+\+\+ b\/\.sdlc\/proposals\//m.test(prompt), "no proposal-page diff hunk");
  assert.match(prompt, /A sentence only the proposal page carries/);
});

test("a G1 prompt keeps the 60 KB cap: a diff past it is cut and the cut is marked", async () => {
  const dir = microProject();
  const name = "archaeology-wide";
  git(["checkout", "-q", "-b", `proposal/${name}`], dir);
  const filler = "a line of ordinary changed text\n".repeat(2500);
  for (let i = 1; i <= 4; i++) write(dir, `notes/n${i}.md`, filler);
  write(dir, "spec/domains/wide.md", "# wide\n\n### D-wide-1 · v1 · confirmed · recovered\nA statement.\n- cites: src/a.js\n- state: proposed\n");
  write(dir, ".sdlc/proposals/" + name + ".md", `---\ngate: G1\nquestion: "Is this wide?"\nrecommendation: "yes"\nopened: 2026-09-07T00:00:00.000Z\n---\n\n# Is this wide?\n`);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "wide"], dir);

  const prompt = await buildPersonaPrompt(dir, name, "product-owner", { tier: "STANDARD", gate: "G1" });
  assert.match(prompt, /further changed file\(s\) not shown|\[truncated\]/);
  assert.match(prompt, /A statement\./, "the domain file is still first, so it survives the cut");
});

test("a G3 prompt distinguishes runner compiler evidence from the blind author's capabilities", async () => {
  const dir = microProject();
  const name = "derive-tests-applications";
  git(["checkout", "-q", "-b", `proposal/${name}`], dir);
  write(dir, `.sdlc/proposals/${name}.md`, "---\ngate: G3\n---\n\n# Review these tests\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "proposal"], dir);
  const revision = git(["rev-parse", "HEAD"], dir);
  const prompt = await buildPersonaPrompt(dir, name, "product-owner", {
    tier: "STANDARD",
    gate: "G3",
    typecheck: {
      revision, command: "node node_modules/typescript/bin/tsc --noEmit",
      directory: "tests", status: "failed", exitCode: 2, output: "R-1.1.spec.ts: error TS2339",
    },
  });
  assert.ok(prompt.includes(revision));
  assert.match(prompt, /Typecheck: \*\*failed\*\*/);
  assert.match(prompt, /error TS2339/);
  assert.match(prompt, /gives its agent no shell/);
  assert.match(prompt, /failed or unavailable check is not a pass/);
  assert.match(prompt, /runner owns executing the check/);
});

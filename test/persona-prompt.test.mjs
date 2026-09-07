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

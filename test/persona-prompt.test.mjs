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
stack: openshift-ts
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
  assert.match(prompt, /further changed file\(s\) not shown|\[truncated: /);
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

// `app/` is left out of a ruling on the spec, and is the whole of a ruling on the build.
// Getting this wrong is silent: the reviewer still receives a proposal, a file summary
// and the checks, so a ruling comes back that looks ordinary and was made without the
// code ever being shown.
test("a build proposal's ruler is shown the application; a spec proposal's ruler is not", async () => {
  const dir = microProject();
  git(["checkout", "-q", "-b", "proposal/build-slice-1"], dir);
  write(dir, "app/backend/src/content.ts", "export const findPage = (slug: string) => slug;\n");
  write(dir, "docs/decisions/0007-a-choice.md", "# 0007\n\nA choice the builder made.\n");
  write(dir, ".sdlc/proposals/build-slice-1.md", "---\ngate: G3\n---\n\n# Does slice 1 hold?\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "build slice 1"], dir);

  // A ruling runs with the proposal's branch checked out, which is where it reads the
  // proposal page from.
  const built = await buildPersonaPrompt(dir, "build-slice-1", "product-owner", { tier: "STANDARD", gate: "G3" });
  assert.match(built, /export const findPage/, "the implementation is the evidence for a build ruling");
  assert.match(built, /A choice the builder made/);
  git(["checkout", "-q", "main"], dir);

  // The same gate, a proposal that is not about the application: a stray app/ file on the
  // branch stays out, so an implementation cannot crowd a ruling on the spec.
  git(["checkout", "-q", "-b", "proposal/derive-tests-applications"], dir);
  write(dir, "tests/acceptance/applications/R-1.1.spec.ts", "// @R-1.1 v1\n");
  write(dir, ".sdlc/proposals/derive-tests-applications.md", "---\ngate: G3\n---\n\n# Do these tests follow?\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "derive tests"], dir);

  const derived = await buildPersonaPrompt(dir, "derive-tests-applications", "product-owner", { tier: "STANDARD", gate: "G3" });
  assert.match(derived, /R-1\.1\.spec\.ts/);
  assert.ok(!/export const findPage/.test(derived), "a ruling on the spec is not shown an implementation");
});

// A build ruling turns on what the acceptance suite established and on the code the
// slice wrote. Both used to depend on surviving a budget that a dependency lockfile and
// a generated type declaration could spend before either was reached.
test("a build ruling is shown the suite, the adapter and the code before anything else, and never the stack's machine-generated files", async () => {
  const dir = microProject();
  git(["checkout", "-q", "-b", "proposal/build-slice-1"], dir);

  // Far larger than the whole G3 budget, and sorted by git ahead of most of app/: the
  // stack profile declares it machine-generated, so it never enters the budget at all.
  write(dir, "app/package-lock.json", `{\n${'  "a line of a resolved dependency tree": "1.0.0",\n'.repeat(4000)}}\n`);
  write(dir, "app/backend/src/content.ts", "export const findPage = (slug: string) => slug;\n");
  write(dir, "tests/acceptance/applications/R-1.1.spec.ts", "// @R-1.1 v1\ntest(\"the suite the slice is judged against\", () => {});\n");
  write(dir, "tests/adapters/new/index.ts", "export default function create() { return { bound: true }; }\n");
  write(dir, "evidence/pr-evidence.md", "what was checked\n");
  write(dir, "docs/decisions/0007-a-choice.md", "# 0007\n\nA choice the builder made.\n");
  write(dir, ".sdlc/proposals/build-slice-1.md", "---\ngate: G3\n---\n\n# Does slice 1 hold?\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "build slice 1"], dir);

  const prompt = await buildPersonaPrompt(dir, "build-slice-1", "product-owner", { tier: "STANDARD", gate: "G3" });

  assert.ok(!prompt.includes("a line of a resolved dependency tree"), "the lockfile's content is not in the prompt");
  assert.match(prompt, /machine-generated/, "the prompt says the file was left out rather than hiding it");
  assert.match(prompt, /app\/package-lock\.json/, "and names it");

  const at = (needle) => { const i = prompt.indexOf(needle); assert.notEqual(i, -1, `${needle} is in the prompt`); return i; };
  assert.ok(at("+++ b/tests/acceptance/applications/R-1.1.spec.ts") < at("+++ b/tests/adapters/new/index.ts"));
  assert.ok(at("+++ b/tests/adapters/new/index.ts") < at("+++ b/app/backend/src/content.ts"));
  assert.ok(at("+++ b/app/backend/src/content.ts") < at("+++ b/evidence/pr-evidence.md"));
  assert.ok(at("+++ b/evidence/pr-evidence.md") < at("+++ b/docs/decisions/0007-a-choice.md"));
});

test("one enormous file cannot spend the whole budget while other files are still unshown", async () => {
  const dir = microProject();
  git(["checkout", "-q", "-b", "proposal/build-slice-1"], dir);
  // Nothing declares this one, so nothing excludes it: the share a single file may take
  // while others wait is what keeps the rest of the diff reachable.
  write(dir, "app/backend/src/aaa-generated.ts", `export const table = [\n${'  "a row of a generated table",\n'.repeat(6000)}];\n`);
  write(dir, "app/backend/src/zzz-handwritten.ts", "export const findPage = (slug: string) => slug;\n");
  write(dir, ".sdlc/proposals/build-slice-1.md", "---\ngate: G3\n---\n\n# Does slice 1 hold?\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "build slice 1"], dir);

  const prompt = await buildPersonaPrompt(dir, "build-slice-1", "product-owner", { tier: "STANDARD", gate: "G3" });
  assert.match(prompt, /export const findPage/, "the file behind the big one is still shown");
  assert.match(prompt, /truncated/);
});

test("the truncation notice names what was cut, so the ruler can go and read it", async () => {
  const dir = microProject();
  git(["checkout", "-q", "-b", "proposal/build-slice-1"], dir);
  const filler = "a line of ordinary changed application code\n".repeat(3000);
  for (const n of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]) write(dir, `app/backend/src/${n}.ts`, filler);
  write(dir, ".sdlc/proposals/build-slice-1.md", "---\ngate: G3\n---\n\n# Does slice 1 hold?\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "build slice 1"], dir);

  const prompt = await buildPersonaPrompt(dir, "build-slice-1", "product-owner", { tier: "STANDARD", gate: "G3" });
  const notice = /\[(\d+) changed file\(s\) not shown[^\]]*\]/.exec(prompt);
  assert.ok(notice, "the cut is marked");
  assert.match(notice[0], /app\/backend\/src\/foxtrot\.ts/, "the file that was cut is named, not counted");
  assert.match(prompt, /[Rr]ead (them|it) on the branch/, "and the ruler is told where to find it");
});

// The verify result is the evidence a build ruling turns on: it says what the acceptance
// suite established about the application on this branch, and it is what an approval is
// refused without. Reaching the ruler only because it happens to be a changed file makes
// it the first thing a large diff drops.
test("a build ruling prompt carries the verify verdict, its rows and its reasons even when the diff is cut", async () => {
  const dir = microProject();
  git(["checkout", "-q", "-b", "proposal/build-slice-1"], dir);
  const filler = "a line of ordinary changed application code\n".repeat(4000);
  for (const n of ["alpha", "bravo", "charlie", "delta", "echo"]) write(dir, `app/backend/src/${n}.ts`, filler);
  write(dir, "tests/results/new/slice-1.json", JSON.stringify({
    slice: 1, proposal: "build-slice-1", app_tree: "0".repeat(40), at: "2026-09-08T00:00:00.000Z",
    verdict: "unbound",
    rows: [
      { id: "R-1.1", result: "pass", tests: [{ title: "a criterion that was met", status: "passed" }] },
      { id: "R-1.2", result: "unbound", tests: [{ title: "a criterion nothing could exercise", status: "failed", error: "Error: unbound: signIn.reviewer — the surface offers no way to sign in" }] },
    ],
  }, null, 2) + "\n");
  write(dir, ".sdlc/proposals/build-slice-1.md", "---\ngate: G3\n---\n\n# Does slice 1 hold?\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "build slice 1"], dir);

  const prompt = await buildPersonaPrompt(dir, "build-slice-1", "product-owner", { tier: "STANDARD", gate: "G3" });

  assert.match(prompt, /further changed file\(s\) not shown|truncated/, "the diff really is cut in this prompt");
  assert.match(prompt, /## Verify result/, "the evidence has a section of its own");
  assert.match(prompt, /unbound/);
  assert.match(prompt, /R-1\.1/);
  assert.match(prompt, /R-1\.2/);
  assert.match(prompt, /the surface offers no way to sign in/, "the adapter's own reason reaches the ruler");
  // The result was recorded against a different application tree than the branch carries.
  assert.match(prompt, /changed since/);
  // An approval is refused on anything but a current pass, and the ruler is told so.
  assert.match(prompt, /return or an escalation/);
});

// A criterion recorded not-testable, or attested to by a person, was never put to the
// application. The reviewer approving the build is the one who decides whether the slice
// can be accepted on that footing, and cannot decide it from a list of ids alone: the
// reason each one carries is the whole of what there is to judge.
test("a build ruling prompt names the criteria nobody asserted and quotes the reason each carries", async () => {
  const dir = microProject();
  git(["checkout", "-q", "-b", "proposal/build-slice-1"], dir);
  write(dir, "app/backend/src/content.ts", "export const findPage = (slug: string) => slug;\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "the application"], dir);
  const appTree = git(["rev-parse", "HEAD:app"], dir).trim();
  write(dir, "tests/results/new/slice-1.json", `${JSON.stringify({
    slice: 1, proposal: "build-slice-1", app_tree: appTree, at: "2026-09-08T00:00:00.000Z",
    verdict: "pass-unasserted",
    unasserted: [
      { id: "R-1.2", result: "not-testable", reason: "the contract surface offers no way to observe it" },
      { id: "R-1.3", result: "attested", reason: "a person vouched for it in place of a test" },
    ],
    rows: [
      { id: "R-1.1", result: "pass", tests: [{ title: "a criterion that was met", status: "passed" }] },
      { id: "R-1.2", result: "not-testable", reason: "the contract surface offers no way to observe it", tests: [] },
      { id: "R-1.3", result: "attested", reason: "a person vouched for it in place of a test", tests: [] },
    ],
  }, null, 2)}\n`);
  write(dir, ".sdlc/proposals/build-slice-1.md", "---\ngate: G3\n---\n\n# Does slice 1 hold?\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "build slice 1"], dir);

  const prompt = await buildPersonaPrompt(dir, "build-slice-1", "product-owner", { tier: "STANDARD", gate: "G3" });
  const section = prompt.slice(prompt.indexOf("## Verify result"), prompt.indexOf("## Diff summary"));
  assert.ok(!/every criterion the slice claims was exercised and met/.test(section),
    "the verdict is not glossed as one where everything was exercised");
  assert.match(section, /2 .*(never asserted|not asserted)/, "the count reaches the ruler");
  assert.match(section, /R-1\.2/);
  assert.match(section, /R-1\.3/);
  assert.match(section, /the contract surface offers no way to observe it/);
  assert.match(section, /a person vouched for it in place of a test/);
  assert.ok(!/changed since/.test(section), "this result is current for the tree on the branch");
});

test("a build proposal with no verify result on its branch says so, and a spec proposal has no such section", async () => {
  const dir = microProject();
  git(["checkout", "-q", "-b", "proposal/build-slice-2"], dir);
  write(dir, "app/backend/src/content.ts", "export const findPage = (slug: string) => slug;\n");
  write(dir, ".sdlc/proposals/build-slice-2.md", "---\ngate: G3\n---\n\n# Does slice 2 hold?\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "build slice 2"], dir);
  const built = await buildPersonaPrompt(dir, "build-slice-2", "product-owner", { tier: "STANDARD", gate: "G3" });
  assert.match(built, /## Verify result/);
  assert.match(built, /no verify result/i);
  git(["checkout", "-q", "main"], dir);

  git(["checkout", "-q", "-b", "proposal/derive-tests-applications"], dir);
  write(dir, "tests/acceptance/applications/R-1.1.spec.ts", "// @R-1.1 v1\n");
  write(dir, ".sdlc/proposals/derive-tests-applications.md", "---\ngate: G3\n---\n\n# Do these tests follow?\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "derive tests"], dir);
  const derived = await buildPersonaPrompt(dir, "derive-tests-applications", "product-owner", { tier: "STANDARD", gate: "G3" });
  assert.ok(!derived.includes("## Verify result"), "a proposal that is not a build has no verify result to be shown");
});

test("a verify result far larger than its section is summarised rather than allowed to spend the budget", async () => {
  const dir = microProject();
  git(["checkout", "-q", "-b", "proposal/build-slice-1"], dir);
  const rows = [];
  for (let i = 1; i <= 300; i++) {
    rows.push({
      id: `R-1.${i}`, result: i % 3 === 0 ? "fail" : "pass",
      tests: [{ title: `criterion ${i}`, status: i % 3 === 0 ? "failed" : "passed", error: i % 3 === 0 ? `Error: ${"a very long browser stack trace line ".repeat(200)}` : undefined }],
    });
  }
  write(dir, "tests/results/new/slice-1.json", JSON.stringify({
    slice: 1, proposal: "build-slice-1", app_tree: "0".repeat(40), at: "2026-09-08T00:00:00.000Z", verdict: "fail", rows,
  }, null, 2) + "\n");
  write(dir, "app/backend/src/content.ts", "export const findPage = (slug: string) => slug;\n");
  write(dir, ".sdlc/proposals/build-slice-1.md", "---\ngate: G3\n---\n\n# Does slice 1 hold?\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "build slice 1"], dir);

  const prompt = await buildPersonaPrompt(dir, "build-slice-1", "product-owner", { tier: "STANDARD", gate: "G3" });
  const section = prompt.slice(prompt.indexOf("## Verify result"), prompt.indexOf("## Diff summary"));
  assert.ok(section.length < 20000, `the section is bounded (was ${section.length})`);
  assert.match(section, /100 criteria did not pass|did not pass/);
  assert.match(prompt, /export const findPage/, "the application is still shown after it");
});

// A ruling on work derived from the criteria is a comparison against what each criterion
// says, and the criterion's text is in none of the derived work. A rewritten test rescues
// itself by accident — its title quotes its criterion — and a deleted one does not.

const STATEMENT_KEPT = "A billing statement is issued on the day the period closes.";
const STATEMENT_GONE = "A refund reverses the charge it names and nothing else.";

// A project whose criteria are ratified: the domain file and the compiled index both on
// `main`, with two spec files derived from them.
function projectWithCriteria() {
  const dir = microProject();
  write(dir, "spec/domains/billing.md",
    "# billing\n\n"
    + `### R-2.1 · v1 · confirmed · recovered\n${STATEMENT_KEPT}\n- when: the period closes\n- then: a statement exists\n- state: accepted\n\n`
    + `### R-2.2 · v2 · inferred · authored\n${STATEMENT_GONE}\n- state: accepted\n`);
  write(dir, "spec/criteria-index.json", `${JSON.stringify({
    generated_from: "0".repeat(40),
    criteria: [
      { id: "R-2.1", version: 1, confidence: "confirmed", state: "accepted", statement: STATEMENT_KEPT, when: "the period closes", then: "a statement exists", domain: "billing", file: "spec/domains/billing.md" },
      { id: "R-2.2", version: 2, confidence: "inferred", state: "accepted", statement: STATEMENT_GONE, domain: "billing", file: "spec/domains/billing.md" },
    ],
  }, null, 2)}\n`);
  write(dir, "tests/acceptance/billing/R-2.1.spec.ts", "// criterion: @R-2.1 v1\n// old body\n");
  write(dir, "tests/acceptance/billing/R-2.2.spec.ts", "// criterion: @R-2.2 v2\n// old body\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "ratified billing"], dir);
  return dir;
}

test("a ruling prompt carries the criteria text for a spec it deletes as well as one it rewrites", async () => {
  const dir = projectWithCriteria();
  const name = "derive-tests-billing-stale-1";
  git(["checkout", "-q", "-b", `proposal/${name}`], dir);
  write(dir, "tests/acceptance/billing/R-2.1.spec.ts", "// criterion: @R-2.1 v1\n// a rewritten body\n");
  git(["rm", "-q", "tests/acceptance/billing/R-2.2.spec.ts"], dir);
  // A criterion recorded as untestable names itself nowhere but in the list it is added to.
  write(dir, "tests/acceptance/not-testable.yaml", "criteria:\n  - id: R-2.2\n    reason: nothing the application exposes can demonstrate it\n");
  write(dir, `.sdlc/proposals/${name}.md`, "---\ngate: G3\n---\n\n# Do these tests still follow?\n\nOne test was written again and one criterion is now recorded as untestable.\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "derive tests again"], dir);

  const prompt = await buildPersonaPrompt(dir, name, "product-owner", { tier: "STANDARD", gate: "G3" });
  assert.match(prompt, /## The criteria this proposal touches/);
  assert.ok(prompt.includes(STATEMENT_KEPT), "the rewritten spec's criterion is quoted");
  // The defect: the deleted spec reaches the ruler as an id and a line of prose, and the
  // reviewer is asked whether the criterion may be recorded as untestable without ever
  // being shown what it says.
  assert.ok(prompt.includes(STATEMENT_GONE), "the deleted spec's criterion is quoted");
  assert.match(prompt, /R-2\.1.*v1.*accepted/);
  assert.match(prompt, /- when: the period closes/);
  // Outside the diff and ahead of it, the same treatment the verify evidence received.
  assert.ok(prompt.indexOf("## The criteria this proposal touches") < prompt.indexOf("## Diff summary"));
});

test("a criterion named only by the proposal's own page is carried too", async () => {
  const dir = projectWithCriteria();
  const name = "plan-v1";
  git(["checkout", "-q", "-b", `proposal/${name}`], dir);
  write(dir, "plan/tasks.md", "# Slices\n\n## Slice 1\n\nClaims: R-2.2\n");
  write(dir, `.sdlc/proposals/${name}.md`, "---\ngate: G2\n---\n\n# Is this the plan?\n\nSlice 1 claims R-2.2.\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "plan"], dir);

  const prompt = await buildPersonaPrompt(dir, name, "product-owner", { tier: "STANDARD", gate: "G2" });
  assert.ok(prompt.includes(STATEMENT_GONE), "a criterion a plan assigns is quoted where the plan is ruled");
});

test("a criterion whose text cannot be resolved is named as missing rather than left out", async () => {
  const dir = projectWithCriteria();
  const name = "derive-tests-billing";
  git(["checkout", "-q", "-b", `proposal/${name}`], dir);
  write(dir, "tests/acceptance/billing/R-2.9.spec.ts", "// criterion: @R-2.9 v1\n");
  write(dir, `.sdlc/proposals/${name}.md`, "---\ngate: G3\n---\n\n# Do these tests follow?\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "a test for an id nothing holds"], dir);

  const prompt = await buildPersonaPrompt(dir, name, "product-owner", { tier: "STANDARD", gate: "G3" });
  assert.match(prompt, /could not be resolved to any criterion text/);
  assert.match(prompt, /R-2\.9/);
  assert.match(prompt, /not a statement that\n?these criteria do not exist/);
});

test("a criterion defined in a file the proposal itself changes is named there, not quoted twice", async () => {
  const dir = projectWithCriteria();
  const name = "calibrate-billing";
  git(["checkout", "-q", "-b", `proposal/${name}`], dir);
  write(dir, "spec/domains/billing.md",
    "# billing\n\n"
    + `### R-2.1 · v2 · confirmed · recovered\n${STATEMENT_KEPT}\n- state: accepted\n`);
  write(dir, `.sdlc/proposals/${name}.md`, "---\ngate: G1\n---\n\n# Is R-2.1 right now?\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "calibrate billing"], dir);

  const prompt = await buildPersonaPrompt(dir, name, "product-owner", { tier: "STANDARD", gate: "G1" });
  const section = prompt.slice(prompt.indexOf("## The criteria this proposal touches"), prompt.indexOf("## Diff summary"));
  assert.match(section, /defined in files this proposal itself changes/);
  assert.match(section, /R-2\.1/);
  assert.ok(!section.includes(STATEMENT_KEPT), "the domain file's own text is the diff, not a second copy of it");
});

test("a proposal that names no criterion gets no criteria section at all", async () => {
  const dir = projectWithCriteria();
  const name = "intent-permit-intake";
  git(["checkout", "-q", "-b", `proposal/${name}`], dir);
  write(dir, "intent/brief.md", "# Brief\n\nWhat the rebuild is for.\n");
  write(dir, `.sdlc/proposals/${name}.md`, "---\ngate: G0\n---\n\n# Is this the right problem?\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "intent"], dir);

  const prompt = await buildPersonaPrompt(dir, name, "product-owner", { tier: "STANDARD", gate: "G0" });
  assert.ok(!prompt.includes("## The criteria this proposal touches"));
});

test("a proposal touching many criteria is capped, and says what it capped", async () => {
  const dir = microProject();
  const criteria = [];
  const blocks = [];
  for (let i = 1; i <= 90; i++) {
    const statement = `Criterion ${i}: ${"a long sentence about what the system does ".repeat(40)}`;
    criteria.push({ id: `R-2.${i}`, version: 1, confidence: "confirmed", state: "accepted", statement, domain: "billing", file: "spec/domains/billing.md" });
    blocks.push(`### R-2.${i} · v1 · confirmed · recovered\n${statement}\n- state: accepted\n`);
  }
  write(dir, "spec/domains/billing.md", `# billing\n\n${blocks.join("\n")}`);
  write(dir, "spec/criteria-index.json", `${JSON.stringify({ generated_from: "0".repeat(40), criteria }, null, 2)}\n`);
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "ratified"], dir);

  const name = "derive-tests-billing";
  git(["checkout", "-q", "-b", `proposal/${name}`], dir);
  for (let i = 1; i <= 90; i++) write(dir, `tests/acceptance/billing/R-2.${i}.spec.ts`, `// criterion: @R-2.${i} v1\n`);
  write(dir, `.sdlc/proposals/${name}.md`, "---\ngate: G3\n---\n\n# Do these tests follow?\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "a suite"], dir);

  const prompt = await buildPersonaPrompt(dir, name, "product-owner", { tier: "STANDARD", gate: "G3" });
  const section = prompt.slice(prompt.indexOf("## The criteria this proposal touches"), prompt.indexOf("## Diff summary"));
  assert.ok(section.length < 20000, `the section is bounded (was ${section.length})`);
  assert.match(section, /further criterion\(s\) are named by this proposal and not quoted here/);
  assert.match(section, /R-2\.90/, "what was left out is named, so the ruler can go and read it");
});

// A condition naming a path the stage cannot write is refused when the verdict is recorded,
// and by then the ruling turn has been paid for. The ruler is told first instead.
test("a prompt for a proposal that goes back to a stage says what that stage can deliver", async () => {
  const dir = microProject();
  const name = "build-slice-1";
  git(["checkout", "-q", "-b", `proposal/${name}`], dir);
  write(dir, "app/routes/list.tsx", "export const List = () => null;\n");
  write(dir, ".sdlc/proposals/" + name + ".md", `---\ngate: G3\nquestion: "Does slice 1 do what its criteria say?"\nrecommendation: "yes"\nopened: 2026-09-06T00:00:00.000Z\n---\n\n# Does slice 1 do what its criteria say?\n`);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "build slice 1"], dir);

  const prompt = await buildPersonaPrompt(dir, name, "product-owner", { tier: "STANDARD", gate: "G3" });
  assert.match(prompt, /## What a condition may ask for/);
  assert.match(prompt, /it delivers app, docs\/decisions and nothing else/);
  assert.match(prompt, /addressed-to <stage>: /);
});

// An ordinary ruling prompt is unchanged: a proposal whose conditions are read in a closed
// grammar goes back to no `--revise` run at all.
test("a prompt for a proposal that goes back to no stage carries no deliverability section", async () => {
  const dir = microProject();
  const name = "ratify-zeta-2";
  git(["checkout", "-q", "-b", `proposal/${name}`], dir);
  write(dir, "spec/domains/zeta.md", "# zeta\n");
  write(dir, ".sdlc/proposals/" + name + ".md", `---\ngate: G1\nquestion: "Which become the contract?"\nrecommendation: "rule each"\nopened: 2026-09-06T00:00:00.000Z\n---\n\n# Which become the contract?\n`);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "ratify follow-up"], dir);

  const prompt = await buildPersonaPrompt(dir, name, "product-owner", { tier: "STANDARD", gate: "G1" });
  assert.ok(!prompt.includes("## What a condition may ask for"));
});

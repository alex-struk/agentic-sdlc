import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPlanConstitution, checkPlanCoverage, parseTasks, planShape } from "../src/checks/plan.mjs";
import { stageFor } from "../src/stages/registry.mjs";

const TASKS = `# Slices

### Slice 1 · A vendor can find and read an opportunity
- criteria: R-1.1, R-1.2
- delivers: the list and the public view

### Slice 2 · A vendor can bid
- criteria: R-2.1
- delivers: the proposal form
`;

function project(t, { plan, tasks } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-plan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "plan"), { recursive: true });
  if (plan !== undefined) writeFileSync(join(dir, "plan", "plan.md"), plan);
  if (tasks !== undefined) writeFileSync(join(dir, "plan", "tasks.md"), tasks);
  return dir;
}

test("slices are read from their headings, with the criteria each names", () => {
  const { slices, errors } = parseTasks(TASKS);
  assert.deepEqual(errors, []);
  assert.equal(slices.length, 2);
  assert.equal(slices[0].title, "A vendor can find and read an opportunity");
  assert.deepEqual(slices[0].criteria, ["R-1.1", "R-1.2"]);
  assert.deepEqual(slices[1].criteria, ["R-2.1"]);
});

test("a slice naming no criteria is an error wherever it sits", () => {
  const middle = parseTasks(`### Slice 1 · Nothing\n- delivers: x\n\n### Slice 2 · Something\n- criteria: R-1.1\n`);
  assert.match(middle.errors.join("\n"), /slice 1 names no criteria/);
  const last = parseTasks(`### Slice 1 · Something\n- criteria: R-1.1\n\n### Slice 2 · Nothing\n- delivers: x\n`);
  assert.match(last.errors.join("\n"), /slice 2 names no criteria/);
});

// The one this check exists for: a criterion that was written down, ratified and tested, and
// that no slice was ever going to build.
test("an accepted criterion no slice builds fails", (t) => {
  const dir = project(t, { tasks: TASKS });
  const r = checkPlanCoverage(dir, ["R-1.1", "R-1.2", "R-2.1", "R-3.9"]);
  assert.equal(r.ok, false);
  assert.match(r.messages.join("\n"), /R-3\.9 is accepted and no slice builds it/);
});

test("a criterion in two slices fails, and one the spec never accepted fails", (t) => {
  const twice = project(t, { tasks: `${TASKS}\n### Slice 3 · Again\n- criteria: R-1.1\n` });
  assert.match(checkPlanCoverage(twice, ["R-1.1", "R-1.2", "R-2.1"]).messages.join("\n"),
    /R-1\.1 is in slice 1 and slice 3/);

  const invented = project(t, { tasks: `### Slice 1 · Invented\n- criteria: R-9.9\n` });
  assert.match(checkPlanCoverage(invented, ["R-1.1"]).messages.join("\n"),
    /R-9\.9 is not an accepted criterion/);
});

test("a plan covering every accepted criterion once passes", (t) => {
  const dir = project(t, { tasks: TASKS });
  const r = checkPlanCoverage(dir, ["R-1.1", "R-1.2", "R-2.1"]);
  assert.equal(r.ok, true, r.messages.join(" | "));
});

test("the constitution check must be answered, not just headed", (t) => {
  assert.match(checkPlanConstitution(project(t, { plan: "# Plan\n" })).messages.join("\n"),
    /no "## Constitution check" section/);
  assert.match(checkPlanConstitution(project(t, { plan: "# Plan\n\n## Constitution check\n\n## Next\n" })).messages.join("\n"),
    /section is empty/);
  assert.equal(checkPlanConstitution(project(t, { plan: "# Plan\n\n## Constitution check\n\nRule 3 binds here because the suite is blind.\n" })).ok, true);
});

// Not refused — only a person can say whether a big slice is really one piece of work — but
// put in front of the persona that can.
test("a slice carrying most of the spec is warned about, not failed", (t) => {
  const lopsided = `### Slice 1 · Everything\n- criteria: ${Array.from({ length: 30 }, (_, i) => `R-1.${i + 1}`).join(", ")}\n\n### Slice 2 · A little\n- criteria: R-2.1\n`;
  const dir = project(t, { tasks: lopsided });
  const { warnings } = planShape(dir);
  assert.match(warnings.join("\n"), /slice 1 carries 30 of 31 criteria; a slice that large is a phase/);
});

test("plan holds gate G2, is not per-domain, and refuses to run before the screens are drawn", () => {
  const stage = stageFor("plan");
  assert.equal(stage.implemented, true);
  assert.equal(stage.gate, "G2");
  assert.equal(stage.workspace, "spec-and-design");
  assert.deepEqual(stage.collect, ["plan", "docs/decisions"]);
  assert.equal(stage.title, "plan");
  const checks = stage.preChecks(".", { config: {} });
  assert.ok(checks.some((r) => r.id === "plan-has-criteria" && !r.ok));
  assert.ok(checks.some((r) => r.id === "plan-has-design" && !r.ok));
});

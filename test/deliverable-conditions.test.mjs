// A ruling's plain conditions are free text a stage reads and acts on, and the stage that
// reads them can only write the paths its own workspace collects. A condition naming
// anything else is a ruling nobody can carry out: the stage either fails at it or finds a
// way, and the second is worse, because the work is reported as done and then dropped.
//
// It is caught where it is cheapest to fix — at the ruling, with the ruler still there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionPaths } from "../src/spec/criteria.mjs";
import { deliverableBy, pipelineOwns, stageForProposal, undeliverableConditions } from "../src/stages/registry.mjs";
import { assertDeliverableRulable } from "../src/commands/rule.mjs";

test("a condition's path-like tokens are the ones the pipeline owns", () => {
  assert.deepEqual(conditionPaths("Move the criterion out of plan/tasks.md and into slice 3."), ["plan/tasks.md"]);
  assert.deepEqual(conditionPaths("Give app/routes/list.tsx an accessible name."), ["app/routes/list.tsx"]);
  assert.deepEqual(conditionPaths("Record the choice in `docs/decisions/0031-a-choice.md`."), ["docs/decisions/0031-a-choice.md"]);
  assert.deepEqual(conditionPaths("The constitution.md glossary is missing the term."), ["constitution.md"]);
});

// "the plan" and "the spec" are how people write about work, and reading either as a path
// would refuse most of the rulings anyone writes.
test("a bare word that happens to name a directory is not a path", () => {
  assert.deepEqual(conditionPaths("Rework the plan so the second slice stands alone."), []);
  assert.deepEqual(conditionPaths("The spec says this differently."), []);
  assert.deepEqual(conditionPaths("Use a smaller heading."), []);
});

test("a path outside anything the pipeline owns is left alone", () => {
  assert.deepEqual(conditionPaths("Follow the convention in vendor/thing/readme.txt.", pipelineOwns), []);
  assert.deepEqual(conditionPaths("Move the criterion out of plan/tasks.md.", pipelineOwns), ["plan/tasks.md"]);
});

test("a proposal name resolves to the stage that would be asked to revise it", () => {
  assert.equal(stageForProposal("build-slice-2"), "build");
  assert.equal(stageForProposal("build-slice-2-3"), "build");
  assert.equal(stageForProposal("plan"), "plan");
  assert.equal(stageForProposal("plan-4"), "plan");
  assert.equal(stageForProposal("design-users"), "design");
  assert.equal(stageForProposal("derive-tests-users-2"), "derive-tests");
  assert.equal(stageForProposal("bind-adapter-new"), "bind-adapter");
  assert.equal(stageForProposal("ratify-users-2"), null);
  assert.equal(stageForProposal("calibrate-old-1"), null);
});

test("which stages can deliver a path is read off the registry, not listed a second time", () => {
  assert.deepEqual(deliverableBy("plan/tasks.md"), ["plan"]);
  assert.deepEqual(deliverableBy("app/routes/list.tsx"), ["build"]);
  assert.deepEqual(deliverableBy("docs/decisions/0031-a-choice.md"), ["build", "plan"]);
  assert.deepEqual(deliverableBy("constitution.md"), []);
});

test("a condition naming a path the stage delivers is not flagged", () => {
  assert.deepEqual(undeliverableConditions("build-slice-1", ["Give app/routes/list.tsx an accessible name."]), []);
  assert.deepEqual(undeliverableConditions("build-slice-1", ["Explain the choice in the journal."]), []);
});

test("a condition naming a path the stage cannot deliver is flagged with the stage that can", () => {
  const found = undeliverableConditions("build-slice-1", ["Move the criterion out of plan/tasks.md and into slice 3."]);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, "plan/tasks.md");
  assert.deepEqual(found[0].deliverableBy, ["plan"]);
});

test("a proposal that goes back to no stage at all is not checked", () => {
  assert.deepEqual(undeliverableConditions("ratify-users-2", ["Move the criterion out of plan/tasks.md."]), []);
});

test("a return carrying an undeliverable condition is refused, naming the path and the form to use", () => {
  assert.throws(
    () => assertDeliverableRulable("build-slice-1", "return", ["Move the criterion out of plan/tasks.md and into slice 3."]),
    (e) => {
      assert.match(e.message, /rule build-slice-1/);
      assert.match(e.message, /plan\/tasks\.md/);
      assert.match(e.message, /build delivers app, docs\/decisions/);
      assert.match(e.message, /addressed-to plan: /);
      return true;
    },
  );
});

test("a path no stage delivers is refused too, and says so rather than naming a stage", () => {
  assert.throws(
    () => assertDeliverableRulable("build-slice-1", "return", ["Add the term to constitution.md."]),
    /no stage in this pipeline delivers it/,
  );
});

test("an approval and a deliverable return both pass", () => {
  assert.doesNotThrow(() => assertDeliverableRulable("build-slice-1", "approve", ["Move the criterion out of plan/tasks.md."]));
  assert.doesNotThrow(() => assertDeliverableRulable("build-slice-1", "return", ["Give app/routes/list.tsx an accessible name."]));
});

// `addressed-to` and `test-overreaches` already route to another stage by name. Reading
// them here as well would refuse a ruling for saying, correctly, that the work belongs
// somewhere else.
test("a condition already addressed to another stage is not read as a plain one", () => {
  assert.doesNotThrow(() => assertDeliverableRulable("build-slice-1", "return",
    ["addressed-to plan: slice 2 claims a criterion it cannot demonstrate; move it to a later slice."]));
});

// test/profiles.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGES, PROFILES, stagesFor } from "../src/profiles.mjs";

// `bind-adapter` precedes `derive-tests`: an adapter is derived from the contract alone,
// and until one exists nothing can execute, so a contract defect stays invisible through
// every derivation that follows it (docs/decisions/0007-calibrate-before-mass-derivation.md).
test("sixteen stages, binding before derivation", () => {
  assert.deepEqual(STAGES, ["init","intent","archaeology","ratify","contract","bind-adapter","derive-tests",
    "calibrate","design","plan","build","verify","deploy","operate","status"]);
  assert.ok(STAGES.indexOf("bind-adapter") < STAGES.indexOf("derive-tests"));
  assert.ok(STAGES.indexOf("derive-tests") < STAGES.indexOf("calibrate"));
});

test("profiles select stages as the spec says", () => {
  assert.ok(!stagesFor("greenfield").includes("archaeology"));
  assert.ok(!stagesFor("greenfield").includes("calibrate"));
  assert.deepEqual(stagesFor("rebuild"), STAGES);
  assert.ok(!stagesFor("remediation").includes("intent"));
  assert.ok(!stagesFor("remediation").includes("design"));
  assert.deepEqual(stagesFor("feature"), ["init","intent","plan","build","verify","deploy","status"]);
  assert.throws(() => stagesFor("bespoke"));
  assert.equal(Object.keys(PROFILES).length, 4);
});

test("contract sits after ratify in every profile that has derive-tests", () => {
  for (const [name, stages] of Object.entries(PROFILES)) {
    if (!stages.includes("derive-tests")) continue;
    assert.ok(stages.includes("contract"), `${name} has derive-tests but not contract`);
    assert.ok(stages.indexOf("contract") > stages.indexOf("ratify"), `${name}: contract must come after ratify`);
  }
  assert.ok(!stagesFor("feature").includes("contract"));
});

// test/profiles.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGES, PROFILES, stagesFor } from "../src/profiles.mjs";

test("fifteen stages in spec order", () => {
  assert.deepEqual(STAGES, ["init","intent","archaeology","ratify","derive-tests","bind-adapter",
    "calibrate","design","plan","build","verify","review-and-ship","deploy","operate","status"]);
});

test("profiles select stages as the spec says", () => {
  assert.ok(!stagesFor("greenfield").includes("archaeology"));
  assert.ok(!stagesFor("greenfield").includes("calibrate"));
  assert.deepEqual(stagesFor("rebuild"), STAGES);
  assert.ok(!stagesFor("remediation").includes("intent"));
  assert.ok(!stagesFor("remediation").includes("design"));
  assert.deepEqual(stagesFor("feature"), ["init","intent","plan","build","verify","review-and-ship","deploy","status"]);
  assert.throws(() => stagesFor("bespoke"));
  assert.equal(Object.keys(PROFILES).length, 4);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { addRebind, readRebind, readRebindFor, removeRebind, REBIND_PATH } from "../src/spec/rebind.mjs";
import { applyCalibrateRulings, calibrateConditionParses, CALIBRATE_GRAMMAR } from "../src/spec/criteria.mjs";
import { stageFor } from "../src/stages/registry.mjs";

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-rebind-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "tests", "adapters"), { recursive: true });
  return dir;
}

const criteria = () => [
  { id: "R-1.1", version: 1, statement: "a thing happens", notes: [], state: "accepted" },
  { id: "R-1.2", version: 1, statement: "another thing happens", notes: [], state: "accepted" },
];

// The verb exists because the three the grammar started with could not say what the first
// full calibration of a real project mostly found. Ruling an adapter fault with one of them
// does harm: defect-in-old makes it an obligation on the rebuild, test-wrong sends a sound
// test back for a blind rewrite that hits the same binding again.
test("adapter-wrong is a verb, and it moves nothing about the criterion", () => {
  assert.ok(calibrateConditionParses("adapter-wrong R-1.1: reads the tab title, not the heading"));
  assert.ok(CALIBRATE_GRAMMAR.includes("adapter-wrong"));

  const before = criteria();
  const { criteria: after, rebind, applied } = applyCalibrateRulings(
    before, ["adapter-wrong R-1.1: reads the tab title, not the heading"], "2026-09-14");
  assert.deepEqual(rebind, [{ id: "R-1.1", why: "reads the tab title, not the heading" }]);
  assert.equal(after[0].version, 1, "no version bump");
  assert.equal(after[0].statement, "a thing happens", "no restatement");
  assert.deepEqual(after[0].notes, [], "no note on the criterion");
  assert.equal(applied.length, 1, "still recorded as ruled, so the row stops being asked about");
});

test("adapter-wrong needs a reason, like every verb that is not defect-in-old", () => {
  assert.ok(!calibrateConditionParses("adapter-wrong R-1.1"));
  assert.ok(!calibrateConditionParses("adapter-wrong R-1.1:"));
});

test("a finding is kept per target, and the first reason for a pair is the one kept", (t) => {
  const dir = project(t);
  assert.equal(addRebind(dir, [{ id: "R-1.1", target: "old", why: "first" }]), REBIND_PATH);
  addRebind(dir, [{ id: "R-1.1", target: "old", why: "second" }]);
  addRebind(dir, [{ id: "R-1.1", target: "new", why: "a different adapter" }]);
  assert.deepEqual(readRebind(dir).map((e) => [e.target, e.why]),
    [["old", "first"], ["new", "a different adapter"]]);
  assert.deepEqual(readRebindFor(dir, "new").map((e) => e.why), ["a different adapter"]);
});

test("acting on a finding clears it for that target and leaves the others", (t) => {
  const dir = project(t);
  addRebind(dir, [
    { id: "R-1.1", target: "old", why: "x" },
    { id: "R-1.2", target: "old", why: "y" },
    { id: "R-1.1", target: "new", why: "z" },
  ]);
  removeRebind(dir, "old", ["R-1.1"]);
  assert.deepEqual(readRebind(dir).map((e) => `${e.target} ${e.id}`), ["old R-1.2", "new R-1.1"]);
  assert.ok(existsSync(join(dir, REBIND_PATH)));
  assert.ok(Array.isArray(parseYaml(readFileSync(join(dir, REBIND_PATH), "utf8")).rebind));
});

test("a binding run is told what the calibration found, and told to look again before refusing twice", () => {
  const stage = stageFor("bind-adapter");
  const prompt = stage.prompt({
    target: "old", bindAdapterBaseUrl: "http://localhost:3000", bindAdapterIdentity: "session-route",
    bindAdapterRebind: [{ id: "R-1.8", why: 'reported "Save Draft" missing; the application renders it' }],
  });
  assert.match(prompt, /A calibration run found these bindings wanting/);
  assert.match(prompt, /- R-1\.8: reported "Save Draft" missing/);
  assert.match(prompt, /before reporting it unbound a second time/);
  assert.doesNotMatch(stage.prompt({ target: "old", bindAdapterBaseUrl: "http://x", bindAdapterRebind: [] }),
    /A calibration run found/);
});

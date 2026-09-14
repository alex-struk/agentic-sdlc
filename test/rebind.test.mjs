import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { addRebind, readRebind, readRebindFor, removeRebind, REBIND_PATH } from "../src/spec/rebind.mjs";
import { CALIBRATE_GRAMMAR, TRIAGE_GRAMMAR, calibrateConditionParses, triageConditionParses } from "../src/spec/criteria.mjs";
import { conditionGrammarFor, rulingTurns } from "../src/commands/rule.mjs";
import { applyTriageGates, expireAdapterVerdicts } from "../src/stages/calibrate.mjs";
import { stageFor } from "../src/stages/registry.mjs";

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-rebind-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "tests", "adapters"), { recursive: true });
  return dir;
}

// Whether a test's browser driver read the right element is a technical question, and the
// product owner is the wrong role to ask it. The verb lives in the reviewer's grammar and
// nowhere in the product owner's.
test("the product owner's grammar has its three verbs and no adapter verdict", () => {
  assert.ok(!CALIBRATE_GRAMMAR.includes("adapter-wrong"));
  assert.ok(!calibrateConditionParses("adapter-wrong R-1.1: reads the tab title"));
  for (const verb of ["defect-in-old", "spec-wrong", "test-wrong"]) assert.ok(CALIBRATE_GRAMMAR.includes(verb), verb);
});

test("the reviewer's triage grammar sorts a failure one of two ways", () => {
  assert.ok(TRIAGE_GRAMMAR.includes("adapter-wrong") && TRIAGE_GRAMMAR.includes("product-question"));
  assert.ok(triageConditionParses("adapter-wrong R-1.1: reads the browser tab title, not the page heading"));
  assert.ok(triageConditionParses("product-question R-1.2"));
  assert.ok(!triageConditionParses("adapter-wrong R-1.1"), "an adapter verdict names what the adapter did");
  assert.ok(!triageConditionParses("product-question R-1.2: because"), "passing a failure on needs no reason");
  assert.ok(!triageConditionParses("defect-in-old R-1.2"), "a product ruling is not a triage verdict");
});

test("a triage proposal is read in its own grammar at G3, with a G1-sized budget", () => {
  const triage = conditionGrammarFor("calibrate-triage-old-1");
  assert.equal(triage.label, "triage");
  assert.equal(triage.checked, true);
  assert.equal(conditionGrammarFor("calibrate-old-1").label, "calibration");
  const config = { policy: { budgets: {} } };
  assert.ok(rulingTurns(config, "G3", "calibrate-triage-old-1") > rulingTurns(config, "G3", "bind-adapter-old-2"));
});

test("a finding is kept per target, and the first reason for a pair is the one kept", (t) => {
  const dir = project(t);
  assert.equal(addRebind(dir, [{ id: "R-1.1", target: "old", why: "first" }]), REBIND_PATH);
  addRebind(dir, [{ id: "R-1.1", target: "old", why: "second" }]);
  addRebind(dir, [{ id: "R-1.1", target: "new", why: "a different adapter" }]);
  assert.deepEqual(readRebind(dir).map((e) => [e.target, e.why]), [["old", "first"], ["new", "a different adapter"]]);
  assert.deepEqual(readRebindFor(dir, "new").map((e) => e.why), ["a different adapter"]);
});

test("removing findings for one target leaves the others", (t) => {
  const dir = project(t);
  addRebind(dir, [
    { id: "R-1.1", target: "old", why: "x" },
    { id: "R-1.2", target: "old", why: "y" },
    { id: "R-1.1", target: "new", why: "z" },
  ]);
  removeRebind(dir, "old", ["R-1.1"]);
  assert.deepEqual(readRebind(dir).map((e) => `${e.target} ${e.id}`), ["old R-1.2", "new R-1.1"]);
  assert.ok(Array.isArray(parseYaml(readFileSync(join(dir, REBIND_PATH), "utf8")).rebind));
});

test("a binding run is told what the reviewer found, and told to look again before refusing twice", () => {
  const stage = stageFor("bind-adapter");
  const prompt = stage.prompt({
    target: "old", bindAdapterBaseUrl: "http://localhost:3000", bindAdapterIdentity: "session-route",
    bindAdapterRebind: [{ id: "R-1.8", why: 'reported "Save Draft" missing; the page renders it' }],
  });
  assert.match(prompt, /the reviewer found the criterion and the test sound/);
  assert.match(prompt, /- R-1\.8: reported "Save Draft" missing/);
  assert.match(prompt, /before reporting it unbound a second time/);
  assert.doesNotMatch(stage.prompt({ target: "old", bindAdapterBaseUrl: "http://x", bindAdapterRebind: [] }), /A calibration run found/);
});

// ---- applying the reviewer's sorting, and letting an adapter verdict lapse ----

function gitProject(t) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-triage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "spec"), { recursive: true });
  mkdirSync(join(dir, "tests", "adapters", "old"), { recursive: true });
  mkdirSync(join(dir, ".sdlc", "gates"), { recursive: true });
  writeFileSync(join(dir, "spec", "criteria-index.json"), JSON.stringify({
    generated_from: "abc123",
    criteria: [
      { id: "R-1.1", domain: "billing", state: "accepted", version: 1 },
      { id: "R-1.2", domain: "billing", state: "accepted", version: 1 },
    ],
  }));
  writeFileSync(join(dir, "tests", "adapters", "old", "index.ts"), "export default 1;\n");
  writeFileSync(join(dir, ".sdlc", "gates", "calibrate-triage-old-1.yaml"), [
    "gate: G3", "verdict: approve", "by: agent:reviewer", "held_by: agent", "rationale: sorted",
    "conditions:",
    '  - "adapter-wrong R-1.1: reads the browser tab title, not the page heading"',
    '  - "product-question R-1.2"',
    "",
  ].join("\n"));
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.test"]);
  run(["config", "user.name", "t"]);
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "start"]);
  return { dir, run };
}

test("applying a triage ruling lists the adapter's failures for rebinding and touches no criterion", (t) => {
  const { dir } = gitProject(t);
  const before = readFileSync(join(dir, "spec", "criteria-index.json"), "utf8");
  const r = applyTriageGates(dir, "old");
  assert.deepEqual(r.gateNames, ["calibrate-triage-old-1"]);
  assert.deepEqual(readRebindFor(dir, "old").map((e) => [e.id, e.why]), [["R-1.1", "reads the browser tab title, not the page heading"]]);
  const applied = parseYaml(readFileSync(join(dir, "tests", "results", "old", "applied.yaml"), "utf8"));
  assert.deepEqual(applied.rulings.map((x) => `${x.id} ${x.verb}`), ["R-1.1 adapter-wrong", "R-1.2 product-question"]);
  assert.ok(applied.rulings.find((x) => x.verb === "adapter-wrong").adapter, "an adapter verdict records which adapter it was about");
  assert.equal(readFileSync(join(dir, "spec", "criteria-index.json"), "utf8"), before);
  assert.deepEqual(applyTriageGates(dir, "old").gateNames, [], "a ruling already applied is not applied again");
});

// Kept for ever, an adapter verdict would hold a row out of both queues after the binding
// meant to fix it had landed, so a fix that did not work would never be noticed.
test("an adapter verdict lapses once the adapter changes, and a passed-on failure does not", (t) => {
  const { dir, run } = gitProject(t);
  applyTriageGates(dir, "old");
  assert.deepEqual(expireAdapterVerdicts(dir, "old"), [], "nothing lapses while the adapter is the one it was about");

  writeFileSync(join(dir, "tests", "adapters", "old", "index.ts"), "export default 2;\n");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "rebind"]);
  const changed = expireAdapterVerdicts(dir, "old");
  assert.ok(changed.length > 0);
  const applied = parseYaml(readFileSync(join(dir, "tests", "results", "old", "applied.yaml"), "utf8"));
  assert.deepEqual(applied.rulings.map((x) => `${x.id} ${x.verb}`), ["R-1.2 product-question"]);
  assert.deepEqual(readRebindFor(dir, "old"), []);
  assert.ok(existsSync(join(dir, REBIND_PATH)));
});

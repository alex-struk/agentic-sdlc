import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGES } from "../src/profiles.mjs";
import { stageFor, skillText, firstSentence } from "../src/stages/registry.mjs";

test("probe has no gate and is implemented", () => {
  const probe = stageFor("probe");
  assert.equal(probe.gate, null);
  assert.equal(probe.implemented, true);
  assert.equal(probe.proposal(), null);
});

test("probe post-check passes when app/PROBE.md has the sentence", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-probe-"));
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, "app", "PROBE.md"), "2026-09-06\nthe runner works\n");
  const results = stageFor("probe").postChecks(d, {});
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.ok));
});

test("probe post-check fails when app/PROBE.md is absent", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-probe-"));
  const results = stageFor("probe").postChecks(d, {});
  assert.ok(results.some((r) => !r.ok));
});

test("probe post-check fails when app/PROBE.md is missing the sentence", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-probe-"));
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, "app", "PROBE.md"), "2026-09-06\n");
  const results = stageFor("probe").postChecks(d, {});
  assert.ok(results.some((r) => !r.ok));
});

test("every stage name from profiles.mjs other than probe and intent is an unimplemented stub", () => {
  for (const name of STAGES) {
    if (name === "intent") continue;
    const stage = stageFor(name);
    assert.equal(stage.implemented, false, name);
    assert.equal(stage.workspace, "project", name);
    assert.throws(() => stage.prompt({}), /not implemented/, name);
  }
});

test("intent holds gate G0, is implemented, and its prompt does not throw", () => {
  const stage = stageFor("intent");
  assert.equal(stage.implemented, true);
  assert.equal(stage.gate, "G0");
  assert.equal(stage.workspace, "project");
  assert.doesNotThrow(() => stage.prompt({}));
});

test("stageFor(\"archaeology\") is a stub whose prompt throws not implemented", () => {
  const stage = stageFor("archaeology");
  assert.equal(stage.implemented, false);
  assert.throws(() => stage.prompt({}), /stage archaeology is not implemented yet/);
});

test("stageFor throws unknown stage for a bogus name", () => {
  assert.throws(() => stageFor("bogus"), /unknown stage: bogus/);
});

test("skillText concatenates the preamble and the stage skill", () => {
  const text = skillText("probe");
  assert.match(text, /one stage of a longer pipeline/);
  assert.match(text, /app\/PROBE\.md/);
});

test("firstSentence extracts the first sentence, handling dots in filenames", () => {
  const result = firstSentence("Read intent/brief.md and wrote intent/x.md. Then more.");
  assert.equal(result, "Read intent/brief.md and wrote intent/x.md.");
});

test("firstSentence returns whole trimmed text when no terminator is present", () => {
  const result = firstSentence("This text has no sentence terminator");
  assert.equal(result, "This text has no sentence terminator");
});

test("firstSentence caps sentences longer than 200 characters with ellipsis", () => {
  const longText = "x".repeat(250) + ". More text.";
  const result = firstSentence(longText);
  assert.equal(result.length, 201);
  assert.ok(result.endsWith("…"));
});

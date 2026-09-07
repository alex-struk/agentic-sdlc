import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGES } from "../src/profiles.mjs";
import { stageFor, skillText, recommendationFrom } from "../src/stages/registry.mjs";

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

test("every stage name from profiles.mjs other than probe, intent, archaeology and ratify is an unimplemented stub", () => {
  for (const name of STAGES) {
    if (name === "intent" || name === "archaeology" || name === "ratify") continue;
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

test("archaeology holds gate G1, is implemented, workspace with-sources, and its prompt does not throw", () => {
  const stage = stageFor("archaeology");
  assert.equal(stage.implemented, true);
  assert.equal(stage.gate, "G1");
  assert.equal(stage.workspace, "with-sources");
  assert.doesNotThrow(() => stage.prompt({ domain: "applications" }));
});

test("archaeology pre-checks fail without --domain, and with a domain not in config", () => {
  const stage = stageFor("archaeology");
  const cfg = { project: { domains: ["applications"] }, sources: { old: { repo: "x", commit: "abc1234" } } };
  const missing = stage.preChecks(".", { domain: undefined, config: cfg });
  assert.ok(missing.some((r) => !r.ok && /--domain/.test(r.messages.join(" "))));
  const wrong = stage.preChecks(".", { domain: "bogus", config: cfg });
  assert.ok(wrong.some((r) => !r.ok && /not in project\.domains/.test(r.messages.join(" "))));
  const noSources = stage.preChecks(".", { domain: "applications", config: { project: { domains: ["applications"] } } });
  assert.ok(noSources.some((r) => !r.ok && /sources\.old/.test(r.messages.join(" "))));
});

test("ratify holds no gate, is implemented, runs no agent, and its pre-checks fail without --domain", () => {
  const stage = stageFor("ratify");
  assert.equal(stage.implemented, true);
  assert.equal(stage.gate, null);
  assert.equal(stage.agent, false);
  assert.equal(stage.workspace, "project");
  assert.equal(typeof stage.execute, "function");
  assert.equal(stage.proposal(), null);
  const missing = stage.preChecks(".", { domain: undefined, config: { project: { domains: ["applications"] } } });
  assert.ok(missing.some((r) => !r.ok && /ratify needs --domain/.test(r.messages.join(" "))));
});

test("stageFor throws unknown stage for a bogus name", () => {
  assert.throws(() => stageFor("bogus"), /unknown stage: bogus/);
});

test("skillText concatenates the preamble and the stage skill", () => {
  const text = skillText("probe");
  assert.match(text, /one stage of a longer pipeline/);
  assert.match(text, /app\/PROBE\.md/);
});

test("recommendationFrom extracts the first sentence, handling dots in filenames", () => {
  const result = recommendationFrom("Read intent/brief.md and wrote intent/x.md. Then more.");
  assert.equal(result, "Read intent/brief.md and wrote intent/x.md.");
});

test("recommendationFrom returns whole trimmed text when no terminator is present", () => {
  const result = recommendationFrom("This text has no sentence terminator");
  assert.equal(result, "This text has no sentence terminator");
});

test("recommendationFrom caps sentences longer than 200 characters with ellipsis", () => {
  const longText = "x".repeat(250) + ". More text.";
  const result = recommendationFrom(longText);
  assert.equal(result.length, 201);
  assert.ok(result.endsWith("…"));
});

test("recommendationFrom starts at a ## Journal heading when the text has one", () => {
  const text = [
    "Here is a long preamble about the files I opened along the way.",
    "",
    "## Journal",
    "",
    "The applications domain rejects any applicant under 19 and recalculates the fee on edit.",
    "Two sources disagreed about the fee basis.",
  ].join("\n");
  assert.equal(recommendationFrom(text),
    "The applications domain rejects any applicant under 19 and recalculates the fee on edit.");
});

test("recommendationFrom skips an opening sentence that only announces the work happened", () => {
  assert.equal(recommendationFrom("I've written the domain file. Applications are rejected under 19."),
    "Applications are rejected under 19.");
  assert.equal(recommendationFrom("Done. Applications are rejected under 19."),
    "Applications are rejected under 19.");
  assert.equal(recommendationFrom("I have finished. Applications are rejected under 19."),
    "Applications are rejected under 19.");
});

test("recommendationFrom skips an opening sentence too short to carry a claim", () => {
  assert.equal(recommendationFrom("All set. The billing domain prorates a mid-cycle change."),
    "The billing domain prorates a mid-cycle change.");
});

test("recommendationFrom keeps the only sentence there is, however unhelpful", () => {
  assert.equal(recommendationFrom("Done."), "Done.");
  assert.equal(recommendationFrom("   "), "no journal text was recorded");
});

test("recommendationFrom does not mistake a word starting with 'ive' for the bookkeeping opener", () => {
  assert.equal(recommendationFrom("Ivermectin dosing is recorded per patient. And more."),
    "Ivermectin dosing is recorded per patient.");
});

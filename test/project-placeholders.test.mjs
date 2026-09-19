import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { init } from "../src/commands/init.mjs";
import { propose } from "../src/commands/propose.mjs";
import { buildPersonaPrompt } from "../src/runner/persona.mjs";

const FROM = fileURLToPath(new URL("../fixture-project/fixture.config.yaml", import.meta.url));
const commit = (dir, msg) => { git(["add", "-A"], dir); git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", msg], dir); };

async function created(t) {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-placeholders-"));
  const prev = process.env.SDLC_EGRESS_NAMES;
  const names = join(tmp, "names.txt");
  writeFileSync(names, "");
  process.env.SDLC_EGRESS_NAMES = names;
  t.after(() => {
    if (prev === undefined) delete process.env.SDLC_EGRESS_NAMES; else process.env.SDLC_EGRESS_NAMES = prev;
    rmSync(tmp, { recursive: true, force: true });
  });
  const dir = join(tmp, "permit-intake");
  await newProject({ dir, from: FROM });
  return dir;
}

const design = (dir) => readFileSync(join(dir, "design", "DESIGN.md"), "utf8");

test("a new project's design document carries its name, and waits for the constitution for its purpose", async (t) => {
  const dir = await created(t);
  assert.match(design(dir), /^# Design — permit-intake$/m);
  assert.match(readFileSync(join(dir, "plan", "plan.md"), "utf8"), /^# Plan — permit-intake$/m);
  assert.match(design(dir), /\{\{SERVICE_PURPOSE\}\}/, "no purpose is guessed before the constitution states one");
});

test("init fills the purpose once the constitution states the service, then has nothing to do", async (t) => {
  const dir = await created(t);
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace("{{SERVICE_PURPOSE}}", 'Issues "permits" to residents.'));
  commit(dir, "constitution states the service");

  await init(dir);
  assert.match(design(dir), /^description: "Issues 'permits' to residents\."$/m);
  assert.equal(git(["status", "--porcelain"], dir), "", "the fill is committed with init's own commit");
  const head = git(["rev-parse", "HEAD"], dir);
  await init(dir);
  assert.equal(git(["rev-parse", "HEAD"], dir), head, "a second init changes nothing");
});

// `init` runs on dirty trees and commits what it changes by name, so filling a file that
// holds someone's uncommitted edits would commit those edits under the pipeline's name.
test("init leaves a design document with uncommitted edits alone", async (t) => {
  const dir = await created(t);
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace("{{SERVICE_PURPOSE}}", "Issues permits."));
  commit(dir, "constitution states the service");
  writeFileSync(join(dir, "design", "DESIGN.md"), `${design(dir)}\nA note being drafted.\n`);

  await init(dir);
  assert.match(design(dir), /\{\{SERVICE_PURPOSE\}\}/);
  assert.match(git(["status", "--porcelain"], dir), /design\/DESIGN\.md/);
});

test("the escalation's target is shown the escalating persona's own account", async (t) => {
  const dir = await created(t);
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  commit(dir, "fill constitution");
  propose(dir, "p1", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  const prompt = await buildPersonaPrompt(dir, "p1", "product-owner", {
    tier: "STANDARD", gate: "G0",
    escalation: { by: "agent:ux-reviewer", rationale: "a card the design system does not provide" },
  });
  assert.match(prompt, /## The escalation you are ruling/);
  assert.match(prompt, /agent:ux-reviewer holds this gate and escalated it to you/);
  assert.match(prompt, /a card the design system does not provide/);
  const plain = await buildPersonaPrompt(dir, "p1", "product-owner", { tier: "STANDARD", gate: "G0" });
  assert.doesNotMatch(plain, /The escalation you are ruling/);
});

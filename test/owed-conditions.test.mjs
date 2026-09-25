// A condition a ruling attached stays open on `main` until a later ruling closes it, and the
// ruler of every later proposal in the same line of work is shown it as owed. These are the
// tests that the stage revising that line of work is shown the same list, so it is asked for
// what its next ruler will expect of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { stringify as stringifyYaml } from "yaml";
import { stageFor } from "../src/stages/registry.mjs";

const TASKS = `# Tasks

### Slice 1 · Submit an application
- criteria: R-1.1

Build the submission form.

### Slice 2 · Review an application
- criteria: R-1.2

Build the review queue.
`;

const CONFIG = { project: { name: "p" }, targets: { new: { base_url: "http://localhost:3000" } } };

const EARLIER = "The account says the confirmation page was exercised; say plainly that no criterion is asserted by a hand-driven session, and keep the unit test that pins its wording.";
const RETURNING = "app/routes.js returns 500 where the criterion says the record is rejected with an error";
const OTHER_FAMILY = "The review queue sorts by the wrong date.";
const CLOSED = "The submission form drops the applicant's middle name.";

function repo(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-owed-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]);
  mkdirSync(join(d, "plan"), { recursive: true });
  writeFileSync(join(d, "plan", "tasks.md"), TASKS);
  commit(run, "start");
  return { d, run };
}

function commit(run, message) {
  run(["add", "-A"]);
  run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", message]);
}

function row(ref, text, { family, gate = "G3", stage = "build", by = "agent:reviewer", closed } = {}) {
  const from = ref.replace(/#\d+$/, "");
  return { ref, text, from, family, gate, stage, by, at: "2026-01-01T00:00:00.000Z", ...(closed ? { closed } : {}) };
}

// The ledger as a ruling leaves it: committed on `main`.
function ledgerOnMain(d, run, conditions) {
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "conditions.yaml"), stringifyYaml({ conditions }));
  commit(run, "record conditions");
}

// A returned proposal standing on its own branch, ruled with `conditions`.
function returned(d, run, { name, gate, conditions }) {
  run(["checkout", "-q", "-b", `proposal/${name}`]);
  mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "gates", `${name}.yaml`),
    `gate: ${gate}\nverdict: return\nby: agent:reviewer\nheld_by: agent\nrationale: not yet\n`
    + `conditions:\n${conditions.map((c) => `  - ${JSON.stringify(c)}`).join("\n")}\n`);
  commit(run, "returned");
  run(["checkout", "-q", "main"]);
}

function buildRevisePrompt(d) {
  const ctx = { slice: 1, revise: true, dryRun: true, config: CONFIG, projectDir: d };
  const check = stageFor("build").preChecks(d, ctx).find((c) => c.id === "build-revise-source");
  assert.equal(check.ok, true, check.messages.join("\n"));
  return stageFor("build").prompt(ctx);
}

test("a condition an earlier return in the same line of work left open reaches the revision, quoted by its reference", (t) => {
  const { d, run } = repo(t);
  ledgerOnMain(d, run, [
    row("build-slice-1#1", EARLIER, { family: "build-slice-1" }),
    row("build-slice-1-2#1", RETURNING, { family: "build-slice-1", by: "tech-lead" }),
  ]);
  returned(d, run, { name: "build-slice-1-2", gate: "G3", conditions: [RETURNING] });

  const prompt = buildRevisePrompt(d);
  assert.ok(prompt.includes("`build-slice-1#1`"), "named by the reference a ruler closes it with");
  assert.ok(prompt.includes(EARLIER), "and quoted in its ruler's own words");
  assert.match(prompt, /attached by agent:reviewer when it ruled build-slice-1 at G3/);
  assert.match(prompt, /will be shown it as owed, by its reference/);
  assert.match(prompt, /will expect it met or accounted for/);
});

test("the returning ruling's own conditions are listed once, where they already are", (t) => {
  const { d, run } = repo(t);
  ledgerOnMain(d, run, [
    row("build-slice-1#1", EARLIER, { family: "build-slice-1" }),
    row("build-slice-1-2#1", RETURNING, { family: "build-slice-1", by: "tech-lead" }),
  ]);
  returned(d, run, { name: "build-slice-1-2", gate: "G3", conditions: [RETURNING] });

  const prompt = buildRevisePrompt(d);
  assert.equal(prompt.split(RETURNING).length - 1, 1, "the returning ruling's condition appears exactly once");
  assert.ok(!prompt.includes("build-slice-1-2#1"), "and is not carried a second time as an earlier one");
});

test("a condition open on a different line of work is not carried", (t) => {
  const { d, run } = repo(t);
  ledgerOnMain(d, run, [
    row("build-slice-1#1", EARLIER, { family: "build-slice-1" }),
    row("build-slice-2#1", OTHER_FAMILY, { family: "build-slice-2" }),
    row("build-slice-12#1", OTHER_FAMILY, { family: "build-slice-12" }),
  ]);
  returned(d, run, { name: "build-slice-1-2", gate: "G3", conditions: [RETURNING] });

  const prompt = buildRevisePrompt(d);
  assert.ok(prompt.includes(EARLIER));
  assert.ok(!prompt.includes(OTHER_FAMILY), "another slice's condition is that slice's to meet");
  assert.ok(!prompt.includes("build-slice-2#1"));
  assert.ok(!prompt.includes("build-slice-12#1"));
});

test("a condition a later ruling closed is not carried", (t) => {
  const { d, run } = repo(t);
  ledgerOnMain(d, run, [
    row("build-slice-1#1", CLOSED, { family: "build-slice-1", closed: { outcome: "met", why: "the name is kept", by: "tech-lead", at: "2026-01-02T00:00:00.000Z" } }),
    row("build-slice-1#2", EARLIER, { family: "build-slice-1" }),
  ]);
  returned(d, run, { name: "build-slice-1-2", gate: "G3", conditions: [RETURNING] });

  const prompt = buildRevisePrompt(d);
  assert.ok(!prompt.includes(CLOSED));
  assert.ok(!prompt.includes("build-slice-1#1"));
  assert.ok(prompt.includes("`build-slice-1#2`"));
});

test("with nothing else open, the revise prompt carries only the returning ruling", (t) => {
  const { d, run } = repo(t);
  ledgerOnMain(d, run, [row("build-slice-1-2#1", RETURNING, { family: "build-slice-1" })]);
  returned(d, run, { name: "build-slice-1-2", gate: "G3", conditions: [RETURNING] });

  const prompt = buildRevisePrompt(d);
  assert.ok(prompt.includes(`- ${RETURNING}`));
  assert.doesNotMatch(prompt, /still open/);
  assert.doesNotMatch(prompt, /as owed, by its reference/);
});

test("with no ledger at all, the revise prompt carries only the returning ruling", (t) => {
  const { d, run } = repo(t);
  returned(d, run, { name: "build-slice-1-2", gate: "G3", conditions: [RETURNING] });
  assert.doesNotMatch(buildRevisePrompt(d), /as owed, by its reference/);
});

// Only `main`'s ledger counts: it is the one the next ruler is shown, so a copy anywhere
// else is not what the revision is answerable to.
test("the open set is read from main, not from the checkout", (t) => {
  const { d, run } = repo(t);
  ledgerOnMain(d, run, [row("build-slice-1#1", EARLIER, { family: "build-slice-1" })]);
  returned(d, run, { name: "build-slice-1-2", gate: "G3", conditions: [RETURNING] });
  writeFileSync(join(d, ".sdlc", "conditions.yaml"), stringifyYaml({ conditions: [row("build-slice-1#9", CLOSED, { family: "build-slice-1" })] }));

  const ctx = { slice: 1, revise: true, dryRun: true, config: CONFIG, projectDir: d };
  stageFor("build").preChecks(d, ctx);
  const prompt = stageFor("build").prompt(ctx);
  assert.ok(prompt.includes(EARLIER));
  assert.ok(!prompt.includes(CLOSED));
});

test("any stage that revises from a returned ruling carries the same list", (t) => {
  const { d, run } = repo(t);
  mkdirSync(join(d, "spec", "contract"), { recursive: true });
  mkdirSync(join(d, "design"), { recursive: true });
  writeFileSync(join(d, "spec", "criteria-index.json"), JSON.stringify({
    generated_from: "0".repeat(40),
    criteria: [{ id: "R-1.1", domain: "applications", version: 1, state: "accepted", statement: "a submitted application is acknowledged" }],
  }));
  writeFileSync(join(d, "design", "screens.yaml"), "screens: []\n");
  commit(run, "plannable");
  const planEarlier = "plan/tasks.md must say which slice stands the application up.";
  ledgerOnMain(d, run, [
    row("plan#1", planEarlier, { family: "plan", gate: "G2", stage: "plan", by: "agent:architect" }),
    row("plan-2#1", RETURNING, { family: "plan", gate: "G2", stage: "plan" }),
  ]);
  returned(d, run, { name: "plan-2", gate: "G2", conditions: [RETURNING] });

  const ctx = { revise: true, dryRun: true, projectDir: d };
  const check = stageFor("plan").preChecks(d, ctx).find((c) => c.id === "plan-revise-source");
  assert.equal(check.ok, true, check.messages.join("\n"));
  const prompt = stageFor("plan").prompt(ctx);
  assert.ok(prompt.includes("`plan#1`"));
  assert.ok(prompt.includes(planEarlier));
  assert.match(prompt, /attached by agent:architect when it ruled plan at G2/);
  assert.equal(prompt.split(RETURNING).length - 1, 1);
});

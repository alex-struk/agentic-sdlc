// A returned build whose ruling asked the builder for nothing, every condition having gone to
// another stage, is proposed again with the application it carried and no builder session
// (`docs/decisions/0106`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { build } from "../src/stages/build.mjs";

const FROM = fileURLToPath(new URL("../fixture-project/fixture.config.yaml", import.meta.url));

const TO_TESTS = "addressed-to derive-tests: R-1.1: the test opens a page the criterion never names";
const OVERREACH = "test-overreaches R-1.1: the test asserts the heading's wording, which the criterion leaves open";
const TO_BUILDER = "R-1.1: the form accepts an application with no applicant name";

// ---- which revisions ask the builder for nothing ----

const revision = (over) => ({ name: "build-slice-1-2", conditions: [], addressedElsewhere: [], ...over });

test("a return whose every condition went to another stage asks the builder for nothing", () => {
  const text = build.withoutTurn({ revise: true, revision: revision({
    addressedElsewhere: [{ stage: "derive-tests", text: "R-1.1: the test opens a page the criterion never names" }],
  }) });
  assert.match(text, /^The application build-slice-1-2 carried is proposed again unchanged/);
  assert.match(text, /to derive-tests: R-1\.1: the test opens a page the criterion never names/);
  assert.match(text, /no builder session ran/i);
});

test("a return that asks anything of the builder is the builder's to revise", () => {
  assert.equal(build.withoutTurn({ revise: true, revision: revision({
    conditions: ["R-1.1: the form accepts an application with no applicant name"],
    addressedElsewhere: [{ stage: "derive-tests", text: "R-1.2: the test reads the wrong field" }],
  }) }), null);
});

test("a return with no conditions at all is the builder's to read", () => {
  assert.equal(build.withoutTurn({ revise: true, revision: revision({}) }), null);
});

test("a condition an earlier ruling left open on the line of work is the builder's to meet", () => {
  assert.equal(build.withoutTurn({ revise: true, revision: revision({
    addressedElsewhere: [{ stage: "derive-tests", text: "R-1.1: the test opens a page the criterion never names" }],
    owedConditions: [{ ref: "build-slice-1#1", text: "keep the unit test that pins the wording" }],
  }) }), null);
});

test("a first build always runs its session", () => {
  assert.equal(build.withoutTurn({ revise: false }), null);
  assert.equal(build.withoutTurn({}), null);
});

// ---- the run itself ----

const commit = (dir, message) => {
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", message], dir);
};

function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

// A project with slice 1 planned and built once: the build changed the application and was
// returned at G3 with `conditions`. The agent is the mock with no canned reply, so a session
// asked for anywhere in the run fails it.
async function withReturnedBuild(t, conditions) {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-without-turn-"));
  const prev = { egress: process.env.SDLC_EGRESS_NAMES, executor: process.env.SDLC_EXECUTOR, mock: process.env.SDLC_MOCK_DIR };
  t.after(() => {
    for (const [key, value] of [["SDLC_EGRESS_NAMES", prev.egress], ["SDLC_EXECUTOR", prev.executor], ["SDLC_MOCK_DIR", prev.mock]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(join(tmp, "empty-egress-names.txt"), "");
  process.env.SDLC_EGRESS_NAMES = join(tmp, "empty-egress-names.txt");
  const dir = join(tmp, "permit-intake");
  await newProject({ dir, from: FROM });
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  write(dir, "plan/tasks.md", "# Tasks\n\n### Slice 1 · Submit an application\n- criteria: R-1.1\n\nBuild the submission form.\n");
  write(dir, "app/package.json", `${JSON.stringify({ name: "app", version: "1.0.0", private: true, scripts: { check: "node -e \"\"" } }, null, 2)}\n`);
  write(dir, "app/package-lock.json", `${JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "app", version: "1.0.0" } } }, null, 2)}\n`);
  commit(dir, "slice 1 planned");
  git(["checkout", "-q", "-b", "proposal/build-slice-1"], dir);
  write(dir, "app/index.js", "export const form = \"submission\";\n");
  write(dir, ".sdlc/proposals/build-slice-1.md", "---\ngate: G3\nquestion: \"Does slice 1 do what its criteria say?\"\nrecommendation: \"Yes.\"\n---\n");
  commit(dir, "propose(G3): build-slice-1");
  write(dir, ".sdlc/gates/build-slice-1.yaml", "gate: G3\nverdict: return\nby: agent:reviewer\nheld_by: agent\nrationale: the slice is sound; one test is not\n"
    + `conditions:\n${conditions.map((x) => `  - ${JSON.stringify(x)}`).join("\n")}\n`);
  commit(dir, "rule(G3): build-slice-1 return");
  git(["checkout", "-q", "main"], dir);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mkdtempSync(join(tmp, "mock-none-"));
  return dir;
}

test("build --revise with nothing asked of the builder proposes the same application without a session", async (t) => {
  const dir = await withReturnedBuild(t, [TO_TESTS, OVERREACH]);
  const returnedApp = git(["rev-parse", "proposal/build-slice-1:app"], dir);
  const r = await runStage(dir, "build", { slice: 1, revise: true });
  assert.equal(r.ok, true, JSON.stringify(r.messages ?? r));
  assert.equal(git(["rev-parse", "proposal/build-slice-1-2:app"], dir), returnedApp, "the application it carried, unchanged");
  const journal = git(["ls-tree", "--name-only", "proposal/build-slice-1-2", ".sdlc/journal/"], dir).split("\n").filter((f) => f.endsWith("-build.md")).at(-1);
  assert.match(git(["show", `proposal/build-slice-1-2:${journal}`], dir), /no builder session ran/i);
  assert.match(git(["show", "proposal/build-slice-1-2:.sdlc/proposals/build-slice-1-2.md"], dir), /proposed again unchanged/);
  assert.equal(git(["status", "--porcelain"], dir), "");
});

test("build --revise with something asked of the builder runs the builder's session", async (t) => {
  const dir = await withReturnedBuild(t, [TO_BUILDER, TO_TESTS]);
  await assert.rejects(() => runStage(dir, "build", { slice: 1, revise: true }), /mock executor: no canned response/);
});

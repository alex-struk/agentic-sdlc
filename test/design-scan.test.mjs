import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDesignAccessibility, checkDesignCompiles, checkDesignHarnessUntouched, checkDesignNoLiteralColours } from "../src/checks/design.mjs";

const STORY = 'export const Default = { render: () => null };\n';

function digestOf(files) {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) hash.update(name).update("\0").update(Buffer.from(files[name])).update("\0");
  return hash.digest("hex");
}

// A project with a catalogue of two stories and whatever report the test hands it.
function project(t, { report, stories = { "a.default.stories.tsx": STORY, "b.default.stories.tsx": STORY } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-scan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "design", "catalogue"), { recursive: true });
  for (const [name, text] of Object.entries(stories)) writeFileSync(join(dir, "design", "catalogue", name), text);
  if (report) {
    const body = { catalogue: digestOf(stories), compile: [{ step: "typecheck", ok: true }, { step: "build", ok: true }], stories: [], ...report };
    writeFileSync(join(dir, "design", "report.json"), JSON.stringify(body));
  }
  return dir;
}

const scanned = (file) => ({ id: file.replace(/\..*/, ""), file: `./catalogue/${file}`, violations: [] });

test("a catalogue nobody compiled fails the gate, and is told how to compile it", (t) => {
  const r = checkDesignCompiles(project(t));
  assert.equal(r.ok, false);
  assert.match(r.messages[0], /has not been compiled/);
  assert.match(r.messages[0], /npm --prefix design run scan/);
});

test("a compile step that failed fails the gate, carrying the compiler's own words", (t) => {
  const dir = project(t, { report: { compile: [{ step: "typecheck", ok: false, output: "catalogue/a.default.stories.tsx(3,9): error TS2322: Type 'string' is not assignable to type 'number'." }] } });
  const r = checkDesignCompiles(dir);
  assert.equal(r.ok, false);
  assert.match(r.messages[0], /does not typecheck/);
  assert.match(r.messages[0], /error TS2322/);
});

// The ordinary case after a revision: a story is fixed and the report still says zero,
// because it is a report about the stories as they were when it ran.
test("a report written for a different catalogue is not evidence about this one", (t) => {
  const dir = project(t, { report: { catalogue: "0".repeat(64) } });
  const r = checkDesignCompiles(dir);
  assert.equal(r.ok, false);
  assert.match(r.messages[0], /written for a different catalogue/);
});

test("a report that does not say which catalogue it read cannot be held against one", (t) => {
  const dir = project(t, { report: { catalogue: undefined } });
  assert.equal(checkDesignCompiles(dir).ok, false);
});

test("a catalogue that compiles, from the report of the catalogue that is there, passes", (t) => {
  assert.deepEqual(checkDesignCompiles(project(t, { report: {} })), { id: "design-compiles", ok: true, messages: [] });
});

// ---- the scan ----

test("every violation is reported with the rule, its impact and where it was", (t) => {
  const dir = project(t, { report: { stories: [
    { ...scanned("a.default.stories.tsx"), violations: [{ id: "color-contrast", impact: "serious", help: "Elements must meet minimum contrast", nodes: ["#total"] }] },
    scanned("b.default.stories.tsx"),
  ] } });
  const r = checkDesignAccessibility(dir);
  assert.equal(r.ok, false);
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0], /color-contrast \(serious\)/);
  assert.match(r.messages[0], /#total/);
});

// An unrendered story is an unscanned one, and a zero bought by a story that threw is
// worth less than a violation, because nothing about it is visible.
test("a story that would not render counts against the scan rather than for it", (t) => {
  const dir = project(t, { report: { stories: [
    { ...scanned("a.default.stories.tsx"), error: "Heading is not exported" },
    scanned("b.default.stories.tsx"),
  ] } });
  const r = checkDesignAccessibility(dir);
  assert.equal(r.ok, false);
  assert.match(r.messages[0], /did not render — Heading is not exported/);
});

test("a story file the scan never reached is named, so a partial run cannot pass as a clean one", (t) => {
  const dir = project(t, { report: { stories: [scanned("a.default.stories.tsx")] } });
  const r = checkDesignAccessibility(dir);
  assert.equal(r.ok, false);
  assert.match(r.messages[0], /b\.default\.stories\.tsx: no story from this file was scanned/);
});

test("a scan with no story in it at all is not a clean scan", (t) => {
  const r = checkDesignAccessibility(project(t, { report: { stories: [] } }));
  assert.equal(r.ok, false);
  assert.match(r.messages[0], /nothing was scanned/);
});

test("every story rendered and none in violation passes", (t) => {
  const dir = project(t, { report: { stories: [scanned("a.default.stories.tsx"), scanned("b.default.stories.tsx")] } });
  assert.deepEqual(checkDesignAccessibility(dir), { id: "design-accessibility", ok: true, messages: [] });
});

// ---- the harness itself ----

function harnessProject(t) {
  const dir = project(t, { report: {} });
  mkdirSync(join(dir, "design", ".storybook"), { recursive: true });
  writeFileSync(join(dir, "design", "scan.mjs"), "// the scanner\n");
  writeFileSync(join(dir, "design", ".storybook", "main.ts"), "export default {};\n");
  const run = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.test"]);
  run(["config", "user.name", "t"]);
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "start"]);
  return dir;
}

// The one repair that would make the gate's evidence worthless: answering a failing scan
// by editing the scanner.
test("a design run that edited the scanner is failed by name", (t) => {
  const dir = harnessProject(t);
  writeFileSync(join(dir, "design", "scan.mjs"), "process.exit(0);\n");
  const r = checkDesignHarnessUntouched(dir);
  assert.equal(r.ok, false);
  assert.match(r.messages[0], /design\/scan\.mjs was changed/);
});

test("deleting a harness file is the same finding as changing one", (t) => {
  const dir = harnessProject(t);
  rmSync(join(dir, "design", ".storybook", "main.ts"));
  const r = checkDesignHarnessUntouched(dir);
  assert.equal(r.ok, false);
  assert.match(r.messages[0], /main\.ts was deleted/);
});

test("a harness nobody touched passes, and a project with no harness in its history is not held to one", (t) => {
  assert.equal(checkDesignHarnessUntouched(harnessProject(t)).ok, true);
  assert.equal(checkDesignHarnessUntouched(project(t)).ok, true);
});

// The harness's installed dependencies and its build output are generated, not authored:
// both are full of written-out colours and walking them would read tens of thousands of
// files to report somebody else's.
test("the colour check reads the catalogue and not the machinery around it", (t) => {
  const dir = project(t);
  mkdirSync(join(dir, "design", "node_modules", "@vendor", "kit"), { recursive: true });
  writeFileSync(join(dir, "design", "node_modules", "@vendor", "kit", "theme.css"), ".x { color: #036; }\n");
  mkdirSync(join(dir, "design", "storybook-static", "assets"), { recursive: true });
  writeFileSync(join(dir, "design", "storybook-static", "assets", "index.css"), ".y { color: rgb(1,2,3); }\n");
  assert.equal(checkDesignNoLiteralColours(dir).ok, true);

  writeFileSync(join(dir, "design", "catalogue", "a.default.stories.tsx"), 'export const s = { color: "#036" };\n');
  const r = checkDesignNoLiteralColours(dir);
  assert.equal(r.ok, false);
  assert.match(r.messages[0], /catalogue\/a\.default\.stories\.tsx:1: colour written out as #036/);
});

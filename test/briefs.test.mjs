// test/briefs.test.mjs — a persona brief installed in a project against the template it
// came from.
//
// A capability added to a brief in the pipeline is only a capability the pipeline has if
// the projects already scaffolded receive it. A brief that is behind its template still
// reads as a complete brief, so nothing about the gap is visible from the project: it has
// to be detected against the template and said out loud.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { init } from "../src/commands/init.mjs";
import { briefStates, briefDigest, templateBriefs, TEMPLATE_BRIEF_DIR } from "../src/lib/briefs.mjs";
import { checkBriefs } from "../src/checks/briefs.mjs";

function makePack() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-pack-"));
  git(["init", "-q", "-b", "main"], d); git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, "skills/tdd"), { recursive: true }); writeFileSync(join(d, "skills/tdd/SKILL.md"), "---\nname: tdd\n---\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

function projectConfig(pack) {
  return `
pipeline: { repo: agentic-sdlc, ref: main }
profile: rebuild
stack: openshift-ts
project: { name: example-service, domains: [accounts, orders] }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [ { repo: ${pack}, ref: main, skills: [tdd] } ] }
egress: { rules: [E-1, E-2, E-3, E-4] }
`;
}

// Every test here makes a project, and every project's init reads the egress name list.
// Pointing SDLC_EGRESS_NAMES at an existing-but-empty file keeps the real machine's list
// out of it (test/new-init.test.mjs says the same thing at more length).
async function scaffold(prefix) {
  const egressDir = mkdtempSync(join(tmpdir(), "sdlc-egress-"));
  const emptyList = join(egressDir, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  const cfgPath = join(mkdtempSync(join(tmpdir(), "sdlc-cfg-")), "example.yaml");
  writeFileSync(cfgPath, projectConfig(makePack()));
  const dir = join(mkdtempSync(join(tmpdir(), prefix)), "example-service");
  await newProject({ dir, from: cfgPath });
  return dir;
}

const briefPath = (dir, file) => join(dir, ".sdlc", "personas", file);
const readBrief = (dir, file) => readFileSync(briefPath(dir, file), "utf8");
const templateOf = (file) => readFileSync(join(TEMPLATE_BRIEF_DIR, file), "utf8");
const lockBriefs = (dir) => JSON.parse(readFileSync(join(dir, ".sdlc", "lock.json"), "utf8")).briefs ?? {};

test("a freshly scaffolded project records the brief it was given, and reports every brief current", async () => {
  const dir = await scaffold("sdlc-briefs-fresh-");
  const recorded = lockBriefs(dir);
  for (const file of templateBriefs()) {
    assert.equal(recorded[file], briefDigest(templateOf(file)), `${file} is recorded in the lockfile`);
  }
  assert.deepEqual(briefStates(dir, recorded).filter((b) => b.state !== "current"), []);
  const check = checkBriefs(dir);
  assert.equal(check.ok, true);
  assert.deepEqual(check.warnings ?? [], []);
});

test("a brief that is behind its template is reported, and the next init brings it current", async () => {
  const dir = await scaffold("sdlc-briefs-behind-");
  const file = "reviewer.md";
  const template = templateOf(file);

  // The project as it stands after a template gained a paragraph the project was
  // scaffolded before: identical to what init last wrote, and no longer identical to the
  // template.
  const older = template.replace(/\n## Ruling format\n[\s\S]*$/, "\n");
  assert.notEqual(older, template);
  writeFileSync(briefPath(dir, file), older);
  const recorded = { ...lockBriefs(dir), [file]: briefDigest(older) };
  writeFileSync(join(dir, ".sdlc", "lock.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, ".sdlc", "lock.json"), "utf8")), briefs: recorded }, null, 2) + "\n");
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "a brief from an older template"], dir);

  assert.equal(briefStates(dir, recorded).find((b) => b.file === file).state, "behind");
  const check = checkBriefs(dir);
  assert.ok((check.warnings ?? []).some((w) => w.includes(file) && w.includes("behind")), check.warnings);

  const r = await init(dir);
  assert.deepEqual(r.briefs.updated, [file]);
  assert.equal(readBrief(dir, file), template, "the template's text is now the project's");
  assert.equal(lockBriefs(dir)[file], briefDigest(template));
  assert.deepEqual(checkBriefs(dir).warnings ?? [], []);
});

test("a brief with local edits is left alone, named, and replaced only when the operator asks", async () => {
  const dir = await scaffold("sdlc-briefs-local-");
  const file = "reviewer.md";
  const template = templateOf(file);
  const edited = `${template}\n## A rule this team added\n\nSomething this project's reviewer is asked for and no other project is.\n`;
  writeFileSync(briefPath(dir, file), edited);
  git(["add", "-A"], dir); git(["commit", "-q", "-m", "a local addition to the brief"], dir);

  assert.equal(briefStates(dir, lockBriefs(dir)).find((b) => b.file === file).state, "local");
  const check = checkBriefs(dir);
  assert.ok((check.warnings ?? []).some((w) => w.includes(file) && w.includes("local")), check.warnings);
  assert.equal(check.ok, true, "a brief a project chose to change is not a failing check");

  const kept = await init(dir);
  assert.equal(readBrief(dir, file), edited, "init never overwrites an edit the project made");
  assert.deepEqual(kept.briefs.local, [file]);
  assert.deepEqual(kept.briefs.updated, []);

  const adopted = await init(dir, { adoptBriefs: true });
  assert.deepEqual(adopted.briefs.adopted, [file]);
  assert.equal(readBrief(dir, file), template, "the operator asked for the template and got it");
  assert.equal(lockBriefs(dir)[file], briefDigest(template));
});

test("a missing brief is still restored, and a second init changes nothing", async () => {
  const dir = await scaffold("sdlc-briefs-missing-");
  const file = "tech-lead.md";
  rmSync(briefPath(dir, file), { force: true });
  const restored = await init(dir);
  assert.equal(readBrief(dir, file), templateOf(file));
  assert.deepEqual(restored.briefs.written, [file]);

  const again = await init(dir);
  assert.deepEqual(again.briefs.updated, []);
  assert.deepEqual(again.briefs.local, []);
  assert.equal(git(["status", "--porcelain"], dir), "", "a second init leaves the tree clean");
});

// The build-verified guard binds the verdict rather than the call, so a build ruling is
// asked for on an unbound or failed result as readily as on a passing one. A brief that
// tells its persona the tests have already passed describes a premise that is not there,
// on exactly the rulings where the persona most needs to know what it is looking at.
test("the reviewer's brief does not promise a passing suite, and says what each verdict means for the ruling", () => {
  const brief = readFileSync(join(TEMPLATE_BRIEF_DIR, "reviewer.md"), "utf8");
  const section = brief.slice(brief.indexOf("## Ruling a build proposal"));
  assert.ok(!/have already passed/.test(section), "no claim that the suite already passed");
  assert.ok(!/would not have asked you otherwise/.test(section), "no claim about what the runner would not ask");
  for (const verdict of ["`pass`", "`fail`", "`unbound`"]) {
    assert.ok(section.includes(verdict), `the brief says what ${verdict} means`);
  }
  assert.match(section, /return or an escalation/, "and that both are open whatever the result says");
});

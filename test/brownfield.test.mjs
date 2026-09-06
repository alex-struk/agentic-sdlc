import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { init } from "../src/commands/init.mjs";
import { propose } from "../src/commands/propose.mjs";
import { ruleByAgent } from "../src/commands/rule.mjs";
import { runStage } from "../src/commands/run.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;
const PERSONAS = ["product-owner", "architect", "reviewer", "ux-reviewer", "tech-lead"];

function commit(dir, message) {
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", message], dir);
}

// A project as an earlier version of the pipeline left it: `site/` ignored and
// untracked, no `.sdlc/run-state.json` ignore line but the file itself committed, and
// two persona briefs missing. Everything else — the project's own ignore lines
// included — is exactly what `newProject` produced, so the assertions below are about
// what `init` reconciles rather than about what it overwrites.
async function brownfieldProject(tmp) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  const dir = join(tmp, "permit-intake");
  await newProject({ dir, from: FROM });
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  commit(dir, "fill constitution");

  git(["rm", "-r", "-q", "--", "site"], dir);
  writeFileSync(join(dir, ".gitignore"),
    "node_modules/\n.sdlc/packs/\n.sdlc/*.local.yaml\n.sdlc/*.local.txt\nsite/\ndist/\n");
  writeFileSync(join(dir, ".sdlc", "run-state.json"), JSON.stringify({ stage: "probe", phase: "agent" }) + "\n");
  for (const p of ["tech-lead", "ux-reviewer"]) rmSync(join(dir, ".sdlc", "personas", `${p}.md`), { force: true });
  commit(dir, "state of the project before this branch");
  return { dir, prevEgress };
}

function restoreEgress(prev) {
  if (prev === undefined) delete process.env.SDLC_EGRESS_NAMES;
  else process.env.SDLC_EGRESS_NAMES = prev;
}

test("init on a project from an earlier pipeline version reconciles the ignore file, untracks run-state and tracks the site", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-brownfield-"));
  const { dir, prevEgress } = await brownfieldProject(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-brownfield-mock-"));
  writeFileSync(join(mockDir, "probe.json"), JSON.stringify({
    text: "wrote the probe file",
    files: { "app/PROBE.md": "2026-09-06 the runner works\n" },
  }));
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify({
    text: 'Looks right.\n\n```json\n{"verdict":"approve","rationale":"the probe file is there and the checks are green","conditions":[]}\n```',
  }));
  try {
    assert.notEqual(git(["ls-files", "--", ".sdlc/run-state.json"], dir), "", "the fixture starts with run-state tracked");

    await init(dir);

    const ignore = readFileSync(join(dir, ".gitignore"), "utf8").split("\n");
    assert.ok(!ignore.includes("site/"), "the site/ line is removed");
    assert.ok(ignore.includes(".sdlc/run-state.json"), "the run-state line is added");
    assert.ok(ignore.includes("dist/"), "a line the project added itself is left alone");
    assert.ok(ignore.includes("node_modules/"), "a line that was already right is left alone");
    assert.equal(git(["ls-files", "--", ".sdlc/run-state.json"], dir), "", "run-state is no longer tracked");
    assert.ok(existsSync(join(dir, ".sdlc", "run-state.json")), "the file itself is left on disk");
    for (const p of PERSONAS) assert.ok(existsSync(join(dir, ".sdlc", "personas", `${p}.md`)), `${p}.md`);
    assert.notEqual(git(["ls-files", "--", "site"], dir), "", "the site is tracked");
    assert.equal(git(["status", "--porcelain"], dir), "", "init leaves the tree clean");

    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = mockDir;
    const probe = await runStage(dir, "probe");
    assert.equal(probe.ok, true);
    assert.notEqual(git(["ls-files", "--", "site/journal.md"], dir), "", "the run committed the site");
    assert.equal(git(["status", "--porcelain"], dir), "");

    propose(dir, "brownfield-ruling", { gate: "G0", question: "Does the runner work here?", recommendation: "Yes" });
    const ruling = await ruleByAgent(dir, "brownfield-ruling", { persona: "product-owner" });
    assert.equal(ruling.verdict, "approve");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    restoreEgress(prevEgress);
  }
});

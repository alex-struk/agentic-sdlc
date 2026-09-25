// test/scrub.test.mjs — `sdlc scrub`: rewrite a tracked file the egress check flags for a
// local home path, redacted, and commit the result as the pipeline. Recovery for files
// written before a writer applied `redactLocalPaths` at the point it wrote them
// (`docs/decisions/0020`, `docs/decisions/0059`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { git, SDLC_AUTHOR_NAME } from "../src/lib/git.mjs";
import { scrub } from "../src/commands/scrub.mjs";

const CONFIG = `
pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: p, domains: [a] }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;

const ELSEWHERE = `/${"home"}/someone`;

function project() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-scrub-"));
  git(["init", "-q", "-b", "main"], d); git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, ".sdlc"), { recursive: true }); writeFileSync(join(d, ".sdlc/config.yaml"), CONFIG);
  writeFileSync(join(d, ".gitignore"), ".sdlc/*.local.txt\n");
  writeFileSync(join(d, "README.md"), "x"); git(["add", "-A"], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

function committed(d, rel, text) {
  const abs = join(d, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", `add ${rel}`], d);
}

test("scrub redacts a tracked file's local home path and commits it as the pipeline", () => {
  const d = project();
  committed(d, "tests/results/old/2026-09-25.json", `{"error": "Command failed: node \\"${ELSEWHERE}/agentic-sdlc/bin/sdlc.mjs\\" oracle reseed"}\n`);
  const r = scrub(d);
  assert.deepEqual(r.changed, ["tests/results/old/2026-09-25.json"]);
  const text = readFileSync(join(d, "tests/results/old/2026-09-25.json"), "utf8");
  assert.ok(!text.includes(ELSEWHERE), text);
  assert.match(text, /~\/agentic-sdlc\/bin\/sdlc\.mjs/);
  assert.equal(git(["status", "--porcelain"], d), "");
  assert.equal(git(["log", "-1", "--pretty=%an"], d), SDLC_AUTHOR_NAME);
  assert.match(git(["log", "-1", "--pretty=%s"], d), /^scrub:/);
});

test("scrub touches every file the check flags, and only those", () => {
  const d = project();
  committed(d, "tests/results/old/2026-09-25.json", `{"error": "at ${ELSEWHERE}/agentic-sdlc/bin/sdlc.mjs"}\n`);
  committed(d, "tests/results/old/latest.json", `{"error": "at ${ELSEWHERE}/agentic-sdlc/bin/sdlc.mjs"}\n`);
  committed(d, "README.md", "nothing to see here\n");
  const r = scrub(d);
  assert.deepEqual(r.changed.sort(), ["tests/results/old/2026-09-25.json", "tests/results/old/latest.json"]);
  assert.equal(readFileSync(join(d, "README.md"), "utf8"), "nothing to see here\n");
});

test("scrub is a no-op, and commits nothing, when no tracked file carries a local path", () => {
  const d = project();
  committed(d, "tests/results/old/latest.json", `{"error": "expect(received).toBe(expected)"}\n`);
  const before = git(["rev-parse", "HEAD"], d);
  const r = scrub(d);
  assert.deepEqual(r.changed, []);
  assert.equal(git(["rev-parse", "HEAD"], d), before, "no empty commit");
});

test("scrub refuses a dirty tree and refuses off main", () => {
  const d = project();
  committed(d, "tests/results/old/latest.json", `{"error": "at ${ELSEWHERE}/agentic-sdlc/bin/sdlc.mjs"}\n`);
  writeFileSync(join(d, "README.md"), "dirty");
  assert.throws(() => scrub(d), /uncommitted changes/);
  git(["checkout", "-q", "--", "README.md"], d);
  git(["checkout", "-q", "-b", "not-main"], d);
  assert.throws(() => scrub(d), /must start on main/);
});

test("sdlc scrub is wired to the command line", () => {
  const d = project();
  committed(d, "tests/results/old/latest.json", `{"error": "at ${ELSEWHERE}/agentic-sdlc/bin/sdlc.mjs"}\n`);
  const bin = new URL("../bin/sdlc.mjs", import.meta.url).pathname;
  const done = spawnSync(process.execPath, [bin, "scrub"], { cwd: d, encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /tests\/results\/old\/latest\.json/);
  assert.ok(!readFileSync(join(d, "tests/results/old/latest.json"), "utf8").includes(ELSEWHERE));
});

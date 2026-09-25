import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkHandEdits, HAND_EDITS_SINCE } from "../src/checks/hand-edits.mjs";
import { parseConfig } from "../src/config/load.mjs";

const PIPELINE = ["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost"];
const PERSON = ["-c", "user.name=t", "-c", "user.email=t@example.org"];

function repo(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-hand-edits-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: d });
  return d;
}

function commit(d, who, files, message, env = {}) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: d });
  execFileSync("git", [...who, "commit", "-q", "-m", message], { cwd: d, env: { ...process.env, ...env } });
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
}

const policy = (handEdits) => ({ policy: { checks: { hand_edits: handEdits } } });

test("a record file changed only by pipeline commits is not flagged", (t) => {
  const d = repo(t);
  commit(d, PIPELINE, { ".sdlc/gates/intent-x.yaml": "verdict: approve\n", ".sdlc/conditions.yaml": "conditions: []\n" }, "rule(G0): intent-x");
  const r = checkHandEdits(d, {});
  assert.equal(r.id, "hand-edits");
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings ?? [], []);
  assert.deepEqual(r.messages, []);
});

test("a record file changed in a commit by anyone else warns by default, naming the commit and the files", (t) => {
  const d = repo(t);
  commit(d, PIPELINE, { ".sdlc/conditions.yaml": "conditions: []\n" }, "rule(G1): a");
  const sha = commit(d, PERSON, {
    ".sdlc/conditions.yaml": "conditions: [{ ref: a#1 }]\n",
    ".sdlc/gates/a.yaml": "verdict: approve\n",
    ".sdlc/lock.json": "{}\n",
    "tests/adapters/rebind.yaml": "rebind: []\n",
    "app/index.ts": "export {};\n",
  }, "tidy the ledger");
  const r = checkHandEdits(d, {});
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  const [w] = r.warnings;
  assert.match(w, new RegExp(`^${sha} "tidy the ledger" changes `));
  for (const p of [".sdlc/conditions.yaml", ".sdlc/gates/a.yaml", ".sdlc/lock.json", "tests/adapters/rebind.yaml"]) assert.ok(w.includes(p), `${p} named`);
  assert.ok(!w.includes("app/index.ts"), "a file outside the record is not named");
  assert.ok(!w.includes("t@example.org"), "the author is not named");
});

test("policy.checks.hand_edits: fail makes the same finding a failure", (t) => {
  const d = repo(t);
  commit(d, PERSON, { "spec/recovery.yaml": "recovery: []\n" }, "edit by hand");
  const r = checkHandEdits(d, { config: policy("fail") });
  assert.equal(r.ok, false);
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0], /spec\/recovery\.yaml outside a pipeline commit/);
});

test("commits from before the check existed are not read", (t) => {
  const d = repo(t);
  const before = new Date(Date.parse(HAND_EDITS_SINCE) - 86400000).toISOString();
  commit(d, PERSON, { "tests/acceptance/redo.yaml": "redo: []\n" }, "older history", { GIT_COMMITTER_DATE: before, GIT_AUTHOR_DATE: before });
  assert.equal(checkHandEdits(d, { config: policy("fail") }).ok, true);
});

test("a repository with no commits has nothing to flag", (t) => {
  const d = repo(t);
  assert.equal(checkHandEdits(d, {}).ok, true);
});

test("policy.checks.hand_edits accepts warn and fail and nothing else", () => {
  const base = [
    "pipeline: { repo: a, ref: main }", "profile: greenfield", "stack: openshift-ts", "project: { name: p, domains: [a] }",
    "policy:", "  gates:",
    ...["G0", "G1", "G-DESIGN", "G2", "G3", "G-POL"].map((g) => `    ${g}: { holder: lead }`),
    "  default_tier: STANDARD",
  ];
  const tail = ["skills: { packs: [] }", "egress: { rules: [E-2] }", ""];
  const cfg = (value) => [...base, `  checks: { hand_edits: ${value} }`, ...tail].join("\n");
  assert.deepEqual(parseConfig(cfg("warn")).errors, []);
  assert.deepEqual(parseConfig(cfg("fail")).errors, []);
  assert.notDeepEqual(parseConfig(cfg("ignore")).errors, []);
});

test("sdlc checks runs the hand-edit check on a project", async (t) => {
  const { runChecks } = await import("../src/checks/index.mjs");
  const d = repo(t);
  commit(d, PERSON, { ".sdlc/gates/a.yaml": "verdict: approve\n" }, "a ruling typed in by hand");
  const found = (await runChecks(d)).find((r) => r.id === "hand-edits");
  assert.ok(found, "the check ran");
  assert.equal(found.warnings.length, 1);
});

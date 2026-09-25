// A redo entry for a criterion another has since superseded, or made obsolete, asks
// `derive-tests` to write a test that criterion will never be derived for again
// (`acceptedCriteria` excludes it), so nothing would ever close the entry. An approval
// withdraws it the same way it withdraws a missing test for one, and `rule --settle` applies
// the same to an approval already on main (`docs/decisions/0048`, `0052`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { settleRuling } from "../src/commands/rule.mjs";
import { read } from "../src/spec/owed.mjs";

const git = (d, args) => execFileSync("git", args, { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const AS_PIPELINE = ["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost"];

function write(d, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), text);
  }
}

function commit(d, files, message = "record") {
  write(d, files);
  git(d, ["add", "-A"]);
  git(d, [...AS_PIPELINE, "commit", "-q", "--allow-empty", "-m", message]);
}

function config() {
  const seat = { holder: "tech-lead", escalate_to: "lead" };
  const gates = { G0: seat, G1: seat, "G-DESIGN": seat, G2: seat, G3: seat, "G-POL": { holder: "agent:lead", escalate_to: "lead" } };
  return [
    "pipeline: { repo: a, ref: main }", "profile: rebuild", "stack: openshift-ts",
    "project: { name: p, domains: [content, notifications] }",
    "policy:", "  gates:",
    ...Object.entries(gates).map(([g, v]) => `    ${g}: ${JSON.stringify(v)}`),
    "  default_tier: STANDARD",
    "skills: { packs: [] }", "egress: { rules: [E-2] }", "",
  ].join("\n");
}

const gateText = (gate, verdict, extra = {}) => stringifyYaml({ gate, verdict, by: "tech-lead", held_by: "person", at: "2026-01-01T00:00:00.000Z", ...extra });

function project(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-redo-retired-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(d, ["init", "-q", "-b", "main"]);
  commit(d, {
    ".sdlc/config.yaml": config(),
    "spec/criteria-index.json": JSON.stringify({ generated_from: "abc", criteria: [
      { id: "R-6.26", domain: "notifications", version: 2, state: "accepted", confidence: "confirmed", supersededBy: "R-6.28" },
      { id: "R-6.28", domain: "notifications", version: 1, state: "accepted", confidence: "confirmed" },
    ] }),
    "tests/acceptance/redo.yaml": stringifyYaml({ redo: [{ id: "R-6.26", version: 2, why: "the notification copy changed" }] }),
  }, "start");
  return d;
}

const redoOnMain = (d) => JSON.parse(JSON.stringify(read(d, "redo")));

// The shape an approved `derive-tests --stale` run leaves once it is merged: a proposal
// branch with its own gate file, ruled approve, merged into main. It closes nothing on
// `tests/acceptance/redo.yaml` — R-6.26 is superseded, so `derive-tests` never took it up —
// which is exactly the loop `sdlc next` would otherwise offer forever.
function approvedStaleRun(d, name) {
  git(d, ["checkout", "-q", "-b", `proposal/${name}`]);
  commit(d, { [`.sdlc/proposals/${name}.md`]: `---\ngate: G3\nquestion: "q"\nrecommendation: "r"\n---\n` }, `propose(G3): ${name}`);
  commit(d, { [`.sdlc/gates/${name}.yaml`]: gateText("G3", "approve") }, `rule(G3): ${name} approve by tech-lead`);
  git(d, ["checkout", "-q", "main"]);
  git(d, [...AS_PIPELINE, "merge", "-q", "--no-ff", "-m", `merge: ${name} approved at G3 by tech-lead`, `proposal/${name}`]);
}

test("rule --settle withdraws a redo entry whose criterion was superseded before the run that would have answered it", (t) => {
  const d = project(t);
  assert.equal(redoOnMain(d).find((e) => e.id === "R-6.26")?.closed, null);

  approvedStaleRun(d, "derive-tests-notifications-stale-5");
  const r = settleRuling(d, "derive-tests-notifications-stale-5");
  assert.equal(r.verdict, "approve");
  assert.deepEqual(r.redo, [], "the criterion was never derived again — nothing closes it as met");
  assert.deepEqual(r.redoWithdrawn, ["R-6.26"]);

  const entry = redoOnMain(d).find((e) => e.id === "R-6.26");
  assert.equal(entry.closed.outcome, "withdrawn");
  assert.match(entry.closed.why, /R-6\.26 is superseded by R-6\.28/);
  assert.equal(entry.closed.by, "runner");
  assert.match(git(d, ["log", "-1", "--format=%s", "main"]), /redo entry withdrawn/);
  assert.match(git(d, ["log", "-1", "--format=%an", "main"]), /^sdlc$/, "committed as the pipeline");

  const head = git(d, ["rev-parse", "main"]);
  const again = settleRuling(d, "derive-tests-notifications-stale-5");
  assert.deepEqual(again.redoWithdrawn, [], "already withdrawn, so settling twice does nothing to it");
  assert.equal(git(d, ["rev-parse", "main"]), head, "settling twice commits nothing");
});

test("an approval's own merge withdraws a redo entry for a criterion already superseded when it ran", async (t) => {
  const d = project(t);
  const { rule } = await import("../src/commands/rule.mjs");
  git(d, ["checkout", "-q", "-b", "proposal/derive-tests-notifications-stale-5"]);
  commit(d, { ".sdlc/proposals/derive-tests-notifications-stale-5.md": '---\ngate: G3\nquestion: "q"\nrecommendation: "r"\n---\n' }, "propose(G3): derive-tests-notifications-stale-5");

  rule(d, "derive-tests-notifications-stale-5", "approve", { by: "tech-lead" });

  git(d, ["checkout", "-q", "main"]);
  const entry = redoOnMain(d).find((e) => e.id === "R-6.26");
  assert.equal(entry?.closed?.outcome, "withdrawn", "withdrawn in the approval's own merge, not left for --settle");
  assert.match(entry.closed.why, /R-6\.26 is superseded by R-6\.28/);
});

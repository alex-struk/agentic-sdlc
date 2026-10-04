// A binding run is handed every open rebind entry for its target. When its proposal is approved
// with the adapter left as it was, the approval's merge closes each unbound entry the run was
// handed, naming the binding that answered it, so the entry is not offered to bind-adapter again
// (`docs/decisions/0097`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { isOpen, read } from "../src/spec/owed.mjs";

const git = (d, args) => execFileSync("git", args, { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const AS_PIPELINE = ["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost"];

function commit(d, files, message = "record") {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), text);
  }
  git(d, ["add", "-A"]);
  git(d, [...AS_PIPELINE, "commit", "-q", "--allow-empty", "-m", message]);
}

function config() {
  const seat = { holder: "tech-lead", escalate_to: "lead" };
  const gates = { G0: seat, G1: seat, "G-DESIGN": seat, G2: seat, G3: seat, "G-POL": { holder: "agent:lead", escalate_to: "lead" } };
  return [
    "pipeline: { repo: a, ref: main }", "profile: rebuild", "stack: openshift-ts",
    "project: { name: p, domains: [proposals] }",
    "targets: { new: { base_url: \"http://localhost:3000\", identity: sandbox-idp } }",
    "policy:", "  gates:",
    ...Object.entries(gates).map(([g, v]) => `    ${g}: ${JSON.stringify(v)}`),
    "  default_tier: STANDARD",
    "skills: { packs: [] }", "egress: { rules: [E-2] }", "",
  ].join("\n");
}

const entry = (id, adapter, at = "2026-01-01T00:00:00.000Z") => ({
  id, target: "new", why: `unbound: page.${id} — Page not found`, found: "unbound", adapter, slice: 14, app_tree: "tree-a", by: "runner:verify", at,
});

function project(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-rebind-answered-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(d, ["init", "-q", "-b", "main"]);
  commit(d, { ".sdlc/config.yaml": config(), "tests/adapters/new/index.ts": "export default 1;\n" }, "start");
  const adapter = git(d, ["rev-parse", "HEAD:tests/adapters/new"]);
  commit(d, { "tests/adapters/rebind.yaml": stringifyYaml({ rebind: [entry("R-1.31", adapter), entry("R-2.7", adapter)] }) }, "verify(slice 14): unbound");
  return { d, adapter };
}

function binding(d, name, files = {}) {
  git(d, ["checkout", "-q", "-b", `proposal/${name}`]);
  commit(d, { ...files, [`.sdlc/proposals/${name}.md`]: '---\ngate: G3\nquestion: "q"\nrecommendation: "r"\n---\n' }, `propose(G3): ${name}`);
  git(d, ["checkout", "-q", "main"]);
}

const rebindOnMain = (d) => { git(d, ["checkout", "-q", "main"]); return read(d, "rebind"); };

test("an approved binding that left the adapter as it was closes the unbound entries it was handed, naming itself", async (t) => {
  const { d } = project(t);
  const { rule } = await import("../src/commands/rule.mjs");
  binding(d, "bind-adapter-new-3");
  rule(d, "bind-adapter-new-3", "approve", { by: "tech-lead" });
  const entries = rebindOnMain(d);
  assert.deepEqual(entries.filter(isOpen), [], "nothing left for bind-adapter to be offered");
  for (const e of entries) {
    assert.equal(e.closed.outcome, "met");
    assert.equal(e.closed.answered_by, "bind-adapter-new-3");
    assert.match(e.closed.why, /bind-adapter-new-3 was approved and left tests\/adapters\/new as it was/);
  }
  assert.match(git(d, ["show", "--stat", "--format=%s", "HEAD"]), /tests\/adapters\/rebind\.yaml/, "closed in the approval's merge commit");
});

test("an approved binding that changed the adapter leaves its entries to the run that measures with it", async (t) => {
  const { d } = project(t);
  const { rule } = await import("../src/commands/rule.mjs");
  binding(d, "bind-adapter-new-3", { "tests/adapters/new/index.ts": "export default 2;\n" });
  rule(d, "bind-adapter-new-3", "approve", { by: "tech-lead" });
  assert.equal(rebindOnMain(d).filter(isOpen).length, 2);
});

test("an entry filed after the binding was cut is not one it was handed, and stays open", async (t) => {
  const { d, adapter } = project(t);
  const { rule } = await import("../src/commands/rule.mjs");
  binding(d, "bind-adapter-new-3");
  const filed = read(d, "rebind").map((e) => ({ id: e.id, target: e.target, why: e.why, found: e.found, adapter: e.adapter, slice: e.slice, app_tree: e.app_tree, by: e.by, at: e.at }));
  commit(d, { "tests/adapters/rebind.yaml": stringifyYaml({ rebind: [...filed, entry("R-8.20", adapter, "2026-01-03T00:00:00.000Z")] }) }, "verify(slice 15): unbound");
  rule(d, "bind-adapter-new-3", "approve", { by: "tech-lead" });
  assert.deepEqual(rebindOnMain(d).filter(isOpen).map((e) => e.id), ["R-8.20"]);
});

test("rule --settle closes what a binding approved before this rule existed was handed", async (t) => {
  const { d } = project(t);
  const { settleApproved } = await import("../src/commands/rule.mjs");
  const name = "bind-adapter-new-3";
  binding(d, name);
  git(d, ["checkout", "-q", `proposal/${name}`]);
  commit(d, { [`.sdlc/gates/${name}.yaml`]: stringifyYaml({ gate: "G3", verdict: "approve", by: "agent:reviewer", held_by: "agent", at: "2026-01-02T00:00:00.000Z" }) }, `rule(G3): ${name} approve by agent:reviewer`);
  git(d, ["checkout", "-q", "main"]);
  git(d, [...AS_PIPELINE, "merge", "-q", "--no-ff", "-m", `merge: ${name} approved at G3 by agent:reviewer`, `proposal/${name}`]);
  assert.equal(read(d, "rebind").filter(isOpen).length, 2, "the approval merged without closing anything");

  const r = settleApproved(d, name);
  assert.deepEqual(r.rebind, ["R-1.31", "R-2.7"]);
  assert.deepEqual(rebindOnMain(d).filter(isOpen), []);
  assert.match(git(d, ["log", "-1", "--format=%s"]), /2 unbound bindings answered with the adapter as it was \(rebind\)/);
  assert.equal(settleApproved(d, name).path, null, "settling twice changes nothing");
});

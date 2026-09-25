import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { whatNext, formatNext, formatNextShort, lineage, routeOf, matchesNext } from "../src/runner/next.mjs";
import { COMMANDS } from "../src/cli.mjs";
import "../src/commands/next.mjs";

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

function config({ profile = "rebuild", domains = ["alpha", "beta"], gates = {}, policy = [] } = {}) {
  const seat = { holder: "agent:owner", escalate_to: "lead" };
  const all = { G0: seat, G1: seat, "G-DESIGN": seat, G2: seat, G3: seat, "G-POL": { holder: "agent:lead", escalate_to: "lead" }, ...gates };
  return [
    "pipeline: { repo: a, ref: main }", `profile: ${profile}`, "stack: openshift-ts",
    `project: { name: p, domains: [${domains.join(", ")}] }`,
    "policy:", "  gates:",
    ...Object.entries(all).map(([g, v]) => `    ${g}: ${JSON.stringify(v)}`),
    "  default_tier: STANDARD", ...policy.map((l) => `  ${l}`),
    "skills: { packs: [] }", "egress: { rules: [E-2] }", "",
  ].join("\n");
}

function project(t, opts = {}) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-next-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(d, ["init", "-q", "-b", "main"]);
  commit(d, { ".sdlc/config.yaml": config(opts) }, "start");
  return d;
}

const gateText = (gate, verdict, extra = {}) => stringifyYaml({ gate, verdict, by: "agent:owner", held_by: "agent", at: "2026-01-01T00:00:00.000Z", ...extra });

// A ruling recorded on `main`, as an approval leaves it once merged.
function approved(d, names, gate = "G1") {
  commit(d, Object.fromEntries(names.map((n) => [`.sdlc/gates/${n}.yaml`, gateText(gate, "approve")])), `rule: ${names.join(", ")}`);
}

// A proposal branch cut from `main`, optionally carrying a ruling of its own.
function proposal(d, name, gate, { ruling = null, files = {} } = {}) {
  git(d, ["checkout", "-q", "-b", `proposal/${name}`]);
  commit(d, { [`.sdlc/proposals/${name}.md`]: `---\ngate: ${gate}\nquestion: "q"\nrecommendation: "r"\n---\n`, ...files }, `propose(${gate}): ${name}`);
  if (ruling) commit(d, { [`.sdlc/gates/${name}.yaml`]: gateText(gate, ruling.verdict, ruling.extra) }, `rule(${gate}): ${name}`);
  git(d, ["checkout", "-q", "main"]);
}

function index(rows) {
  return JSON.stringify({ generated_from: "abc", criteria: rows.map(([id, domain, version = 1, state = "accepted"]) => ({ id, domain, version, state, confidence: "confirmed" })) });
}

// A project whose spec phase is complete for both domains: intent approved, each domain
// recovered, approved and ratified.
function specDone(d) {
  approved(d, ["intent-thing"], "G0");
  approved(d, ["archaeology-alpha", "archaeology-beta"]);
  commit(d, {
    "spec/criteria-index.json": index([["R-1.1", "alpha"], ["R-2.1", "beta"]]),
    "spec/domains/alpha.md": "# alpha\n\n### R-1.1 · v1 · confirmed · recovered\n",
    "spec/domains/beta.md": "# beta\n\n### R-2.1 · v1 · confirmed · recovered\n",
  }, "stage(ratify)");
}

function snapshot(d) {
  return {
    head: git(d, ["rev-parse", "HEAD"]),
    branch: git(d, ["rev-parse", "--abbrev-ref", "HEAD"]),
    refs: git(d, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    status: git(d, ["status", "--porcelain", "--untracked-files=all"]),
  };
}

test("lineage numbers a proposal within its line of work", () => {
  assert.deepEqual(lineage("build-slice-1-6"), { family: "build-slice-1", n: 6 });
  assert.deepEqual(lineage("build-slice-2"), { family: "build-slice-2", n: 1 });
  assert.deepEqual(lineage("contract-v3"), { family: "contract", n: 3 });
  assert.deepEqual(lineage("archaeology-alpha"), { family: "archaeology-alpha", n: 1 });
  assert.deepEqual(lineage("derive-tests-alpha-stale-2"), { family: "derive-tests-alpha-stale", n: 2 });
});

test("routeOf reads the stage and subject off a proposal's name, domains by the configured list", () => {
  const cfg = { project: { domains: ["alpha", "alpha-two"] }, targets: { new: {} }, oracle: { target: "old" } };
  assert.deepEqual(routeOf("archaeology-alpha-two", cfg), { stage: "archaeology", domain: "alpha-two" });
  assert.deepEqual(routeOf("derive-tests-alpha-stale-1", cfg), { stage: "derive-tests", domain: "alpha", stale: true });
  assert.deepEqual(routeOf("bind-adapter-old-4", cfg), { stage: "bind-adapter", target: "old" });
  assert.deepEqual(routeOf("calibrate-triage-old-2", cfg), { stage: "calibrate", target: "old" });
  assert.deepEqual(routeOf("build-slice-3-2", cfg), { stage: "build", slice: 3 });
  assert.deepEqual(routeOf("plan-2", cfg), { stage: "plan" });
  assert.equal(routeOf("policy-v4", cfg), null);
});

test("a fresh project is told to run the first stage of the sequence", (t) => {
  const d = project(t);
  const r = whatNext(d);
  assert.equal(r.state, "run");
  assert.equal(r.next.command, "sdlc run intent");
  assert.equal(r.next.kind, "sequence");
  assert.equal(r.phase.number, 1);
  assert.match(r.next.why, /phase 1 Spec is not complete/);
});

test("the spec phase moves domain by domain in the configured order", (t) => {
  const d = project(t);
  approved(d, ["intent-thing"], "G0");
  approved(d, ["archaeology-beta"]);
  const r = whatNext(d);
  // Both are ready: ratify beta (its archaeology is approved) and archaeology alpha.
  assert.deepEqual(r.ready.map((c) => c.command), ["sdlc run archaeology --domain alpha", "sdlc run ratify --domain beta"]);
});

test("an open proposal at a seat an agent plays is ruled before anything else starts", (t) => {
  const d = project(t);
  approved(d, ["intent-thing"], "G0");
  proposal(d, "archaeology-alpha", "G1");
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc rule archaeology-alpha --by agent:owner");
  assert.equal(r.next.kind, "proposals");
  assert.ok(!r.ready.some((c) => c.command === "sdlc run archaeology --domain alpha"), "the domain in flight is not offered again");
  assert.ok(r.ready.some((c) => c.command === "sdlc run archaeology --domain beta"));
});

test("a proposal at a seat a person holds waits on that person and exits distinctly", async (t) => {
  const d = project(t, { profile: "feature", gates: { G0: { holder: "owner" } } });
  proposal(d, "intent-thing", "G0");
  const r = whatNext(d);
  assert.equal(r.state, "waiting");
  assert.equal(r.next, null);
  assert.deepEqual(r.waiting.map((w) => [w.on, w.name, w.command]), [["owner", "intent-thing", "sdlc rule intent-thing approve|return --by owner"]]);
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let code;
  try { code = await COMMANDS.next({ pos: [d], flags: {} }); } finally { console.log = orig; }
  assert.equal(code, 3);
  assert.match(logs.join("\n"), /nothing can run until a person acts/);
  assert.match(logs.join("\n"), /owner: intent-thing/);
});

test("an escalation an agent can rule is ready; one that reached the role that raised it is a dead end", (t) => {
  const d = project(t);
  approved(d, ["intent-thing"], "G0");
  proposal(d, "archaeology-alpha", "G1", { ruling: { verdict: "escalated", extra: { by: "agent:owner", escalate_to: "lead" } } });
  proposal(d, "archaeology-beta", "G1", { ruling: { verdict: "escalated", extra: { by: "agent:lead", escalate_to: "lead" } } });
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc rule archaeology-alpha --by agent:lead");
  assert.equal(r.waiting.length, 1);
  assert.equal(r.waiting[0].name, "archaeology-beta");
  assert.match(r.waiting[0].why, /dead end only a person can rule/);
  assert.equal(r.waiting[0].command, "sdlc rule archaeology-beta approve|return --by lead");
});

test("a returned proposal is revised by its stage, and one a later proposal replaced is not", (t) => {
  const d = project(t, { profile: "feature" });
  approved(d, ["intent-thing"], "G0");
  approved(d, ["plan"], "G2");
  commit(d, { "plan/tasks.md": "### Slice 1 · First\n- criteria: R-1.1\n\n### Slice 2 · Second\n- criteria: R-1.2\n" });
  proposal(d, "build-slice-1", "G3", { ruling: { verdict: "return", extra: { by: "runner:verify" } } });
  proposal(d, "policy-v1", "G-POL", { ruling: { verdict: "return" } });
  approved(d, ["policy-v2"], "G-POL");
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc run build --slice 1 --revise");
  assert.match(r.next.why, /build-slice-1 was returned at G3 by runner:verify/);
  assert.ok(!r.ready.some((c) => c.command === "sdlc run build --slice 1"), "the slice in flight is not built from nothing");
  assert.ok(!r.waiting.some((w) => w.name === "policy-v1"), "policy-v2 replaced it");
});

test("a build proposal is verified before it is ruled", (t) => {
  const d = project(t, { profile: "feature" });
  approved(d, ["intent-thing"], "G0");
  approved(d, ["plan"], "G2");
  commit(d, { "plan/tasks.md": "### Slice 1 · First\n- criteria: R-1.1\n", "app/index.ts": "export {};\n" });
  proposal(d, "build-slice-1", "G3", { files: { "app/index.ts": "export const a = 1;\n" } });
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc run verify --slice 1");
  assert.equal(r.next.kind, "proposals");
});

test("slices are built in the plan's order, and a finished plan leaves a stage this pipeline does not run", (t) => {
  const d = project(t, { profile: "feature" });
  approved(d, ["intent-thing"], "G0");
  approved(d, ["plan"], "G2");
  commit(d, { "plan/tasks.md": "### Slice 1 · First\n- criteria: R-1.1\n\n### Slice 2 · Second\n- criteria: R-1.2\n" });
  approved(d, ["build-slice-1-3"], "G3");
  assert.equal(whatNext(d).next.command, "sdlc run build --slice 2");
  approved(d, ["build-slice-2"], "G3");
  const r = whatNext(d);
  assert.equal(r.state, "idle");
  assert.match(r.blocked, /deploy, is not implemented/);
  assert.match(formatNext(r), /^next: nothing to run: the next stage in the sequence, deploy, is not implemented/);
});

test("owed work is taken before the sequence moves on, grouped by the run that answers it", (t) => {
  const d = project(t);
  specDone(d);
  commit(d, {
    "tests/acceptance/redo.yaml": stringifyYaml({ redo: [{ id: "R-2.1", version: 1, why: "asserted the wrong thing" }] }),
    ".sdlc/conditions.yaml": stringifyYaml({ conditions: [{ ref: "contract-v1#1", text: "name the fee", stage: "contract", from: "contract-v1", gate: "G1", by: "agent:owner" }] }),
  });
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc run derive-tests --domain beta --stale");
  assert.equal(r.next.kind, "owed");
  assert.match(r.next.why, /1 test to derive again \(redo\) in beta/);
  assert.ok(r.ready.some((c) => c.command === "sdlc run contract" && c.kind === "sequence"));
  assert.ok(!r.ready.some((c) => c.stage === "contract" && c.kind === "owed"), "a condition is never a reason to start a run");
  assert.deepEqual(r.owed.map((o) => [o.kind, o.stage, o.count]), [["condition", "contract", 1], ["redo", "derive-tests", 1]]);
});

test("a test written against an older version of its criterion is stale and owed", (t) => {
  const d = project(t);
  specDone(d);
  commit(d, {
    "spec/criteria-index.json": index([["R-1.1", "alpha", 2], ["R-2.1", "beta"]]),
    "tests/acceptance/alpha/R-1.1.spec.ts": "// criterion: @R-1.1 v1\n// provenance: blind, spec@abc, derived 2026-01-01\n",
    "tests/acceptance/beta/R-2.1.spec.ts": "// criterion: @R-2.1 v1\n// provenance: blind, spec@abc, derived 2026-01-01\n",
  });
  const r = whatNext(d);
  assert.deepEqual(r.stale, [{ domain: "alpha", ids: ["R-1.1"] }]);
  assert.equal(r.next.command, "sdlc run derive-tests --domain alpha --stale");
});

test("which kind of ready work goes first is policy.next.order", (t) => {
  const d = project(t, { policy: ["next: { order: [sequence, owed, proposals] }"] });
  specDone(d);
  commit(d, { "tests/acceptance/redo.yaml": stringifyYaml({ redo: [{ id: "R-2.1", version: 1, why: "w" }] }) });
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc run contract");
  assert.match(r.next.rule, /sequence before owed \(policy\.next\.order: sequence, owed, proposals\)/);
});

test("the record is read from main whatever is checked out, and nothing is written", (t) => {
  const d = project(t);
  approved(d, ["intent-thing"], "G0");
  proposal(d, "archaeology-alpha", "G1");
  git(d, ["checkout", "-q", "-b", "elsewhere"]);
  commit(d, { ".sdlc/gates/archaeology-beta.yaml": gateText("G1", "approve") }, "a ruling main does not have");
  writeFileSync(join(d, "scratch.txt"), "uncommitted\n");
  const before = snapshot(d);
  const r = whatNext(d);
  assert.ok(r.ready.some((c) => c.command === "sdlc run archaeology --domain beta"), "beta's approval exists only off main");
  assert.deepEqual(snapshot(d), before);
});

test("sdlc next --json leaves the tree and every ref exactly as it found them", async (t) => {
  const d = project(t);
  approved(d, ["intent-thing"], "G0");
  proposal(d, "archaeology-alpha", "G1", { ruling: { verdict: "return" } });
  const before = snapshot(d);
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let code;
  try { code = await COMMANDS.next({ pos: [d], flags: { json: true } }); } finally { console.log = orig; }
  assert.equal(code, 0);
  assert.equal(JSON.parse(logs.join("\n")).next.command, "sdlc run archaeology --domain alpha --revise");
  assert.deepEqual(snapshot(d), before);
});

test("matchesNext compares the stage and every subject next names", (t) => {
  const d = project(t);
  specDone(d);
  commit(d, { "tests/acceptance/redo.yaml": stringifyYaml({ redo: [{ id: "R-2.1", version: 1, why: "w" }] }) });
  const r = whatNext(d);
  assert.equal(matchesNext(r, "derive-tests", { domain: "beta", stale: true }), true);
  assert.equal(matchesNext(r, "derive-tests", { domain: "alpha", stale: true }), false);
  assert.equal(matchesNext(r, "derive-tests", { domain: "beta" }), false);
  assert.equal(matchesNext(r, "contract", {}), false);
  assert.match(formatNextShort(r), /^next: sdlc run derive-tests --domain beta --stale\n {2}why: .*\n {2}\(1 more ready: sdlc next\)$/);
});

test("policy.next.order names each kind of work once", async () => {
  const { parseConfig } = await import("../src/config/load.mjs");
  assert.deepEqual(parseConfig(config({ policy: ["next: { order: [owed, sequence, proposals] }"] })).errors, []);
  assert.notDeepEqual(parseConfig(config({ policy: ["next: { order: [owed, owed, proposals] }"] })).errors, []);
  assert.notDeepEqual(parseConfig(config({ policy: ["next: { order: [owed, sequence] }"] })).errors, []);
  assert.notDeepEqual(parseConfig(config({ policy: ["next: { order: [owed, sequence, later] }"] })).errors, []);
});

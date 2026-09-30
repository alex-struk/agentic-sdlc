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

function config({ profile = "rebuild", domains = ["alpha", "beta"], gates = {}, policy = [], extra = [] } = {}) {
  const seat = { holder: "agent:owner", escalate_to: "lead" };
  const all = { G0: seat, G1: seat, "G-DESIGN": seat, G2: seat, G3: seat, "G-POL": { holder: "agent:lead", escalate_to: "lead" }, ...gates };
  return [
    "pipeline: { repo: a, ref: main }", `profile: ${profile}`, "stack: openshift-ts",
    `project: { name: p, domains: [${domains.join(", ")}] }`,
    "policy:", "  gates:",
    ...Object.entries(all).map(([g, v]) => `    ${g}: ${JSON.stringify(v)}`),
    "  default_tier: STANDARD", ...policy.map((l) => `  ${l}`),
    "skills: { packs: [] }", "egress: { rules: [E-2] }", ...extra, "",
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

// A request is offered as the run that takes it up: `--revise` for a stage that revises, the
// stage's own run for one whose every run starts from `main`.
test("a request is offered as the run of the stage it is addressed to", (t) => {
  const d = project(t);
  specDone(d);
  approved(d, ["contract-v1"]);
  approved(d, ["derive-tests-alpha", "derive-tests-beta"], "G3");
  commit(d, { ".sdlc/revision-requests.yaml": stringifyYaml({ requests: [
    { stage: "contract", why: "seed a second record", from: "derive-tests-alpha-stale-1", gate: "G3", by: "agent:owner", at: "2026-01-02T00:00:00.000Z" },
  ] }) });
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc run contract");
  assert.equal(r.next.kind, "owed");
  assert.match(r.next.why, /1 revision request owed by contract/);
});

// A return whose ruling also asked another stage for what the revision is to be built on is not
// revised until that stage has answered and its answer is approved: the revision would otherwise
// be built on the artifact the ruling said has to change.
test("a returned proposal waits for what its own ruling asked of another stage", (t) => {
  const d = project(t);
  specDone(d);
  approved(d, ["contract-v1"]);
  approved(d, ["derive-tests-alpha", "derive-tests-beta"], "G3");
  proposal(d, "derive-tests-alpha-stale-1", "G3", { ruling: { verdict: "return" } });
  const request = { stage: "contract", why: "seed a second record", from: "derive-tests-alpha-stale-1", gate: "G3", by: "agent:owner", at: "2026-01-02T00:00:00.000Z" };
  commit(d, { ".sdlc/revision-requests.yaml": stringifyYaml({ requests: [request] }) });
  const revise = "sdlc run derive-tests --domain alpha --revise";

  let r = whatNext(d);
  assert.equal(r.next.command, "sdlc run contract", "the request first");
  assert.ok(!r.ready.some((c) => c.command === revise), "the revision is not offered while the request is open");
  assert.match(r.held.find((h) => h.command === revise)?.why ?? "", /derive-tests-alpha-stale-1 asked contract .* not yet answered/);
  assert.match(formatNext(r), /^held:\n {2}sdlc run derive-tests --domain alpha --revise — /m);

  // Answered, and the answer still in front of its own gate.
  commit(d, { ".sdlc/revision-requests.yaml": stringifyYaml({ requests: [{ ...request, taken: "2026-01-03T00:00:00.000Z", taken_by: "contract-v2" }] }) });
  proposal(d, "contract-v2", "G1");
  r = whatNext(d);
  assert.ok(!r.ready.some((c) => c.command === revise));
  assert.match(r.held.find((h) => h.command === revise)?.why ?? "", /answered by contract-v2, which is not yet approved/);

  // Approved: the revision is what comes next.
  approved(d, ["contract-v2"]);
  r = whatNext(d);
  assert.equal(r.next.command, revise);
  assert.deepEqual(r.held, []);
});

// Only another stage's answer is waited for. A request a ruling addressed to the stage it
// returned is answered by the same revision.
test("a returned proposal does not wait for a request addressed to its own stage", (t) => {
  const d = project(t);
  specDone(d);
  approved(d, ["contract-v1"]);
  approved(d, ["derive-tests-alpha", "derive-tests-beta"], "G3");
  proposal(d, "derive-tests-alpha-stale-1", "G3", { ruling: { verdict: "return" } });
  commit(d, { ".sdlc/revision-requests.yaml": stringifyYaml({ requests: [
    { stage: "derive-tests", why: "and the other suite too", from: "derive-tests-alpha-stale-1", gate: "G3", by: "agent:owner", at: "2026-01-02T00:00:00.000Z" },
  ] }) });
  const r = whatNext(d);
  assert.ok(r.ready.some((c) => c.command === "sdlc run derive-tests --domain alpha --revise"));
  assert.deepEqual(r.held, []);
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

// A criterion another has since superseded, or made obsolete, is derived no test
// (`acceptedCriteria` excludes it), so a redo entry for one is an entry no `--stale` run would
// ever take up: offering one would have `sdlc next` name the same run forever. The entry is
// still counted as owed — until the next pipeline commit that touches the list withdraws it
// (`docs/decisions/0052`) — but never offered as something to run.
test("a redo entry for a criterion another has superseded is not offered as a run", (t) => {
  const d = project(t);
  specDone(d);
  commit(d, {
    "spec/criteria-index.json": JSON.stringify({ generated_from: "abc", criteria: [
      { id: "R-1.1", domain: "alpha", version: 1, state: "accepted", confidence: "confirmed" },
      { id: "R-2.1", domain: "beta", version: 2, state: "accepted", confidence: "confirmed", supersededBy: "R-2.2" },
      { id: "R-2.2", domain: "beta", version: 1, state: "accepted", confidence: "confirmed" },
    ] }),
    "tests/acceptance/redo.yaml": stringifyYaml({ redo: [{ id: "R-2.1", version: 2, why: "notifications changed" }] }),
  });
  const r = whatNext(d);
  assert.deepEqual(r.owed.map((o) => [o.kind, o.stage, o.count]), [["redo", "derive-tests", 1]], "still counted as owed");
  assert.ok(!r.ready.some((c) => c.stage === "derive-tests" && c.args?.stale), "never offered as a run");
  assert.ok(!formatNext(r).includes("derive again (redo)"), formatNext(r));
});

// A criterion recorded untestable is owed a test from the moment its record is on main, by
// the stage the record names or by contract, and is routed to the run that answers it.
test("missing tests are owed work, routed by the stage that owes each one", (t) => {
  const d = project(t);
  specDone(d);
  approved(d, ["contract-v1"]);
  const item = (id, domain, stage, more = {}) => ({ kind: "missing-test", item: id, id, version: 1, domain, stage, why: "x", by: "runner", at: "2026-01-01T00:00:00.000Z", ...more });
  commit(d, {
    "spec/criteria-index.json": index([["R-1.1", "alpha"], ["R-1.2", "alpha"], ["R-2.1", "beta"], ["R-2.2", "beta"], ["R-2.3", "beta"]]),
    "tests/acceptance/not-testable.yaml": stringifyYaml({ criteria: [{ id: "R-1.1", version: 1, reason: "blocked: no observation" }] }),
    ".sdlc/owed.yaml": stringifyYaml({ owed: [
      item("R-2.1", "beta", "derive-tests"),
      item("R-2.2", "beta", "calibrate", { target: "old" }),
      item("R-2.3", "beta", "verify"),
      item("R-1.2", "alpha", "contract", { closed: { outcome: "withdrawn", why: "no test is owed", by: "lead", at: "2026-01-02T00:00:00.000Z" } }),
    ] }),
  });
  const r = whatNext(d);
  const owed = r.ready.filter((c) => c.kind === "owed");
  // Contract owes alpha a test and nothing in beta, so beta's test writer goes first and the
  // contract run waits to take whatever that surfaces with it (`docs/decisions/0069`).
  assert.deepEqual(owed.map((c) => c.command), [
    "sdlc run derive-tests --domain beta --stale",
    "sdlc run calibrate --target old",
  ]);
  assert.match(r.held.find((h) => h.command === "sdlc run contract")?.why ?? "", /^1 missing test owed by contract/);
  assert.match(owed[1].why, /1 missing test owed a run for target old/);
  assert.deepEqual(r.owed.filter((o) => o.kind === "missing-test").map((o) => [o.stage, o.count]),
    [["derive-tests", 1], ["calibrate", 1], ["verify", 1], ["contract", 1]]);
  assert.match(formatNext(r), /owed: .*1 missing-test \(contract\)/);
});

// A run offered for work it has already said it cannot do, or a stage with no turn to be
// handed anything, is a loop; those wait on a ruler instead.
test("missing tests no run can answer wait on a ruler; handed-on ones go to each domain's writer", (t) => {
  const d = project(t);
  specDone(d);
  approved(d, ["contract-v1"]);
  const item = (id, domain, stage, more = {}) => ({ kind: "missing-test", item: id, id, version: 1, domain, stage, why: "x", by: "runner", at: "2026-01-01T00:00:00.000Z", ...more });
  const kept = { by: "contract-v1", gate: "G1", approved_by: "agent:owner", at: "2026-01-02T00:00:00.000Z" };
  commit(d, {
    "spec/criteria-index.json": index([["R-1.1", "alpha"], ["R-1.2", "alpha"], ["R-1.3", "alpha"], ["R-2.1", "beta"], ["R-2.2", "beta"]]),
    ".sdlc/owed.yaml": stringifyYaml({ owed: [
      item("R-1.1", "alpha", "contract", { kept }),
      item("R-1.2", "alpha", "ratify"),
      item("R-1.3", "alpha", "derive-tests"),
      item("R-2.1", "beta", "derive-tests"),
      item("R-2.2", "beta", "contract", { kept }),
    ] }),
  });
  const r = whatNext(d);
  assert.deepEqual(r.ready.filter((c) => c.kind === "owed").map((c) => c.command), [
    "sdlc run derive-tests --domain alpha --stale",
    "sdlc run derive-tests --domain beta --stale",
  ]);
  const waiting = r.waiting.filter((w) => /missing test/.test(w.why));
  assert.equal(waiting.length, 2);
  assert.match(waiting.find((w) => w.name.includes("contract")).why, /2 missing tests .*kept at contract-v1/);
  assert.match(waiting.find((w) => w.name.includes("ratify")).why, /1 missing test owed by ratify/);
  for (const w of waiting) assert.match(w.command, /condition-withdrawn missing-test\/<id>/);
  assert.match(formatNext(r), /waiting on a person:\n.*missing tests \(contract\)/);
});

// What contract owes comes from the test writer's rulings, one domain at a time. A contract run
// started the moment one domain's ruling filed a need would be followed by the next domain's
// ruling filing another, one contract version each. So contract waits while the test writer
// has ready work in a domain contract owes nothing, and takes every domain's needs in one run
// (`docs/decisions/0069`).
const contractOwes = (id, domain, from) => ({ kind: "missing-test", item: id, id, version: 1, domain, stage: "contract", why: "a seeded record in a second state", from, gate: "G3", by: "agent:owner", at: "2026-01-02T00:00:00.000Z" });

function testsDerived(d) {
  specDone(d);
  approved(d, ["contract-v1"]);
  approved(d, ["derive-tests-alpha", "derive-tests-beta"], "G3");
}

test("a contract run for downstream needs waits while the test writer has ready work in a domain contract owes nothing", (t) => {
  const d = project(t);
  testsDerived(d);
  commit(d, {
    ".sdlc/owed.yaml": stringifyYaml({ owed: [contractOwes("R-1.1", "alpha", "derive-tests-alpha")] }),
    "tests/acceptance/redo.yaml": stringifyYaml({ redo: [{ id: "R-2.1", version: 1, why: "asserted the wrong thing" }] }),
  });
  let r = whatNext(d);
  assert.equal(r.next.command, "sdlc run derive-tests --domain beta --stale");
  assert.ok(!r.ready.some((c) => c.stage === "contract"), "contract is not offered yet");
  const held = r.held.find((h) => h.command === "sdlc run contract");
  assert.equal(held?.stage, "contract");
  assert.match(held.why, /^1 missing test owed by contract; held while derive-tests has ready work in beta, where contract owes nothing yet, so one contract run takes every domain's needs$/);
  assert.match(formatNext(r), /^held:\n {2}sdlc run contract — 1 missing test owed by contract; held while /m);
  assert.match(formatNextShort(r), /1 held/);

  // Beta's test writer has run and its proposal is being ruled: the ruling comes first, and
  // what it files joins the same contract run.
  proposal(d, "derive-tests-beta-stale-1", "G3");
  r = whatNext(d);
  assert.equal(r.next.command, "sdlc rule derive-tests-beta-stale-1 --by agent:owner");
  assert.equal(r.next.kind, "proposals");

  // Ruled, and it filed a need of its own: nothing is left for the test writer that does not
  // rest on contract, so contract runs, once, for both domains.
  approved(d, ["derive-tests-beta-stale-1"], "G3");
  commit(d, {
    "tests/acceptance/redo.yaml": stringifyYaml({ redo: [{ id: "R-2.1", version: 1, why: "asserted the wrong thing", closed: { outcome: "met", why: "derived again", by: "runner", at: "2026-01-03T00:00:00.000Z" } }] }),
    ".sdlc/owed.yaml": stringifyYaml({ owed: [contractOwes("R-1.1", "alpha", "derive-tests-alpha"), contractOwes("R-2.1", "beta", "derive-tests-beta-stale-1")] }),
  });
  r = whatNext(d);
  assert.equal(r.next.command, "sdlc run contract");
  assert.match(r.next.why, /^2 missing tests owed by contract$/);
  assert.deepEqual(r.held, []);
});

// Held behind contract is only work that does not rest on it. The test writer's work in a
// domain contract owes something would be done again once contract answers, so it waits with
// contract rather than going ahead of it.
test("the test writer's work in a domain contract owes waits behind the contract run", (t) => {
  const d = project(t);
  testsDerived(d);
  commit(d, {
    ".sdlc/owed.yaml": stringifyYaml({ owed: [contractOwes("R-1.1", "alpha", "derive-tests-alpha")] }),
    "tests/acceptance/redo.yaml": stringifyYaml({ redo: [{ id: "R-1.1", version: 1, why: "w" }, { id: "R-2.1", version: 1, why: "w" }] }),
  });
  let r = whatNext(d);
  assert.deepEqual(r.ready.filter((c) => c.kind === "owed").map((c) => c.command), ["sdlc run derive-tests --domain beta --stale"]);
  assert.match(r.held.find((h) => h.command === "sdlc run derive-tests --domain alpha --stale")?.why ?? "",
    /^1 test to derive again \(redo\) in alpha owed by derive-tests; held behind sdlc run contract, which owes alpha what this run would otherwise be run again for$/);

  // With only that domain's work left, nothing holds contract: it runs, and the domain after it.
  commit(d, { "tests/acceptance/redo.yaml": stringifyYaml({ redo: [{ id: "R-1.1", version: 1, why: "w" }] }) });
  r = whatNext(d);
  assert.deepEqual(r.ready.filter((c) => c.kind === "owed").map((c) => c.command), ["sdlc run contract", "sdlc run derive-tests --domain alpha --stale"]);
  assert.deepEqual(r.held, []);
});

// A returned revision whose own ruling asked contract for something is held on that request
// (`heldBy`), so it is not ready work and cannot hold the contract run it is waiting on.
test("a revision waiting on contract never holds contract back", (t) => {
  const d = project(t);
  testsDerived(d);
  proposal(d, "derive-tests-beta-stale-1", "G3", { ruling: { verdict: "return" } });
  commit(d, { ".sdlc/revision-requests.yaml": stringifyYaml({ requests: [
    { stage: "contract", why: "seed a second record", from: "derive-tests-beta-stale-1", gate: "G3", by: "agent:owner", at: "2026-01-02T00:00:00.000Z" },
  ] }) });
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc run contract");
  assert.match(r.held.find((h) => h.command === "sdlc run derive-tests --domain beta --revise")?.why ?? "", /asked contract .* not yet answered/);
});

// A domain whose tests have never been derived is the test writer's work too, though the
// sequence offers it rather than the owed list.
test("a domain never derived holds contract, whatever policy.next.order says", (t) => {
  const d = project(t, { policy: ["next: { order: [owed, proposals, sequence] }"] });
  specDone(d);
  approved(d, ["contract-v1"]);
  approved(d, ["derive-tests-alpha"], "G3");
  commit(d, { ".sdlc/owed.yaml": stringifyYaml({ owed: [contractOwes("R-1.1", "alpha", "derive-tests-alpha")] }) });
  let r = whatNext(d);
  assert.equal(r.next.command, "sdlc run derive-tests --domain beta");
  assert.equal(r.next.kind, "sequence");
  assert.match(r.held.find((h) => h.command === "sdlc run contract")?.why ?? "", /held while derive-tests has ready work in beta/);

  // Its proposal, open for a ruling an agent makes, holds contract until it is ruled.
  proposal(d, "derive-tests-beta", "G3");
  r = whatNext(d);
  assert.equal(r.next.command, "sdlc rule derive-tests-beta --by agent:owner");
  assert.match(r.held.find((h) => h.command === "sdlc run contract")?.why ?? "", /held while derive-tests-beta is ruled/);
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

// A project with an oracle target and a second target, both of whose adapters were bound
// against a contract that declared one member fewer than the contract on main does.
const TARGETS = [
  "oracle: { target: old, compose: c.yml, seed: tests/seed/, base_url: http://localhost:3100, identity: session-route }",
  "targets: { new: { base_url: http://localhost:3200, identity: session-route } }",
];
const SURFACE = stringifyYaml({ pages: [{ id: "a-page", route: "/a", actions: { go: {}, stop: {} }, observations: { shown: {} } }] });
const bindingsFor = (target, members = { actions: { go: "bound" }, observations: { shown: "bound" } }) =>
  stringifyYaml({ target, pages: { "a-page": members } });
const FULL = { actions: { go: "bound", stop: "bound" }, observations: { shown: "bound" } };

function adaptersBound(d, { old = bindingsFor("old"), fresh = bindingsFor("new") } = {}) {
  approved(d, ["contract-v1"]);
  commit(d, {
    "spec/contract/surface.yaml": SURFACE,
    "tests/adapters/old/index.ts": "export default 1;\n", "tests/adapters/old/bindings.yaml": old,
    "tests/adapters/new/index.ts": "export default 1;\n", "tests/adapters/new/bindings.yaml": fresh,
  }, "contract and adapters");
  approved(d, ["bind-adapter-old", "bind-adapter-new"], "G3");
}

// A contract revision that adds members leaves every adapter bound before it out of date,
// and the bind-adapter post-check refuses an adapter that does not name them. So the oracle's
// adapter is owed a binding run, one run carrying both its owed rebinds and the members it
// does not bind, rather than a rebind-only run its own post-check then fails.
test("an adapter the contract has outgrown is owed a binding, in the same run as its rebinds", (t) => {
  const d = project(t, { extra: TARGETS });
  specDone(d);
  adaptersBound(d);
  commit(d, { "tests/adapters/rebind.yaml": stringifyYaml({ rebind: [{ id: "R-1.1", target: "old", why: "reads the wrong heading" }] }) });
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc run bind-adapter --target old");
  assert.equal(r.next.kind, "owed");
  assert.match(r.next.why, /^1 binding to fix \(rebind\), 1 contract member the adapter does not name for target old owed by bind-adapter$/);
  assert.equal(r.ready.filter((c) => c.stage === "bind-adapter").length, 1, "the oracle's work is one run, and the other target's waits");
  assert.deepEqual(r.staleAdapters, [
    { target: "old", missing: ["a-page.stop"], extra: [], offered: true, waits: null },
    { target: "new", missing: ["a-page.stop"], extra: [], offered: false, waits: "bound in phase 4 Build" },
  ]);
  assert.match(formatNext(r), /^stale adapters: 1 member in old, 1 member in new \(bound in phase 4 Build\)$/m);
});

test("an adapter that names what the contract no longer declares is stale too, and one that agrees is not", (t) => {
  const d = project(t, { extra: TARGETS });
  specDone(d);
  adaptersBound(d, {
    old: bindingsFor("old", { actions: { go: "bound", stop: "bound", leave: "bound" }, observations: { shown: "bound" } }),
    fresh: bindingsFor("new", FULL),
  });
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc run bind-adapter --target old");
  assert.match(r.next.why, /^1 name the contract no longer declares for target old owed by bind-adapter$/);
  assert.deepEqual(r.staleAdapters.map((a) => [a.target, a.extra]), [["old", ["a-page.leave"]]]);
});

// Outside the oracle, a target is bound in the Build phase, against an application that exists
// only on a build proposal until it merges; offering it earlier names a run with nothing to bind
// against. Once it is offered, the oracle's adapter still comes first.
test("another target's stale adapter is offered once the Build phase is reached, after the oracle's", (t) => {
  const d = project(t, { extra: TARGETS });
  specDone(d);
  adaptersBound(d);
  approved(d, ["derive-tests-alpha", "derive-tests-beta"], "G3");
  commit(d, { "tests/results/old/latest.json": JSON.stringify({ rows: [{ id: "R-1.1", result: "pass" }, { id: "R-2.1", result: "pass" }] }) });
  approved(d, ["design-alpha", "design-beta"], "G-DESIGN");
  const r = whatNext(d);
  assert.equal(r.phase.number, 4);
  assert.deepEqual(r.ready.filter((c) => c.kind === "owed").map((c) => c.command), [
    "sdlc run bind-adapter --target old",
    "sdlc run bind-adapter --target new",
  ]);
  assert.ok(r.staleAdapters.every((a) => a.offered));
  assert.match(formatNext(r), /^stale adapters: 1 member in old, 1 member in new$/m);
});

// A calibration row whose every failing test ended in the adapter's own `unbound:` error
// reaches no reviewer and no product owner, so the only run that can close it is a binding run
// (`docs/decisions/0067`).
const unboundRow = (id, domain, more = {}) => ({
  id, version: 1, domain, file: `tests/acceptance/${domain}/${id}.spec.ts`, result: "unbound",
  tests: [{ title: "t", status: "failed", error: `Error: unbound: a-page.stop — no button labelled "Stop" on /a` }], ...more,
});

function calibratedWithUnbound(d, rows) {
  adaptersBound(d, { old: bindingsFor("old", FULL), fresh: bindingsFor("new", FULL) });
  approved(d, ["derive-tests-alpha", "derive-tests-beta"], "G3");
  commit(d, { "tests/results/old/latest.json": JSON.stringify({ rows }) }, "stage(calibrate): calibrate against old");
}

test("an unbound calibration row is owed to bind-adapter for its target", (t) => {
  const d = project(t, { extra: TARGETS });
  specDone(d);
  calibratedWithUnbound(d, [unboundRow("R-1.1", "alpha"), unboundRow("R-2.1", "beta")]);
  const r = whatNext(d);
  assert.equal(r.phase.number, 2, "an unbound row keeps phase 2 open");
  assert.equal(r.next.command, "sdlc run bind-adapter --target old");
  assert.equal(r.next.kind, "owed");
  assert.match(r.next.why, /^2 bindings the adapter reports unbound for target old owed by bind-adapter$/);
  assert.deepEqual(r.owed.map((o) => [o.kind, o.stage, o.count]), [["rebind", "bind-adapter", 2]]);
});

test("an unbound row found under an adapter that has since changed is checked again by calibrate", (t) => {
  const d = project(t, { extra: TARGETS });
  specDone(d);
  calibratedWithUnbound(d, [unboundRow("R-1.1", "alpha"), { id: "R-2.1", result: "pass" }]);
  commit(d, { "tests/adapters/old/index.ts": "export default 2;\n" }, "merge bind-adapter-old-2");
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc run calibrate --target old");
  assert.equal(r.next.kind, "owed");
  assert.match(r.next.why, /^1 unbound row to check again now that its adapter has changed for target old owed by calibrate$/);
});

const spentOn = (target, id = "R-1.1") => ["a1", "a2"].map((adapter) => ({ id, target, why: "unbound: a-page.stop — gone", found: "unbound", adapter,
  closed: { outcome: "met", why: `tests/adapters/${target} has changed since this was found`, by: "runner:calibrate", at: "2026-01-02T00:00:00.000Z" } }));

// Past the limit, the oracle's unbound row goes to the reviewer's triage, where a verdict closes
// or re-queues it (`docs/decisions/0068`). The suite would only say the same again, so the
// calibration that opens the triage runs none.
test("an unbound row bind-adapter has had its sends for is taken to the reviewer's triage by calibrate --skip-suite", (t) => {
  const d = project(t, { extra: TARGETS, policy: ["loops: { rebind: 2 }"] });
  specDone(d);
  commit(d, { "tests/adapters/rebind.yaml": stringifyYaml({ rebind: spentOn("old") }) });
  calibratedWithUnbound(d, [unboundRow("R-1.1", "alpha"), { id: "R-2.1", result: "pass" }]);
  const r = whatNext(d);
  assert.ok(!r.ready.some((c) => c.stage === "bind-adapter"), "not sent a third time");
  assert.equal(r.next.command, "sdlc run calibrate --target old --skip-suite");
  assert.equal(r.next.kind, "sequence");
  assert.match(r.next.why, /1 unbound row bind-adapter was sent 2 times \(policy\.loops\.rebind\) goes to the reviewer's triage: R-1\.1/);
  assert.deepEqual(r.waiting, [], "nothing waits on a person with no route");
  assert.doesNotMatch(formatNext(r), /waiting on a person/);
  assert.doesNotMatch(formatNextShort(r), /unbound binding/);
  assert.equal(matchesNext(r, "calibrate", { target: "old" }), true);
});

test("while the reviewer's triage is open, a spent unbound row is that proposal's question and nothing else's", (t) => {
  const d = project(t, { extra: TARGETS, policy: ["loops: { rebind: 2 }"] });
  specDone(d);
  commit(d, { "tests/adapters/rebind.yaml": stringifyYaml({ rebind: spentOn("old") }) });
  calibratedWithUnbound(d, [unboundRow("R-1.1", "alpha"), { id: "R-2.1", result: "pass" }]);
  proposal(d, "calibrate-triage-old-1", "G3");
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc rule calibrate-triage-old-1 --by agent:owner");
  assert.ok(!r.ready.some((c) => c.stage === "calibrate" || c.stage === "bind-adapter"));
  assert.deepEqual(r.waiting, []);
});

test("a spent unbound row on a target other than the oracle still waits on a ruler", (t) => {
  const d = project(t, { extra: TARGETS, policy: ["loops: { rebind: 2 }"] });
  specDone(d);
  commit(d, { "tests/adapters/rebind.yaml": stringifyYaml({ rebind: spentOn("new") }) });
  calibratedWithUnbound(d, [{ id: "R-1.1", result: "pass" }, { id: "R-2.1", result: "pass" }]);
  commit(d, { "tests/results/new/latest.json": JSON.stringify({ rows: [unboundRow("R-1.1", "alpha"), { id: "R-2.1", result: "pass" }] }) }, "stage(calibrate): calibrate against new");
  const r = whatNext(d);
  const w = r.waiting.find((x) => x.kind === "unbound");
  assert.equal(w.on, "a ruler");
  assert.equal(w.name, "unbound bindings (new)");
  assert.match(w.why, /^1 binding bind-adapter was sent 2 times \(policy\.loops\.rebind\) and still reports unbound on new: R-1\.1/);
  assert.match(w.command, /no calibration verb closes an unbound row on new/);
  assert.match(formatNextShort(r), /1 unbound binding waiting on a ruler/);
});

// A test signing in as a persona the approved contract marks unavailable on the target can never
// run there, so no binding run is sent it; calibration closes the row.
test("an unbound row whose persona the contract marks unavailable is sent to no binding run", (t) => {
  const d = project(t, { extra: TARGETS });
  specDone(d);
  commit(d, { "spec/contract/personas.yaml": stringifyYaml({ personas: [
    { id: "second-staff", can: ["approve"], sign_in: { "session-route": { unavailable: "the target has one staff account" } } },
  ] }) });
  const needsPersona = unboundRow("R-1.1", "alpha", { tests: [{ title: "t", status: "failed", error: "Error: unbound: signIn.second-staff — the target has one staff account" }] });
  calibratedWithUnbound(d, [needsPersona, { id: "R-2.1", result: "pass" }]);
  const r = whatNext(d);
  assert.deepEqual(r.owed, [], "owed to no binding run");
  assert.equal(r.next.command, "sdlc run calibrate --target old --skip-suite");
  assert.match(r.next.why, /1 unbound row needs a persona the approved contract marks unavailable on old: R-1\.1/);
  assert.deepEqual(r.waiting, []);
});

// An approved proposal merged into main the way a ruling merges one.
function merged(d, name, files, gate = "G3") {
  git(d, ["checkout", "-q", "-b", `proposal/${name}`]);
  commit(d, { [`.sdlc/proposals/${name}.md`]: `---\ngate: ${gate}\n---\n`, [`.sdlc/gates/${name}.yaml`]: gateText(gate, "approve"), ...files }, `propose(${gate}): ${name}`);
  git(d, ["checkout", "-q", "main"]);
  git(d, [...AS_PIPELINE, "merge", "-q", "--no-ff", "-m", `merge: ${name} approved at ${gate} by agent:owner`, `proposal/${name}`]);
}

// The oracle's suite, measured with every row passing: a dated result file and latest.json.
function measured(d, day) {
  const results = JSON.stringify({ target: "old", rows: [{ id: "R-1.1", result: "pass" }, { id: "R-2.1", result: "pass" }] });
  commit(d, { [`tests/results/old/${day}.json`]: results, "tests/results/old/latest.json": results }, "stage(calibrate): calibrate against old");
}

function calibratedProject(t, policy = []) {
  const d = project(t, { extra: TARGETS, policy });
  specDone(d);
  adaptersBound(d, { old: bindingsFor("old", FULL), fresh: bindingsFor("new", FULL) });
  approved(d, ["derive-tests-alpha", "derive-tests-beta"], "G3");
  measured(d, "2026-01-01");
  commit(d, { "tests/acceptance/redo.yaml": stringifyYaml({ redo: [{ id: "R-2.1", version: 1, why: "w" }] }) });
  return d;
}

// Calibration is the only stage that runs the tests against the oracle, and nothing else in the
// sequence brings it back once its rows are closed. A project can ask for it every so many
// approved changes to what it measures (`docs/decisions/0070`).
test("a calibration falls due after policy.next.calibrate_after approved changes to what it measures", (t) => {
  const d = calibratedProject(t, ["next: { calibrate_after: 2 }"]);
  const other = "sdlc run derive-tests --domain beta --stale";
  assert.equal(whatNext(d).next.command, other);

  merged(d, "derive-tests-alpha-stale-1", { "tests/acceptance/alpha/R-1.1.spec.ts": "// criterion: @R-1.1 v1\n" });
  merged(d, "design-alpha", { "design/alpha/screen.md": "a screen\n" }, "G-DESIGN");
  assert.equal(whatNext(d).next.command, other, "one change to what it measures, and a design it does not measure");

  merged(d, "bind-adapter-old-2", { "tests/adapters/old/index.ts": "export default 2;\n" });
  let r = whatNext(d);
  assert.equal(r.next.command, "sdlc run calibrate --target old");
  assert.equal(r.next.kind, "calibration");
  assert.match(r.next.why, /^2 approved proposals changed what calibration measures on old since its suite last ran \(derive-tests-alpha-stale-1, bind-adapter-old-2\); policy\.next\.calibrate_after is 2$/);
  assert.match(r.next.rule, /^a calibration is due \(policy\.next\.calibrate_after: 2\), and goes before owed and sequence work/);
  assert.equal(r.ready.filter((c) => c.stage === "calibrate").length, 1);
  assert.equal(r.ready[1].command, other);
  assert.equal(matchesNext(r, "calibrate", { target: "old" }), true);

  // A calibration that runs no suite measures nothing, and leaves it due.
  commit(d, { "tests/results/old/latest.json": JSON.stringify({ target: "old", rows: [{ id: "R-1.1", result: "pass" }, { id: "R-2.1", result: "pass" }] }) }, "stage(calibrate): calibrate against old");
  assert.equal(whatNext(d).next.command, "sdlc run calibrate --target old");

  // A proposal an agent can rule still comes first.
  proposal(d, "derive-tests-beta-stale-1", "G3");
  r = whatNext(d);
  assert.equal(r.next.command, "sdlc rule derive-tests-beta-stale-1 --by agent:owner");
  assert.equal(r.ready[1].command, "sdlc run calibrate --target old");

  // Measured again, and the count starts over.
  measured(d, "2026-01-02");
  assert.ok(!whatNext(d).ready.some((c) => c.stage === "calibrate"));
});

test("with policy.next.calibrate_after unset, or no calibration yet, nothing falls due", (t) => {
  const d = calibratedProject(t);
  for (const n of [1, 2, 3]) merged(d, `derive-tests-alpha-stale-${n}`, { [`tests/acceptance/alpha/R-1.${n}.spec.ts`]: "x\n" });
  assert.ok(!whatNext(d).ready.some((c) => c.stage === "calibrate"));

  const never = project(t, { extra: TARGETS, policy: ["next: { calibrate_after: 1 }"] });
  specDone(never);
  adaptersBound(never, { old: bindingsFor("old", FULL), fresh: bindingsFor("new", FULL) });
  merged(never, "derive-tests-alpha", { "tests/acceptance/alpha/R-1.1.spec.ts": "x\n" });
  assert.ok(!whatNext(never).ready.some((c) => c.kind === "calibration"), "the sequence brings the first calibration");
});

// Under `policy.calibrate.scope: changed` a calibration carries rows none of whose inputs changed
// (`docs/decisions/0072`). The Tests phase closes only on a run that measured every row, and
// `policy.calibrate.full_every` makes every n-th calibration full.
function scopedResults(d, rows, more = {}) {
  adaptersBound(d, { old: bindingsFor("old", FULL), fresh: bindingsFor("new", FULL) });
  approved(d, ["derive-tests-alpha", "derive-tests-beta"], "G3");
  commit(d, { "tests/results/old/latest.json": JSON.stringify({ target: "old", run: "2026-01-02", scope: "changed", full_run: "2026-01-01", since_full: 1, ...more, rows }) }, "stage(calibrate): calibrate against old");
}

test("the Tests phase stays open while a row is carried, and next names a full calibration to close it", (t) => {
  const d = project(t, { extra: TARGETS, policy: ["calibrate: { scope: changed }"] });
  specDone(d);
  scopedResults(d, [
    { id: "R-1.1", result: "pass", measured_in: "2026-01-02" },
    { id: "R-2.1", result: "fail", ruled: "defect-in-old", measured_in: "2026-01-01", carried: true },
  ]);
  const r = whatNext(d);
  assert.equal(r.phase.number, 2);
  assert.equal(r.next.command, "sdlc run calibrate --target old --full");
  assert.equal(r.next.kind, "sequence");
  assert.match(r.next.why, /every row passes or is ruled, but 1 row was carried from an earlier run \(2026-01-01\) rather than measured by the last one; the Tests phase closes only on a run that measures every row$/);
  assert.equal(matchesNext(r, "calibrate", { target: "old" }), false, "a scoped run is not the full run next names");
  assert.equal(matchesNext(r, "calibrate", { target: "old", full: true }), true);

  commit(d, { "tests/results/old/latest.json": JSON.stringify({ target: "old", run: "2026-01-03", scope: "full", full_run: "2026-01-03", since_full: 0, rows: [
    { id: "R-1.1", result: "pass", measured_in: "2026-01-03" }, { id: "R-2.1", result: "fail", ruled: "defect-in-old", measured_in: "2026-01-03" },
  ] }) }, "stage(calibrate): calibrate against old");
  assert.equal(whatNext(d).phase.number, 3, "a full run with every row closed ends the phase");
});

// A spec-wrong ruling is about the test written before the criterion was corrected
// (`docs/decisions/0073`): a row of the test derived for the criterion as it stands is a result
// nobody has ruled on, whatever mark an earlier calibration left on it.
test("a failing row whose spec-wrong ruling was about an earlier version of its test does not close the Tests phase", (t) => {
  const d = project(t, { extra: TARGETS });
  specDone(d);
  const full = (rows) => commit(d, { "tests/results/old/latest.json": JSON.stringify({ target: "old", run: "2026-01-03", scope: "full", full_run: "2026-01-03", since_full: 0, rows }) }, "stage(calibrate): calibrate against old");
  adaptersBound(d, { old: bindingsFor("old", FULL), fresh: bindingsFor("new", FULL) });
  approved(d, ["derive-tests-alpha", "derive-tests-beta"], "G3");
  commit(d, { "spec/criteria-index.json": index([["R-1.1", "alpha"], ["R-2.1", "beta", 2]]) }, "stage(calibrate): apply rulings");
  full([{ id: "R-1.1", version: 1, result: "pass" }, { id: "R-2.1", version: 1, result: "stale", ruled: "spec-wrong" }]);
  assert.equal(whatNext(d).phase.number, 3, "the ruling stands on the test written before the correction");
  full([{ id: "R-1.1", version: 1, result: "pass" }, { id: "R-2.1", version: 2, result: "fail", ruled: "spec-wrong" }]);
  assert.equal(whatNext(d).phase.number, 2, "a failure of the test derived for v2 is nobody's ruling yet");
});

test("policy.calibrate.full_every makes next name a full calibration when one is due, and --full is never a deviation", (t) => {
  const d = project(t, { extra: TARGETS, policy: ["calibrate: { scope: changed, full_every: 2 }"] });
  specDone(d);
  scopedResults(d, [{ id: "R-1.1", result: "pass", measured_in: "2026-01-01" }, { id: "R-2.1", result: "fail", measured_in: "2026-01-02" }], { since_full: 1 });
  let r = whatNext(d);
  assert.equal(r.next.command, "sdlc run calibrate --target old --full");
  assert.match(r.next.why, /; a full run is due: 1 scoped calibration since the last full run \(2026-01-01\); policy\.calibrate\.full_every is 2$/);

  commit(d, { "tests/results/old/latest.json": JSON.stringify({ target: "old", run: "2026-01-02", scope: "full", full_run: "2026-01-02", since_full: 0, rows: [
    { id: "R-1.1", result: "pass", measured_in: "2026-01-02" }, { id: "R-2.1", result: "fail", measured_in: "2026-01-02" },
  ] }) }, "stage(calibrate): calibrate against old");
  r = whatNext(d);
  assert.equal(r.next.command, "sdlc run calibrate --target old");
  assert.equal(matchesNext(r, "calibrate", { target: "old" }), true);
  assert.equal(matchesNext(r, "calibrate", { target: "old", full: true }), true, "measuring more than next asked for needs no reason");
});

// A missing test owed a run by calibration, for a criterion whose row needs a persona the approved
// contract marks unavailable, can never be answered by a run there (`docs/decisions/0068`), so it
// is handed to a ruler rather than offered to calibrate for ever.
test("a missing test owed a run on a row whose persona the contract marks unavailable waits on a ruler", (t) => {
  const d = project(t, { extra: TARGETS });
  specDone(d);
  commit(d, {
    "spec/contract/personas.yaml": stringifyYaml({ personas: [
      { id: "second-staff", can: ["approve"], sign_in: { "session-route": { unavailable: "the target has one staff account" } } },
    ] }),
    ".sdlc/owed.yaml": stringifyYaml({ owed: [{ kind: "missing-test", item: "R-1.1", id: "R-1.1", version: 1, domain: "alpha", stage: "calibrate", target: "old", why: "a test for v1 exists and has not run", by: "runner", at: "2026-01-01T00:00:00.000Z" }] }),
  });
  const needsPersona = unboundRow("R-1.1", "alpha", { ruled: "persona-unavailable", tests: [{ title: "t", status: "failed", error: "Error: unbound: signIn.second-staff — the target has one staff account" }] });
  calibratedWithUnbound(d, [needsPersona, { id: "R-2.1", result: "pass" }]);
  const r = whatNext(d);
  assert.ok(!r.ready.some((c) => c.stage === "calibrate"), r.ready.map((c) => c.command).join("\n"));
  const w = r.waiting.find((x) => x.kind === "missing-test");
  assert.equal(w.on, "a ruler");
  assert.equal(w.name, "missing tests (calibrate)");
  assert.match(w.why, /^1 missing test owed a run by calibrate on old, for a row needing a persona the approved contract marks unavailable there: R-1\.1; no run on old can pass or fail it$/);
  assert.match(w.command, /^condition-withdrawn missing-test\/<id>: <why> on any ruling/);
});

test("the first calibration after policy.calibrate.scope: changed is full, and next says why", (t) => {
  const d = project(t, { extra: TARGETS, policy: ["calibrate: { scope: changed }"] });
  specDone(d);
  adaptersBound(d, { old: bindingsFor("old", FULL), fresh: bindingsFor("new", FULL) });
  approved(d, ["derive-tests-alpha", "derive-tests-beta"], "G3");
  commit(d, { "tests/results/old/latest.json": JSON.stringify({ target: "old", rows: [{ id: "R-1.1", file: "tests/acceptance/alpha/R-1.1.spec.ts", result: "fail" }, { id: "R-2.1", result: "pass" }] }) });
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc run calibrate --target old --full");
  assert.match(r.next.why, /; a full run is due: no row on file records the inputs it ran with, so the first calibration under policy\.calibrate\.scope: changed measures every row$/);
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

// ── a build verify found what the builder is not answerable for ──────────────────────────

const NEW_TARGET = ["targets:", "  new: { base_url: \"http://localhost:8080\", identity: sandbox-idp }"];

// A build proposal for slice 1 whose verify result, on its own branch, is `result`.
function verifiedBuild(d, result) {
  approved(d, ["intent-thing"], "G0");
  approved(d, ["plan"], "G2");
  commit(d, { "plan/tasks.md": "### Slice 1 · First\n- criteria: R-1.1, R-1.2\n", "app/index.ts": "export {};\n", "tests/adapters/new/index.ts": "export default 1;\n" });
  git(d, ["checkout", "-q", "-b", "proposal/build-slice-1"]);
  commit(d, { ".sdlc/proposals/build-slice-1.md": "---\ngate: G3\nquestion: \"q\"\nrecommendation: \"r\"\n---\n", "app/index.ts": "export const a = 1;\n" }, "propose(G3): build-slice-1");
  const appTree = git(d, ["rev-parse", "HEAD:app"]);
  commit(d, { "tests/results/new/slice-1.json": JSON.stringify({ slice: 1, proposal: "build-slice-1", app_tree: appTree, rows: [], ...result }) }, "verify(slice 1)");
  git(d, ["checkout", "-q", "main"]);
  return git(d, ["rev-parse", "main:tests/adapters/new"]);
}

test("a build whose verify found only unbound rows owed to the binding is not ruled; the binding is offered", (t) => {
  const d = project(t, { profile: "feature", extra: NEW_TARGET });
  const adapter = verifiedBuild(d, { verdict: "unbound", unbound: [{ id: "R-1.2", reason: "signIn.applicant — no link" }] });
  commit(d, { "tests/adapters/rebind.yaml": stringifyYaml({ rebind: [{ id: "R-1.2", target: "new", why: "unbound: signIn.applicant — no link", found: "unbound", adapter, slice: 1, by: "runner:verify", at: "2026-01-01T00:00:00.000Z" }] }) }, "run(verify)");
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc run bind-adapter --target new");
  assert.ok(!r.ready.some((c) => c.command.startsWith("sdlc rule build-slice-1")), "the build is not ruled for the adapter's gap");
  assert.match(r.next.why, /sandbox up --target new --from proposal\/build-slice-1/, "the binding needs the application the proposal carries");
});

test("once a binding is ruled onto main, the slice it was owed for is verified again", (t) => {
  const d = project(t, { profile: "feature", extra: NEW_TARGET });
  const adapter = verifiedBuild(d, { verdict: "unbound", unbound: [{ id: "R-1.2", reason: "signIn.applicant — no link" }] });
  commit(d, { "tests/adapters/rebind.yaml": stringifyYaml({ rebind: [{ id: "R-1.2", target: "new", why: "unbound: signIn.applicant — no link", found: "unbound", adapter, slice: 1, by: "runner:verify", at: "2026-01-01T00:00:00.000Z" }] }) }, "run(verify)");
  commit(d, { "tests/adapters/new/index.ts": "export default 2;\n" }, "merge bind-adapter-new");
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc run verify --slice 1");
  assert.match(r.next.why, /^1 unbound row to check again now that its adapter has changed for slice 1 owed by verify$/);
  assert.ok(!r.ready.some((c) => c.stage === "calibrate"), "the new target's rows are verify's, not a calibration's");
  assert.ok(!r.ready.some((c) => c.command.startsWith("sdlc rule build-slice-1")));
});

test("a build whose verify could not test a criterion in this environment waits on a person, then is verified again", (t) => {
  const d = project(t, { profile: "feature", extra: NEW_TARGET });
  verifiedBuild(d, { verdict: "environment", environment: [{ id: "R-1.1", reason: "its test reads a mail catcher, and targets.new.mail_api names none for this target to hand it" }] });
  const r = whatNext(d);
  assert.ok(!r.ready.some((c) => c.command.startsWith("sdlc rule build-slice-1")), "not ruled for a gap the builder cannot close");
  const w = r.waiting.find((x) => x.name === "build-slice-1");
  assert.equal(w.on, "lead", "G3's escalation target");
  assert.match(w.why, /could not be tested in this environment: R-1\.1/);
  assert.match(w.command, /targets\.new\.mail_api/);

  commit(d, { ".sdlc/config.yaml": config({ profile: "feature", extra: ["targets:", "  new: { base_url: \"http://localhost:8080\", identity: sandbox-idp, mail_api: \"http://localhost:8025\" }"] }) }, "policy: mail catcher");
  const again = whatNext(d);
  assert.equal(again.next.command, "sdlc run verify --slice 1");
});

// ── an adapter is ruled before it is measured with ────────────────────────────────────────

// A verify runs the slice's tests against the new target with the adapter on `main`, and a
// calibration runs the suite against its target with that target's adapter. An open proposal for
// that adapter is ruled first, so neither measures with the adapter it is about to replace
// (`docs/decisions/0079`).

// The tip of `branch` moved later than anything else, so the oldest-first order would put the
// proposal on it after every other.
function newest(d, branch) {
  git(d, ["checkout", "-q", branch]);
  execFileSync("git", [...AS_PIPELINE, "commit", "-q", "--allow-empty", "-m", "later"], {
    cwd: d, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: "2099-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2099-01-01T00:00:00Z" },
  });
  git(d, ["checkout", "-q", "main"]);
}

const TWO_TARGETS = ["targets:", "  new: { base_url: \"http://localhost:8080\", identity: sandbox-idp }", "  other: { base_url: \"http://localhost:8081\", identity: sandbox-idp }"];

// A build proposal for slice 1 with no verify result, and an open proposal for `target`'s adapter
// whose branch is newer than the build's.
function buildAndAdapter(d, target) {
  approved(d, ["intent-thing"], "G0");
  approved(d, ["plan"], "G2");
  commit(d, { "plan/tasks.md": "### Slice 1 · First\n- criteria: R-1.1\n", "app/index.ts": "export {};\n" });
  proposal(d, "build-slice-1", "G3", { files: { "app/index.ts": "export const a = 1;\n" } });
  proposal(d, `bind-adapter-${target}-2`, "G-BIND", { files: { [`tests/adapters/${target}/index.ts`]: "export default 2;\n" } });
  newest(d, `proposal/bind-adapter-${target}-2`);
}

test("an open proposal for the new target's adapter is ruled before a build is verified with it", (t) => {
  const d = project(t, { profile: "feature", extra: TWO_TARGETS, gates: { "G-BIND": { holder: "agent:reviewer", escalate_to: "lead" } } });
  buildAndAdapter(d, "new");
  const r = whatNext(d);
  assert.deepEqual(r.ready.map((c) => c.command), ["sdlc rule bind-adapter-new-2 --by agent:reviewer", "sdlc run verify --slice 1"]);
  assert.match(r.next.rule, /^an open proposal for target new's adapter is ruled before sdlc run verify --slice 1, which measures with that adapter, whatever policy\.next\.order puts first \(docs\/decisions\/0079\)$/);
  assert.match(r.ready[1].rule, /oldest proposal first/, "the verify keeps its own rule");
  assert.deepEqual(r.held, []);
});

test("an adapter proposal a person holds holds the verify that would measure with it, and only on its target", (t) => {
  const d = project(t, { profile: "feature", extra: TWO_TARGETS, gates: { "G-BIND": { holder: "owner" } } });
  buildAndAdapter(d, "new");
  const r = whatNext(d);
  assert.equal(r.state, "waiting");
  assert.equal(r.next, null);
  assert.ok(!r.ready.some((c) => c.stage === "verify"), "not verified with the adapter the proposal replaces");
  const h = r.held.find((c) => c.stage === "verify");
  assert.equal(h.command, "sdlc run verify --slice 1");
  assert.match(h.why, /; held until bind-adapter-new-2, a proposal for target new's adapter open at G-BIND and waiting on owner, is ruled, since this run measures with that adapter$/);
  assert.ok(r.waiting.some((w) => w.name === "bind-adapter-new-2" && w.on === "owner"));
  assert.match(formatNext(r), /^held:\n {2}sdlc run verify --slice 1 — /m);

  const other = project(t, { profile: "feature", extra: TWO_TARGETS, gates: { "G-BIND": { holder: "owner" } } });
  buildAndAdapter(other, "other");
  const o = whatNext(other);
  assert.equal(o.next.command, "sdlc run verify --slice 1", "another target's adapter changes nothing verify measures with");
  assert.deepEqual(o.held, []);
});

// Phase 2 with the oracle's adapter bound and every domain's tests approved, calibration not yet
// run, and a second proposal for the oracle's adapter open.
function calibrationAndAdapter(t, opts) {
  const d = project(t, { extra: TARGETS, ...opts });
  specDone(d);
  adaptersBound(d, { old: bindingsFor("old", FULL), fresh: bindingsFor("new", FULL) });
  approved(d, ["derive-tests-alpha", "derive-tests-beta"], "G3");
  proposal(d, "bind-adapter-old-2", "G-BIND", { files: { "tests/adapters/old/index.ts": "export default 2;\n" } });
  return d;
}

test("an open proposal for the oracle's adapter is ruled before a calibration, whatever policy.next.order says", (t) => {
  const d = calibrationAndAdapter(t, { policy: ["next: { order: [sequence, owed, proposals] }"], gates: { "G-BIND": { holder: "agent:reviewer", escalate_to: "lead" } } });
  const r = whatNext(d);
  assert.deepEqual(r.ready.map((c) => c.command), ["sdlc rule bind-adapter-old-2 --by agent:reviewer", "sdlc run calibrate --target old"]);
  assert.match(r.next.rule, /^an open proposal for target old's adapter is ruled before sdlc run calibrate --target old, which measures with that adapter/);
});

test("an adapter proposal a person holds holds the calibration of its target", (t) => {
  const d = calibrationAndAdapter(t, { gates: { "G-BIND": { holder: "owner" } } });
  const r = whatNext(d);
  assert.equal(r.state, "waiting");
  assert.ok(!r.ready.some((c) => c.stage === "calibrate"));
  assert.match(r.held.find((c) => c.stage === "calibrate").why, /held until bind-adapter-old-2, a proposal for target old's adapter open at G-BIND and waiting on owner, is ruled/);
});

// ── a returned adapter is revised before it is measured with ─────────────────────────────

// A returned proposal for a target's adapter is revised before a verify or calibration that
// measures with that adapter, and before a build whose verify will (`docs/decisions/0080`).

// A build proposal for slice 1 with no verify result, and a proposal for `target`'s adapter
// returned at G3 by the reviewer.
function buildAndReturnedAdapter(d, target) {
  approved(d, ["intent-thing"], "G0");
  approved(d, ["plan"], "G2");
  commit(d, { "plan/tasks.md": "### Slice 1 · First\n- criteria: R-1.1\n", "app/index.ts": "export {};\n" });
  proposal(d, "build-slice-1", "G3", { files: { "app/index.ts": "export const a = 1;\n" } });
  proposal(d, `bind-adapter-${target}-2`, "G3", { files: { [`tests/adapters/${target}/index.ts`]: "export default 2;\n" }, ruling: { verdict: "return", extra: { by: "agent:reviewer" } } });
}

test("a returned proposal for the new target's adapter is revised before a build is verified with it", (t) => {
  const d = project(t, { profile: "feature", extra: TWO_TARGETS });
  buildAndReturnedAdapter(d, "new");
  const r = whatNext(d);
  assert.deepEqual(r.ready.map((c) => c.command), ["sdlc run bind-adapter --target new --revise", "sdlc run verify --slice 1"]);
  assert.match(r.next.rule, /^a returned proposal for target new's adapter is revised before sdlc run verify --slice 1, which measures with that adapter, whatever policy\.next\.order puts first \(docs\/decisions\/0080\)$/);
  assert.match(r.next.why, /bind-adapter-new-2 was returned at G3 by agent:reviewer/);
  assert.deepEqual(r.held, []);

  const other = project(t, { profile: "feature", extra: TWO_TARGETS });
  buildAndReturnedAdapter(other, "other");
  const o = whatNext(other);
  assert.equal(o.next.command, "sdlc run verify --slice 1", "another target's adapter changes nothing verify measures with");
});

test("a returned adapter proposal is revised before a build, whose verify will measure with it", (t) => {
  const d = project(t, { profile: "feature", extra: TWO_TARGETS, policy: ["next: { order: [sequence, owed, proposals] }"] });
  approved(d, ["intent-thing"], "G0");
  approved(d, ["plan"], "G2");
  commit(d, { "plan/tasks.md": "### Slice 1 · First\n- criteria: R-1.1\n", "app/index.ts": "export {};\n" });
  proposal(d, "bind-adapter-new-2", "G3", { files: { "tests/adapters/new/index.ts": "export default 2;\n" }, ruling: { verdict: "return", extra: { by: "agent:reviewer" } } });
  const r = whatNext(d);
  assert.deepEqual(r.ready.map((c) => c.command), ["sdlc run bind-adapter --target new --revise", "sdlc run build --slice 1"]);
  assert.match(r.next.rule, /^a returned proposal for target new's adapter is revised before sdlc run build --slice 1, whose verify will measure with that adapter \(docs\/decisions\/0080\)$/);
});

test("a returned proposal for the oracle's adapter is revised before a calibration, whatever policy.next.order says", (t) => {
  const d = project(t, { extra: TARGETS, policy: ["next: { order: [sequence, owed, proposals] }"] });
  specDone(d);
  adaptersBound(d, { old: bindingsFor("old", FULL), fresh: bindingsFor("new", FULL) });
  approved(d, ["derive-tests-alpha", "derive-tests-beta"], "G3");
  proposal(d, "bind-adapter-old-2", "G3", { files: { "tests/adapters/old/index.ts": "export default 2;\n" }, ruling: { verdict: "return", extra: { by: "agent:reviewer" } } });
  const r = whatNext(d);
  assert.deepEqual(r.ready.slice(0, 2).map((c) => c.command), ["sdlc run bind-adapter --target old --revise", "sdlc run calibrate --target old"]);
  assert.match(r.next.rule, /^a returned proposal for target old's adapter is revised before sdlc run calibrate --target old, which measures with that adapter/);
});

test("with the build returned by verify, the binding it is owed starts the sandbox from the returned build", (t) => {
  const d = project(t, { profile: "feature", extra: NEW_TARGET });
  const adapter = verifiedBuild(d, { verdict: "return", unbound: [{ id: "R-1.2", reason: "signIn.applicant — no link" }] });
  git(d, ["checkout", "-q", "proposal/build-slice-1"]);
  commit(d, { ".sdlc/gates/build-slice-1.yaml": gateText("G3", "return", { by: "runner:verify" }) }, "rule(G3): build-slice-1");
  git(d, ["checkout", "-q", "main"]);
  commit(d, { "tests/adapters/rebind.yaml": stringifyYaml({ rebind: [{ id: "R-1.2", target: "new", why: "unbound: signIn.applicant — no link", found: "unbound", adapter, slice: 1, by: "runner:verify", at: "2026-01-01T00:00:00.000Z" }] }) }, "run(verify)");
  const r = whatNext(d);
  assert.equal(r.next.command, "sdlc run bind-adapter --target new");
  assert.match(r.next.why, /sandbox up --target new --from proposal\/build-slice-1 first/);

  // build --revise's pre-check records the return on main and keeps the branch as returned/<name>.
  git(d, ["branch", "-m", "proposal/build-slice-1", "returned/build-slice-1"]);
  commit(d, { ".sdlc/gates/build-slice-1.yaml": gateText("G3", "return", { by: "runner:verify" }) }, "record(G3): build-slice-1 returned");
  const after = whatNext(d);
  assert.equal(after.next.command, "sdlc run bind-adapter --target new");
  assert.match(after.next.why, /sandbox up --target new --from returned\/build-slice-1 first/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { drive, classifyStep, targetTrouble, DRIVE_EXIT } from "../src/runner/drive.mjs";
import { AUTH_ADVICE } from "../src/runner/executor.mjs";

// A `next` answer naming one command, the shape `whatNext` returns.
function runItem(stage, args = {}, why = `${stage} is next`) {
  const flags = Object.entries(args).map(([k, v]) => (v === true ? `--${k}` : `--${k} ${v}`)).join(" ");
  return { state: "run", next: { kind: "sequence", stage, args, command: `sdlc run ${stage}${flags ? ` ${flags}` : ""}`, why, rule: "r" }, ready: [], waiting: [], held: [] };
}
function ruleItem(name, by, why = `${name} is open`) {
  return { state: "run", next: { kind: "proposals", stage: "rule", name, command: `sdlc rule ${name} --by ${by}`, why, rule: "r" }, ready: [], waiting: [], held: [] };
}
const IDLE = { state: "idle", next: null, ready: [], waiting: [], held: [], complete: true };
const WAITING = { state: "waiting", next: null, ready: [], held: [],
  waiting: [{ on: "product-owner", name: "intent-1", why: "open at G1, held by product-owner, a seat a person holds", command: "sdlc rule intent-1 approve|return --by product-owner" }] };

// A fake world: `answers` is what `next` says on each read (the last one repeats), `steps` is
// what each execution returns in order (the last one repeats). Everything drive does is
// written down so a test can assert on it.
function world({ answers, steps = [{ ok: true }], oracle = [], marks = null, tree = null } = {}) {
  const calls = { next: 0, executed: [], oracle: [], steps: [], stops: [], recoveries: [], beats: [], printed: [] };
  let s = 0;
  let o = 0;
  const deps = {
    readNext: () => { const a = answers[Math.min(calls.next, answers.length - 1)]; calls.next++; if (a instanceof Error) throw a; return a; },
    tree: () => (tree ? tree(calls) : { clean: true, dirty: [], branch: "main" }),
    execute: async (_dir, item) => { calls.executed.push(item.command); return steps[Math.min(s++, steps.length - 1)]; },
    oracle: async (_dir, sub) => { calls.oracle.push(sub); return oracle[Math.min(o++, oracle.length - 1)] ?? { ok: true, output: [] }; },
    mark: (_dir, item) => (marks ? marks(calls, item) : { n: calls.executed.length, why: item.why }),
    record: {
      step: (_dir, line) => calls.steps.push(line),
      recovery: (_dir, line) => calls.recoveries.push(line),
      stop: (_dir, line) => calls.stops.push(line),
    },
    heartbeat: (_dir, beat) => calls.beats.push(beat),
    print: (line) => calls.printed.push(line),
    runningElsewhere: () => null,
  };
  return { deps, calls };
}

test("stops with 0 when next says nothing is left, and records why", async () => {
  const { deps, calls } = world({ answers: [IDLE] });
  const r = await drive("/p", { deps });
  assert.equal(r.code, DRIVE_EXIT.idle);
  assert.equal(r.code, 0);
  assert.deepEqual(calls.executed, []);
  assert.equal(calls.stops.length, 1);
  assert.match(calls.stops[0], /nothing left/);
});

test("stops with 3 when next says nothing can run until a person acts, and names who", async () => {
  const { deps, calls } = world({ answers: [WAITING] });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 3);
  assert.deepEqual(calls.executed, []);
  assert.match(calls.stops[0], /waiting on a person/);
  assert.match(calls.stops[0], /product-owner: intent-1/);
  assert.ok(calls.printed.some((l) => /sdlc rule intent-1 approve\|return --by product-owner/.test(l)), "the command the person types is printed");
});

test("never runs a person's ruling: a rule command without an agent holder stops the loop with 3", async () => {
  const { deps, calls } = world({ answers: [ruleItem("contract-v2", "tech-lead")] });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 3);
  assert.deepEqual(calls.executed, []);
  assert.match(calls.stops[0], /person's ruling/);
  assert.match(calls.stops[0], /tech-lead/);
});

test("runs what next names, a stage and then an agent's ruling, until nothing is left", async () => {
  const { deps, calls } = world({ answers: [runItem("intent"), ruleItem("intent-1", "agent:product-owner"), IDLE] });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 0);
  assert.deepEqual(calls.executed, ["sdlc run intent", "sdlc rule intent-1 --by agent:product-owner"]);
  assert.equal(calls.steps.length, 2);
  assert.match(calls.steps[0], /step 1: `sdlc run intent` — intent is next/);
  assert.equal(r.steps, 2);
});

test("a step that fails with no known recovery stops with 1 and prints the tail of its output", async () => {
  const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const { deps, calls } = world({ answers: [runItem("contract")], steps: [{ ok: false, messages: ["post-checks failed"], output }] });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 1);
  assert.deepEqual(calls.executed, ["sdlc run contract"]);
  assert.deepEqual(calls.oracle, []);
  assert.match(calls.stops[0], /failed/);
  const printed = calls.printed.join("\n");
  assert.match(printed, /line 40/);
  assert.doesNotMatch(printed, /line 1\n/, "only the tail is printed");
});

test("a step that recorded its outcome and did not pass is not a failure: the loop reads next again", async () => {
  const { deps, calls } = world({
    answers: [runItem("verify", { slice: 1 }), runItem("build", { slice: 1, revise: true }), IDLE],
    steps: [{ ok: false, notPassed: "returned: 2 criteria failed" }, { ok: true }],
  });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 0);
  assert.equal(calls.executed.length, 2);
});

test("an expired sign-in stops with 5 and is never retried", async () => {
  const text = `the stage was not started: a one-turn check could not authenticate, and the stage would have spent its whole budget to fail the same way.\n\nInvalid API key\n\n${AUTH_ADVICE}`;
  const { deps, calls } = world({ answers: [runItem("calibrate", { target: "old" })], steps: [{ ok: false, messages: [text] }] });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 5);
  assert.deepEqual(calls.executed, ["sdlc run calibrate --target old"]);
  assert.deepEqual(calls.oracle, []);
  assert.match(calls.stops[0], /sign-in/);
});

test("a target that is not up is brought up and the step run once more", async () => {
  const { deps, calls } = world({
    answers: [runItem("bind-adapter", { target: "old" }), IDLE],
    steps: [{ ok: false, messages: ["bind-adapter: the old target is not up; run sdlc oracle up first"] }, { ok: true }],
  });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 0);
  assert.deepEqual(calls.oracle, ["up"]);
  assert.deepEqual(calls.executed, ["sdlc run bind-adapter --target old", "sdlc run bind-adapter --target old"]);
  assert.equal(calls.recoveries.length, 1);
  assert.match(calls.recoveries[0], /not up/);
  assert.match(calls.recoveries[0], /oracle up/);
});

test("an oracle up that fails or runs past its limit is taken down and brought up once more", async () => {
  const { deps, calls } = world({
    answers: [runItem("bind-adapter", { target: "old" }), IDLE],
    steps: [{ ok: false, messages: ["bind-adapter: the old target is not up; run sdlc oracle up first"] }, { ok: true }],
    oracle: [{ ok: false, output: ["docker compose run --rm migrate timed out after 30 minutes"] }, { ok: true }, { ok: true }],
  });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 0);
  assert.deepEqual(calls.oracle, ["up", "down", "up"]);
  assert.equal(calls.executed.length, 2);
  assert.match(calls.recoveries.join("\n"), /down/);
});

test("an oracle that cannot be brought up on the second attempt stops with 1, without running the step again", async () => {
  const { deps, calls } = world({
    answers: [runItem("bind-adapter", { target: "old" })],
    steps: [{ ok: false, messages: ["bind-adapter: the old target is not up; run sdlc oracle up first"] }],
    oracle: [{ ok: false, output: ["timed out"] }, { ok: true }, { ok: false, output: ["timed out again"] }],
  });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 1);
  assert.deepEqual(calls.oracle, ["up", "down", "up"]);
  assert.equal(calls.executed.length, 1);
  assert.match(calls.stops[0], /oracle/);
  assert.match(calls.printed.join("\n"), /timed out again/);
});

test("a recovery is attempted once per step: the same failure after it stops with 1", async () => {
  const notUp = { ok: false, messages: ["bind-adapter: the old target is not up; run sdlc oracle up first"] };
  const { deps, calls } = world({ answers: [runItem("bind-adapter", { target: "old" })], steps: [notUp, notUp] });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 1);
  assert.deepEqual(calls.oracle, ["up"]);
  assert.equal(calls.executed.length, 2);
});

test("an unusable target is restarted: taken down before it is brought up", async () => {
  const { deps, calls } = world({
    answers: [runItem("calibrate", { target: "old" }), IDLE],
    steps: [{ ok: false, messages: ["calibrate old: halted, environment fault — the target could not be reset or reached for 5 of 5 row(s)"] }, { ok: true }],
  });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 0);
  assert.deepEqual(calls.oracle, ["down", "up"]);
});

test("no progress: the same command named again with nothing it could change changed stops with 6", async () => {
  const same = runItem("calibrate", { target: "old" }, "phase 2 Tests is not complete");
  const { deps, calls } = world({ answers: [same, same, same], marks: () => ({ fixed: true }) });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 6);
  assert.deepEqual(calls.executed, ["sdlc run calibrate --target old"]);
  assert.match(calls.stops[0], /no progress/);
  assert.match(calls.stops[0], /sdlc run calibrate --target old/);
});

test("the same command named again after the record moved is run again", async () => {
  const same = runItem("derive-tests", { domain: "a", stale: true });
  const { deps, calls } = world({ answers: [same, same, IDLE] });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 0);
  assert.equal(calls.executed.length, 2);
});

test("no progress is judged against the last run of the same command, across other steps between", async () => {
  const a = runItem("contract");
  const b = ruleItem("contract-v1", "agent:tech-lead");
  // The mark moves only when `b` runs and never when `a` does, so the second `a` sees a moved
  // record and the third does not.
  const { deps, calls } = world({
    answers: [a, b, a, a],
    marks: (c) => ({ moved: c.executed.filter((x) => x.startsWith("sdlc rule")).length }),
  });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 6);
  assert.deepEqual(calls.executed, ["sdlc run contract", "sdlc rule contract-v1 --by agent:tech-lead", "sdlc run contract"]);
});

test("stops with 7 at the step limit", async () => {
  let n = 0;
  const { deps, calls } = world({ answers: [IDLE] });
  deps.readNext = () => runItem("derive-tests", { domain: `d${n++}` });
  const r = await drive("/p", { deps, maxSteps: 3 });
  assert.equal(r.code, 7);
  assert.equal(calls.executed.length, 3);
  assert.match(calls.stops[0], /step limit/);
});

test("refuses to start with 2 on a dirty tree or off main, and runs nothing", async () => {
  for (const tree of [{ clean: false, dirty: [" M spec/x.md"], branch: "main" }, { clean: true, dirty: [], branch: "proposal/intent-1" }]) {
    const { deps, calls } = world({ answers: [runItem("intent")], tree: () => tree });
    const r = await drive("/p", { deps });
    assert.equal(r.code, DRIVE_EXIT.refused);
    assert.equal(r.code, 2);
    assert.deepEqual(calls.executed, []);
    assert.equal(calls.next, 0);
    assert.equal(calls.stops.length, 1);
    assert.match(calls.stops[0], tree.branch === "main" ? /uncommitted/ : /not on main/);
  }
});

test("a ruling that returns a proposal leaves its branch checked out; the loop goes back to main and carries on", async () => {
  let branch = "main";
  const { deps, calls } = world({
    answers: [runItem("bind-adapter", { target: "old" }), IDLE],
    tree: () => ({ clean: true, dirty: [], branch }),
  });
  const execute = deps.execute;
  deps.execute = async (dir, item) => { const r = await execute(dir, item); branch = "proposal/bind-adapter-old-50"; return r; };
  deps.checkoutMain = () => { calls.checkouts = (calls.checkouts ?? 0) + 1; branch = "main"; };
  const r = await drive("/p", { deps });
  assert.equal(r.code, 0);
  assert.equal(calls.checkouts, 1);
  assert.ok(calls.printed.some((l) => /back to main from proposal\/bind-adapter-old-50/.test(l)));
});

test("a step that leaves a branch other than a proposal checked out still stops with 1", async () => {
  const { deps, calls } = world({
    answers: [runItem("intent"), runItem("archaeology", { domain: "a" })],
    tree: (c) => ({ clean: true, dirty: [], branch: c.executed.length ? "feature/x" : "main" }),
  });
  deps.checkoutMain = () => { throw new Error("must not be called"); };
  const r = await drive("/p", { deps });
  assert.equal(r.code, 1);
  assert.match(calls.stops[0], /not on main \(on feature\/x\)/);
});

test("a step that leaves the tree dirty stops the loop with 1 before anything else runs", async () => {
  const { deps, calls } = world({
    answers: [runItem("intent"), runItem("archaeology", { domain: "a" })],
    tree: (c) => (c.executed.length ? { clean: false, dirty: [" M app/x"], branch: "main" } : { clean: true, dirty: [], branch: "main" }),
  });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 1);
  assert.deepEqual(calls.executed, ["sdlc run intent"]);
  assert.match(calls.stops[0], /uncommitted/);
});

test("refuses to start while another drive is running", async () => {
  const { deps, calls } = world({ answers: [runItem("intent")] });
  deps.runningElsewhere = () => ({ pid: 4242, started: "2026-09-29T10:00:00.000Z" });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 2);
  assert.deepEqual(calls.executed, []);
  assert.match(calls.printed.join("\n"), /already running/);
});

test("a dry run prints what it would run and why, and runs, records and beats nothing", async () => {
  const { deps, calls } = world({ answers: [runItem("intent", {}, "phase 1 Spec is not complete")] });
  const r = await drive("/p", { deps, dryRun: true });
  assert.equal(r.code, 0);
  assert.deepEqual(calls.executed, []);
  assert.deepEqual(calls.steps, []);
  assert.deepEqual(calls.stops, []);
  assert.deepEqual(calls.beats, []);
  const printed = calls.printed.join("\n");
  assert.match(printed, /would run: sdlc run intent/);
  assert.match(printed, /why: phase 1 Spec is not complete/);
});

test("a dry run on a person's ruling says it would stop there", async () => {
  const { deps, calls } = world({ answers: [ruleItem("intent-1", "product-owner")] });
  const r = await drive("/p", { deps, dryRun: true });
  assert.equal(r.code, 3);
  assert.deepEqual(calls.stops, []);
  assert.match(calls.printed.join("\n"), /would stop/);
});

test("a next that cannot be read stops with 1", async () => {
  const { deps, calls } = world({ answers: [new Error("next: this repository has no main branch to read the record from")] });
  const r = await drive("/p", { deps });
  assert.equal(r.code, 1);
  assert.match(calls.stops[0], /could not be read/);
});

test("the heartbeat names each step as it starts and the stop when it ends", async () => {
  const { deps, calls } = world({ answers: [runItem("intent"), IDLE] });
  await drive("/p", { deps });
  const running = calls.beats.find((b) => b.state === "running" && b.command);
  assert.equal(running.command, "sdlc run intent");
  assert.equal(running.step, 1);
  assert.ok(running.started);
  const last = calls.beats.at(-1);
  assert.equal(last.state, "stopped");
  assert.match(last.reason, /nothing left/);
});

test("classifyStep reads a run, an agent's ruling and a person's ruling out of what next names", () => {
  assert.deepEqual(classifyStep(runItem("calibrate", { target: "old", full: true }).next), { kind: "run", stage: "calibrate", args: { target: "old", full: true } });
  assert.deepEqual(classifyStep(ruleItem("x-1", "agent:reviewer").next), { kind: "agent-ruling", name: "x-1", persona: "reviewer" });
  assert.deepEqual(classifyStep(ruleItem("x-1", "tech-lead").next), { kind: "person-ruling", name: "x-1", by: "tech-lead" });
  assert.equal(classifyStep({ stage: "rule", command: "sdlc rule x-1" }).kind, "person-ruling");
});

test("targetTrouble tells a target that is not up from one that is up and unusable, and from anything else", () => {
  assert.equal(targetTrouble("bind-adapter: the old target is not up; run sdlc oracle up first"), "down");
  assert.equal(targetTrouble('oracle up failed for target "old"'), "down");
  assert.equal(targetTrouble("calibrate old: halted, environment fault — the target could not be reset or reached for 3 of 3 row(s)"), "unusable");
  assert.equal(targetTrouble("post-checks failed: app/PROBE.md is missing"), null);
  assert.equal(targetTrouble(""), null);
});

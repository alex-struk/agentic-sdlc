// `sdlc drive` — the loop over `next` (`docs/stages/drive.md`,
// `docs/decisions/0074-a-loop-that-stops-at-a-person.md`).
//
// Each turn reads what `next` names, runs it when it is an agent's or the runner's work, and
// reads `next` again. It stops, with the reason on the run record, at a person, at a failure
// it has no recovery for, at an expired sign-in, at a step that changed nothing, at its step
// limit, or when nothing is left. Everything it touches arrives through `deps`, so the loop
// is tested without a repository, an agent or a Docker daemon; `src/commands/drive.mjs`
// supplies the real ones.

import { createHash } from "node:crypto";
import { git } from "../lib/git.mjs";
import { authFailureReported } from "./executor.mjs";

// A script tells the stops apart without parsing the text. `next`'s own 0 (something can run)
// is not one of them: the loop runs it.
export const DRIVE_EXIT = Object.freeze({
  idle: 0,
  failed: 1,
  refused: 2,
  waiting: 3,
  signIn: 5,
  noProgress: 6,
  stepLimit: 7,
});

export const DEFAULT_MAX_STEPS = 50;

// How much of a failed step's output the stop prints: enough to hold a post-check's account
// or a stack trace's head, short enough that the stop line above it is still on screen.
const TAIL = 25;

// What `next` named, as something the loop can act on. A ruling is an agent's only when its
// `--by` is `agent:<persona>`; anything else is a person's seat, and the loop never types a
// verdict for a person.
export function classifyStep(item) {
  if (item.stage !== "rule") return { kind: "run", stage: item.stage, args: { ...(item.args ?? {}) } };
  const by = /--by\s+(\S+)/.exec(item.command ?? "")?.[1] ?? null;
  const name = item.name ?? /^sdlc rule\s+(\S+)/.exec(item.command ?? "")?.[1] ?? null;
  if (by?.startsWith("agent:")) return { kind: "agent-ruling", name, persona: by.slice("agent:".length) };
  return { kind: "person-ruling", name, by };
}

// Whether a failed step failed because the oracle was not there to be used, read from what
// the step said. `down`: nothing was started, or starting it failed — `oracle up` is the
// answer. `unusable`: it was started and could not be reset or reached, so it is taken down
// and started fresh; `oracle up` on its own finds the containers and changes nothing.
export function targetTrouble(text) {
  if (!text) return null;
  if (/could not be reset or reached/.test(text)) return "unusable";
  if (/run sdlc oracle up first|oracle up failed/.test(text)) return "down";
  return null;
}

// Whether a failed step failed because a rebuilt target's sandbox was not there to be used,
// read from what the step said. `start`: a binding found no sandbox running the application
// it binds against, and named the build proposal to start it from, which is where the loop
// starts it (`docs/decisions/0078`). `ports`: a sandbox could not start because this machine
// already holds a port it publishes — the oracle's, when the oracle is up, which is what
// taking it down answers. The branch is passed on as the step named it: an open build
// proposal's `proposal/<name>`, or the newest ruled one's `proposal/<name>` or
// `returned/<name>` when none is open (`docs/decisions/0080`).
export function sandboxTrouble(text) {
  if (!text) return null;
  const m = /sandbox is not up\b[^\n]*run sdlc sandbox up --target (\S+) --from ((?:proposal|returned)\/\S+) first/.exec(text);
  if (m) return { kind: "start", target: m[1], from: m[2] };
  if (/the sandbox was not started: \S+ publishes (?:a host port|\d+ host ports) this machine is already using/.test(text)) return { kind: "ports" };
  return null;
}

// What every run writes about itself: its run-record line, its journal entry, the state site
// regenerated from both, and a calibration's dated result files. A step that changed only
// these ran and moved nothing. A calibration's `latest.json` is left out with them and read
// by its counts instead, because it is rewritten with a new run id on every run.
const ACCOUNT_OF_RUNS = [".sdlc/runs/", ".sdlc/journal/", "site/", "tests/results/"];

function recordDigest(projectDir, rev) {
  const kept = git(["ls-tree", "-r", rev], projectDir).split("\n")
    .filter((l) => l && !ACCOUNT_OF_RUNS.some((p) => l.slice(l.indexOf("\t") + 1).startsWith(p)));
  return createHash("sha256").update(kept.join("\n")).digest("hex");
}

// A proposal or returned branch as what it holds of its own: every file it changed since the
// commit it shares with `main`, with the blob it has now. A step that merges `main` into a
// branch before it runs (verify does) carries onto the branch whatever the step before it
// wrote on `main`, and `main`'s digest has already counted that; digesting the branch's whole
// tree would see it a second time, one step late, and a step that changed nothing would read
// as progress (`docs/decisions/0085`).
function branchDigest(projectDir, branch) {
  let base = "";
  try { base = git(["merge-base", "main", branch], projectDir); } catch { return recordDigest(projectDir, branch); }
  const own = git(["diff", "--raw", "--no-renames", "--no-abbrev", base, branch], projectDir).split("\n")
    .filter((l) => l && !ACCOUNT_OF_RUNS.some((p) => l.slice(l.indexOf("\t") + 1).startsWith(p)))
    .map((l) => { const [meta, path] = l.split("\t"); return `${meta.split(" ")[3]}\t${path}`; });
  return createHash("sha256").update(own.join("\n")).digest("hex");
}

// Each target's latest calibration as counts of result and ruling (`fail ruled test-wrong: 2`).
function resultCounts(projectDir) {
  const files = git(["ls-tree", "-r", "--name-only", "main", "--", "tests/results"], projectDir).split("\n")
    .filter((f) => /^tests\/results\/[^/]+\/latest\.json$/.test(f));
  return Object.fromEntries(files.map((f) => {
    let rows = [];
    try { rows = JSON.parse(git(["show", `main:${f}`], projectDir)).rows ?? []; } catch { rows = []; }
    const counts = {};
    for (const r of rows) {
      const k = `${r?.result ?? "none"}${r?.ruled ? ` ruled ${r.ruled}` : ""}`;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return [f.split("/")[2], Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))];
  }));
}

// What the record holds that a step could change, for the command `item` names: `main`, and
// every proposal and returned branch as its own changes from `main`, each without the account
// of runs above; each target's calibration counts; and why `next` names the command. Two marks that are equal mean nothing
// a step could change has changed.
export function progressMark(projectDir, item) {
  const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads/proposal/", "refs/heads/returned/"], projectDir)
    .split("\n").filter(Boolean).sort();
  return {
    main: recordDigest(projectDir, "main"),
    branches: Object.fromEntries(branches.map((b) => [b, branchDigest(projectDir, b)])),
    results: resultCounts(projectDir),
    why: item.why,
  };
}

const textOf = (r) => [...(r?.messages ?? []), ...(r?.output ?? [])].join("\n");
const tailOf = (lines) => (lines ?? []).join("\n").split("\n").filter((l) => l.trim()).slice(-TAIL);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The loop. `deps` (every one required):
//   readNext(dir)            what `next` names, as `whatNext` returns it
//   tree(dir)                { clean, dirty: [lines], branch }
//   checkoutMain(dir)        puts the project back on main after a return left a proposal out
//   execute(dir, item)       runs one step: { ok, notPassed?, messages?, output? }
//   oracle(dir, "up"|"down") { ok, output }
//   oracleUp(dir)            whether `oracle up` has a copy of the oracle recorded as running
//   sandbox(dir, "up"|"down", { target, from })   { ok, output }
//   mark(dir, item)          what the record holds that a step could change (compared as JSON)
//   record.step / .recovery / .stop (dir, line)   run-record lines
//   heartbeat(dir, beat)     the operator's view of the loop
//   print(line)
//   runningElsewhere(dir)    another drive's heartbeat, when one is live
export async function drive(projectDir, { maxSteps = DEFAULT_MAX_STEPS, dryRun = false, deps }) {
  const { print } = deps;
  const started = new Date().toISOString();
  let steps = 0;
  let last = null;

  const beat = (b) => { if (!dryRun) deps.heartbeat(projectDir, { started, step: steps, ...b }); };
  const stop = (code, reason, detail = []) => {
    const line = `drive: stopped after ${steps} step${steps === 1 ? "" : "s"} — ${reason}`;
    print(line);
    for (const d of detail) print(`  ${d}`);
    if (!dryRun) {
      deps.record.stop(projectDir, line);
      beat({ state: "stopped", reason, stopped: new Date().toISOString(), ...(last ? { command: last } : {}) });
    }
    return { code, reason, steps };
  };
  const treeProblem = (t) => (!t.clean ? `uncommitted changes in the working tree (${t.dirty.slice(0, 5).map((l) => l.trim()).join(", ")}${t.dirty.length > 5 ? ", …" : ""})`
    : t.branch !== "main" ? `not on main (on ${t.branch})` : null);

  if (!dryRun) {
    const other = deps.runningElsewhere(projectDir);
    if (other) {
      print(`drive: refused — another drive is already running in this project (process ${other.pid}, since ${other.started}); sdlc drive --status shows what it is doing`);
      return { code: DRIVE_EXIT.refused, reason: "another drive is running", steps };
    }
  }
  const startTree = treeProblem(deps.tree(projectDir));
  if (startTree) {
    if (dryRun) { print(`drive: would refuse to start — ${startTree}`); return { code: DRIVE_EXIT.refused, reason: startTree, steps }; }
    return stop(DRIVE_EXIT.refused, `refused to start: ${startTree}`);
  }
  beat({ state: "running" });

  // What the record held just before each command last ran, by command.
  const before = new Map();

  for (;;) {
    let r;
    try { r = deps.readNext(projectDir); } catch (e) {
      return stop(DRIVE_EXIT.failed, `next could not be read: ${String(e.message).split("\n")[0]}`);
    }
    if (r.state === "idle" || (!r.next && r.state !== "waiting")) {
      if (dryRun) { print("drive: would stop — nothing left to run"); return { code: DRIVE_EXIT.idle, reason: "nothing left", steps }; }
      return stop(DRIVE_EXIT.idle, "nothing left to run");
    }
    if (r.state === "waiting") {
      const who = r.waiting.map((w) => `${w.on}: ${w.name} — ${w.command}`);
      if (dryRun) { print("drive: would stop — waiting on a person"); for (const w of who) print(`  ${w}`); return { code: DRIVE_EXIT.waiting, reason: "waiting on a person", steps }; }
      return stop(DRIVE_EXIT.waiting, `waiting on a person: ${r.waiting.map((w) => `${w.on}: ${w.name}`).join("; ")}`, who);
    }

    const item = r.next;
    const step = classifyStep(item);
    if (step.kind === "person-ruling") {
      const reason = `next names a person's ruling, which drive never runs: ${step.by ?? "a person"} rules ${step.name}`;
      if (dryRun) { print(`drive: would stop — ${reason}`); print(`  ${item.command}`); return { code: DRIVE_EXIT.waiting, reason, steps }; }
      return stop(DRIVE_EXIT.waiting, reason, [item.command]);
    }
    if (dryRun) {
      print(`drive: would run: ${item.command}`);
      print(`  why: ${item.why}`);
      if (item.rule) print(`  rule: ${item.rule}`);
      print("  and then read next again, stopping at a person, a failure, an expired sign-in, a step that changes nothing, or the step limit");
      return { code: DRIVE_EXIT.idle, reason: "dry run", steps };
    }

    const now = deps.mark(projectDir, item);
    if (before.has(item.command) && same(before.get(item.command), now)) {
      return stop(DRIVE_EXIT.noProgress, `no progress: next names \`${item.command}\` again and nothing it could change has changed since it last ran`, [`why: ${item.why}`]);
    }
    if (steps >= maxSteps) {
      return stop(DRIVE_EXIT.stepLimit, `step limit of ${maxSteps} reached; next names \`${item.command}\``);
    }

    steps++;
    last = item.command;
    before.set(item.command, now);
    deps.record.step(projectDir, `drive: step ${steps}: \`${item.command}\` — ${item.why}`);
    beat({ state: "running", command: item.command, stepStarted: new Date().toISOString() });
    print(`drive: step ${steps}: ${item.command}`);
    print(`  why: ${item.why}`);

    let result = await deps.execute(projectDir, item);
    if (!result.ok && !result.notPassed && !authFailureReported(textOf(result))) {
      const trouble = targetTrouble(textOf(result));
      if (trouble) {
        const brought = await bringUp(projectDir, deps, trouble, steps);
        if (!brought.ok) {
          return stop(DRIVE_EXIT.failed, `step ${steps} (\`${item.command}\`) found the oracle ${trouble === "down" ? "not up" : "unusable"}, and it could not be brought up: ${brought.why}`, tailOf(brought.output));
        }
        print(`drive: step ${steps}: the oracle is up; running \`${item.command}\` once more`);
        result = await deps.execute(projectDir, item);
      }
      const sandbox = trouble ? null : sandboxTrouble(textOf(result));
      if (sandbox?.kind === "start") {
        const run = await withSandbox(projectDir, deps, sandbox, steps, () => {
          print(`drive: step ${steps}: the ${sandbox.target} target's sandbox is up from ${sandbox.from}; running \`${item.command}\` once more`);
          return deps.execute(projectDir, item);
        });
        const again = `sdlc sandbox down --target ${sandbox.target} --from ${sandbox.from}`;
        if (!run.started.ok) {
          return stop(DRIVE_EXIT.failed, `step ${steps} (\`${item.command}\`) found the ${sandbox.target} target's sandbox not up, and it could not be started from ${sandbox.from}${run.down.ok ? "" : `, nor taken down afterwards (${again} by hand)`}`, tailOf(run.started.output));
        }
        if (!run.down.ok) {
          return stop(DRIVE_EXIT.failed, `step ${steps} (\`${item.command}\`) ran against the ${sandbox.target} target's sandbox from ${sandbox.from}, which could not be taken down afterwards; take it down by hand: ${again}`, tailOf(run.down.output));
        }
        result = run.result;
      } else if (sandbox?.kind === "ports" && deps.oracleUp(projectDir)) {
        deps.record.recovery(projectDir, `drive: step ${steps} recovery: the sandbox could not start on a port this machine already holds, and the oracle is up; taking it down (sdlc oracle down), then running the step once more`);
        await deps.oracle(projectDir, "down");
        print(`drive: step ${steps}: the oracle is down; running \`${item.command}\` once more`);
        result = await deps.execute(projectDir, item);
      }
    }

    if (!result.ok && authFailureReported(textOf(result))) {
      return stop(DRIVE_EXIT.signIn, `the agent CLI's sign-in has expired or was refused during step ${steps} (\`${item.command}\`); sign in again and run sdlc drive again`, tailOf([textOf(result)]).slice(0, 6));
    }
    if (!result.ok && !result.notPassed) {
      return stop(DRIVE_EXIT.failed, `step ${steps} (\`${item.command}\`) failed`, tailOf([...(result.output ?? []), ...(result.messages ?? [])]));
    }
    if (result.notPassed) print(`drive: step ${steps}: recorded, not passed (${result.notPassed})`);

    // A returned proposal is left checked out on purpose (0025), for a person to read what came
    // back; the loop has recorded the return and moves on from main.
    const after = deps.tree(projectDir);
    if (after.clean && after.branch?.startsWith("proposal/")) {
      deps.checkoutMain(projectDir);
      print(`drive: back to main from ${after.branch}, which a return leaves checked out`);
    }
    const afterTree = treeProblem(deps.tree(projectDir));
    if (afterTree) return stop(DRIVE_EXIT.failed, `step ${steps} (\`${item.command}\`) left the project unfit for the next step: ${afterTree}`);
  }
}

// One recovery for a step whose oracle was not there: bring it up (restart it first when it
// was up and unusable), and when that fails — a hung `oracle up` ends at its own time limit
// and fails like any other — take it down and bring it up once more. Each action is on the
// record before it runs.
async function bringUp(projectDir, deps, trouble, step) {
  const why = trouble === "down" ? "the oracle was not up" : "the oracle was up and could not be reset or reached";
  if (trouble === "unusable") {
    deps.record.recovery(projectDir, `drive: step ${step} recovery: ${why}; taking it down and bringing it up (sdlc oracle down, sdlc oracle up), then running the step once more`);
    await deps.oracle(projectDir, "down");
    const up = await deps.oracle(projectDir, "up");
    return up.ok ? { ok: true } : { ok: false, why: "sdlc oracle up failed after sdlc oracle down", output: up.output };
  }
  deps.record.recovery(projectDir, `drive: step ${step} recovery: ${why}; bringing it up (sdlc oracle up), then running the step once more`);
  const first = await deps.oracle(projectDir, "up");
  if (first.ok) return { ok: true };
  deps.record.recovery(projectDir, `drive: step ${step} recovery: sdlc oracle up failed (${tailOf(first.output).at(-1) ?? "no output"}); taking it down and bringing it up once more`);
  await deps.oracle(projectDir, "down");
  const second = await deps.oracle(projectDir, "up");
  return second.ok ? { ok: true } : { ok: false, why: "sdlc oracle up failed twice, the second time after sdlc oracle down", output: second.output };
}

// One recovery for a step that found a rebuilt target's sandbox not up: start the sandbox from
// the branch the step named; run the step once more; and take the sandbox down whatever
// happened, so the loop never leaves a stack running that the next step does not expect. The
// oracle stays up beside the sandbox, so the next step that needs it does not wait for it to be
// built and seeded again; only a sandbox refused a port the oracle holds takes it down, and is
// started once more (`docs/decisions/0101`). Each action is on the record before it runs. The
// sandbox password the stack signs in with is this process's own environment, which
// `sandbox up` and the step read alike; it is never an argument.
async function withSandbox(projectDir, deps, { target, from }, step, run) {
  const up = `sdlc sandbox up --target ${target} --from ${from}`;
  const down = `sdlc sandbox down --target ${target} --from ${from}`;
  deps.record.recovery(projectDir, `drive: step ${step} recovery: the ${target} target's sandbox was not up; starting it from ${from} (${up}), running the step once more, and taking it down after (${down})`);
  let started = { ok: false, output: [] };
  let result;
  let stopped;
  try {
    started = await deps.sandbox(projectDir, "up", { target, from });
    if (!started.ok && sandboxTrouble(textOf(started))?.kind === "ports" && deps.oracleUp(projectDir)) {
      deps.record.recovery(projectDir, `drive: step ${step} recovery: the ${target} target's sandbox could not start on a port the oracle holds; taking the oracle down (sdlc oracle down) and starting it once more`);
      await deps.oracle(projectDir, "down");
      started = await deps.sandbox(projectDir, "up", { target, from });
    }
    if (started.ok) result = await run();
  } finally {
    deps.record.recovery(projectDir, `drive: step ${step} recovery: taking the ${target} target's sandbox down (${down})`);
    stopped = await deps.sandbox(projectDir, "down", { target, from });
  }
  return { started, result, down: stopped };
}

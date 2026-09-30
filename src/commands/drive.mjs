// `sdlc drive [dir] [--max-steps N] [--dry-run] [--status]` — run what `next` names until it
// stops at a person, a failure or a dead end (`docs/stages/drive.md`). The loop is
// `src/runner/drive.mjs`; this module gives it the real record, the real stages and rulings,
// the real oracle, and the places its lines and its heartbeat are written.
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { git, porcelainStatus, currentBranch, stagePaths, SDLC_AUTHOR } from "../lib/git.mjs";
import { writeText } from "../lib/fsx.mjs";
import { appendRun, deferRun } from "../lib/runrecord.mjs";
import { whatNext } from "../runner/next.mjs";
import { drive, classifyStep, progressMark, DEFAULT_MAX_STEPS, DRIVE_EXIT } from "../runner/drive.mjs";
import { runReported } from "./run.mjs";
import { ruleByAgentReported } from "./rule.mjs";
import { runOracle } from "./oracle.mjs";
import { COMMANDS } from "../cli.mjs";

// The operator's view of a loop that may run for hours: what it is doing and since when.
// Kept out of the record on purpose. It is a timestamp that changes on every step, which the
// record and the state site (a pure function of the record, `sdlc status`) must never hold,
// and it matches the `.sdlc/*.local.yaml` line every project ignores, so writing it never
// makes the tree dirty under the loop that wrote it.
export const HEARTBEAT = join(".sdlc", "drive.local.yaml");

function readHeartbeat(projectDir) {
  const p = join(projectDir, HEARTBEAT);
  if (!existsSync(p)) return null;
  try { return parse(readFileSync(p, "utf8")) ?? null; } catch { return null; }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export function formatHeartbeat(b) {
  if (!b) return "drive: has not run in this project";
  const plural = (n) => `${n} step${n === 1 ? "" : "s"}`;
  if (b.state === "stopped") return `drive: stopped at ${b.stopped} after ${plural(b.step ?? 0)} — ${b.reason}`;
  if (!alive(b.pid)) {
    return `drive: not running — process ${b.pid} is gone; it was on step ${b.step ?? 0}${b.command ? `: \`${b.command}\`` : ""} (last heard ${b.updated ?? b.started})`;
  }
  const on = b.command ? `step ${b.step}: \`${b.command}\`, started ${b.stepStarted ?? b.updated}` : "reading next";
  return `drive: running since ${b.started} (process ${b.pid}); ${on}; last heard ${b.updated ?? b.started}`;
}

// Everything printed while `fn` runs, kept as lines as well as printed, so a step that fails
// can be stopped on with the end of its own account. Output a child process writes straight
// to the terminal (a compose build) is printed and not kept.
async function captured(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const keep = (method) => (...a) => {
    lines.push(...a.map(String).join(" ").split("\n"));
    if (lines.length > 400) lines.splice(0, lines.length - 400);
    orig[method](...a);
  };
  console.log = keep("log");
  console.warn = keep("warn");
  console.error = keep("error");
  try {
    return { value: await fn(), output: lines };
  } catch (error) {
    return { error, output: lines };
  } finally {
    Object.assign(console, orig);
  }
}

// One step, through the same function `sdlc run` or `sdlc rule --by agent:<persona>` calls.
// The loop runs exactly what `next` named, so there is no deviation to check or record.
async function execute(projectDir, item) {
  const step = classifyStep(item);
  const { value, error, output } = await captured(async () => {
    if (step.kind === "run") {
      const a = step.args;
      return runReported(projectDir, step.stage, {
        slice: a.slice === undefined ? undefined : Number(a.slice), domain: a.domain, target: a.target,
        stale: !!a.stale, revise: !!a.revise, skipSuite: !!a.skipSuite, full: !!a.full,
      });
    }
    if (step.kind === "agent-ruling") return { code: 0, result: await ruleByAgentReported(projectDir, step.name, step.persona) };
    throw new Error(`drive does not run \`${item.command}\``);
  });
  if (error) return { ok: false, messages: [error.message], output };
  const r = value.result ?? {};
  return { ok: value.code === 0, ...(r.notPassed ? { notPassed: r.notPassed } : {}), messages: r.messages ?? [], output };
}

async function oracle(projectDir, sub) {
  const { value, error, output } = await captured(() => runOracle(projectDir, sub, {}));
  return { ok: !error && value === 0, output: error ? [...output, error.message] : output };
}

// A line the loop writes about a step waits in the ignored pending record and is written by
// the step's own commit, ahead of the step's own line, the way a command a stage runs is
// recorded (`deferRun`). A stop is committed on its own, on `main` and only from a clean
// tree; anywhere else it waits for the next pipeline commit rather than sweep up work that
// is not the loop's.
const record = {
  step: (dir, line) => deferRun(dir, line),
  recovery: (dir, line) => deferRun(dir, line),
  stop: (dir, line) => {
    if (currentBranch(dir) !== "main" || porcelainStatus(dir)) { deferRun(dir, line); return; }
    const runPath = appendRun(dir, line);
    stagePaths(dir, [relative(dir, runPath)]);
    git([...SDLC_AUTHOR, "commit", "-q", "-m", `run(drive): ${line.replace(/^drive: /, "").split(" — ")[0]}`], dir);
  },
};

export function defaultDeps() {
  return {
    readNext: (dir) => whatNext(dir),
    tree: (dir) => {
      const dirty = porcelainStatus(dir);
      return { clean: !dirty, dirty: dirty ? dirty.split("\n") : [], branch: currentBranch(dir) };
    },
    execute,
    oracle,
    mark: progressMark,
    record,
    heartbeat: (dir, beat) => writeText(join(dir, HEARTBEAT), stringify({ ...beat, pid: process.pid, updated: new Date().toISOString() })),
    print: (line) => console.log(line),
    runningElsewhere: (dir) => {
      const b = readHeartbeat(dir);
      return b && b.state === "running" && b.pid !== process.pid && alive(b.pid) ? b : null;
    },
  };
}

// `deps` replaces any of the real ones, which is how a test runs one real step without a
// real record naming it.
export async function driveProject(projectDir, { maxSteps = DEFAULT_MAX_STEPS, dryRun = false, deps = {} } = {}) {
  const r = await drive(resolve(projectDir), { maxSteps, dryRun, deps: { ...defaultDeps(), ...deps } });
  return r.code;
}

COMMANDS.drive = async ({ pos, flags }) => {
  const dir = resolve(pos[0] ?? process.cwd());
  if (flags.status) { console.log(formatHeartbeat(readHeartbeat(dir))); return 0; }
  let maxSteps = DEFAULT_MAX_STEPS;
  if (flags["max-steps"] !== undefined) {
    maxSteps = Number(flags["max-steps"]);
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      console.error("drive: --max-steps takes a whole number of steps, 1 or more");
      return DRIVE_EXIT.refused;
    }
  }
  return driveProject(dir, { maxSteps, dryRun: !!flags["dry-run"] });
};

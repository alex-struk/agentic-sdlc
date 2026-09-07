import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureConfigHome } from "./config-home.mjs";
import { writeText } from "../lib/fsx.mjs";

// The turn ceiling a session runs with when nothing else sets one.
export const DEFAULT_MAX_TURNS = 40;

// `config.policy.budgets[<name>]` is documented as a token count, but `runAgent`'s
// `maxTurns` wants a turn count and there is no token-to-turn conversion yet (that is
// its own later task). A configured value under 1000 is small enough to read as a turn
// count already — a token budget for a whole stage would run into the thousands — so
// it is used directly, clamped to 200; anything at or above 1000 is a token count we
// cannot yet translate, so it falls back to `fallback`: the default of 40 turns for a
// stage, or whatever the caller runs with when no budget is set at all (a ruling turn
// passes its own, smaller ceiling).
// Warned names, so a run that calls `turnsFor` more than once for the same name says
// this once rather than once per call.
const warnedBudgets = new Set();

export function turnsFor(config, name, fallback = DEFAULT_MAX_TURNS) {
  const budget = config.policy?.budgets?.[name];
  if (budget && budget < 1000) return Math.min(budget, 200);
  // A token-sized budget is configured, understood, and then ignored. Saying so out
  // loud is the difference between "this stage is capped where I set it" and the truth,
  // which is that it is capped at the default.
  if (budget && !warnedBudgets.has(name)) {
    warnedBudgets.add(name);
    console.warn(`warning: policy.budgets.${name} is ${budget}, which reads as a token budget, not a turn count. There is no token-to-turn conversion yet, so this budget is ignored and ${name} runs with the default ceiling of ${fallback} turns. To cap turns, set policy.budgets.${name} to a number below 1000.`);
  }
  return fallback;
}

// How the session ended, in words, when the CLI said something worth repeating. The
// `subtype` on a result is the CLI's own account — `error_max_turns` when the turn
// ceiling was reached, `error_during_execution` when the session broke — and it is the
// only reliable way to tell those apart: comparing `num_turns` against the cap gets it
// wrong in both directions, since a session can report the cap's worth of turns having
// finished normally, or fewer having been cut short.
//
// Returns null when there is nothing to say: no result, or a plain success.
export function endedBecause(raw) {
  const reason = raw?.subtype ?? raw?.terminal_reason ?? "";
  if (!reason || reason === "success") return null;
  if (/max_turns|turn_limit/.test(reason)) return `hit the turn cap (${reason})`;
  return `ended with ${reason}`;
}

export function buildArgs({ prompt, stage, maxTurns = DEFAULT_MAX_TURNS, systemPromptFile, addDirs = [], allowedTools = [], env = {}, mcpConfig }, configHome) {
  const args = ["-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits",
    "--strict-mcp-config"];
  // `--mcp-config` sits right after `--strict-mcp-config`: strict mode refuses any
  // server not named in a config passed this way, so the two flags are read together —
  // this is the one and only source of servers for the session. Omitted when the stage
  // declares no `mcp`, the common case.
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  args.push("--no-session-persistence", "--max-turns", String(maxTurns));
  // `--allowedTools` takes a space-separated list, so each entry is its own argument.
  // Omitted entirely when the caller names none: the flag with an empty list would read
  // as "allow nothing" to the session rather than "the caller did not narrow this".
  if (allowedTools.length) args.push("--allowedTools", ...allowedTools);
  if (systemPromptFile) args.push("--append-system-prompt-file", systemPromptFile);
  for (const d of addDirs) args.push("--add-dir", d);
  return { args, env: { ...process.env, ...env, CLAUDE_CONFIG_DIR: configHome, SDLC_STAGE: stage } };
}

// How many times each canned file has been consumed in this process, so a `sequence`
// below can hand back a different reply per call. Keyed by path, since two stages (or two
// tests) have their own files and their own counts.
const mockCalls = new Map();

function runMock({ cwd, stage }) {
  const p = join(process.env.SDLC_MOCK_DIR ?? "", `${stage}.json`);
  if (!existsSync(p)) throw new Error(`mock executor: no canned response at ${p}`);
  const file = JSON.parse(readFileSync(p, "utf8"));
  // A canned response may be a `sequence` of replies rather than one, consumed a step per
  // call, so a test can stand in for a turn that is legitimately asked more than once
  // inside a single command — the ratification-grammar re-prompt, or the automatic retry
  // of a failed ruling. The last entry is reused once the list runs out, so a sequence
  // never becomes the reason a test fails.
  const n = mockCalls.get(p) ?? 0;
  mockCalls.set(p, n + 1);
  const m = Array.isArray(file.sequence) ? file.sequence[Math.min(n, file.sequence.length - 1)] : file;
  for (const [rel, content] of Object.entries(m.files ?? {})) writeText(join(cwd, rel), content);
  // A canned response can also delete a tracked file, so tests can exercise how a stage
  // stages and commits a deletion without a real agent turn actually removing anything.
  for (const rel of m.delete ?? []) rmSync(join(cwd, rel), { force: true });
  // A canned response can declare `ok: false` to stand in for an agent turn that ran
  // and failed (an error result, a turn limit hit), which is a different outcome from
  // the mock throwing — that stands in for the executor itself failing to run.
  return { ok: m.ok !== false, text: m.text ?? "", cost: 0, turns: 1, sessionId: "mock", raw: m };
}

// The binary a real agent turn spawns. Overridable so the executor's own behaviour —
// how it reads the CLI's JSON, what it does with output that is not JSON at all, which
// flags it actually passed — can be exercised against a real subprocess, rather than only
// through the in-process mock that never goes near `execFile`.
export function claudeBin() {
  return process.env.SDLC_CLAUDE_BIN || "claude";
}

export async function runAgent(opts) {
  if (process.env.SDLC_EXECUTOR === "mock") return runMock(opts);
  const { args, env } = buildArgs(opts, ensureConfigHome());
  const raw = await new Promise((resolve, reject) => {
    execFile(claudeBin(), args, { cwd: opts.cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(`claude failed: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
  let j; try { j = JSON.parse(raw); } catch { throw new Error(`claude returned non-JSON output:\n${raw.slice(0, 500)}`); }
  return { ok: !j.is_error, text: j.result ?? "", cost: j.total_cost_usd ?? 0, turns: j.num_turns ?? 0, sessionId: j.session_id ?? "", raw: j };
}

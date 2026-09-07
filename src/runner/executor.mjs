import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureConfigHome } from "./config-home.mjs";
import { writeText } from "../lib/fsx.mjs";

// The turn ceiling a session runs with when nothing else sets one. Exported so the one
// place that falls back to it (`turnsFor`, in `src/commands/run.mjs`) names the same
// number in its warning that the executor actually applies.
export const DEFAULT_MAX_TURNS = 40;

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

export function buildArgs({ prompt, stage, maxTurns = DEFAULT_MAX_TURNS, systemPromptFile, addDirs = [], allowedTools = [], env = {} }, configHome) {
  const args = ["-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits",
    "--strict-mcp-config", "--no-session-persistence", "--max-turns", String(maxTurns)];
  // `--allowedTools` takes a space-separated list, so each entry is its own argument.
  // Omitted entirely when the caller names none: the flag with an empty list would read
  // as "allow nothing" to the session rather than "the caller did not narrow this".
  if (allowedTools.length) args.push("--allowedTools", ...allowedTools);
  if (systemPromptFile) args.push("--append-system-prompt-file", systemPromptFile);
  for (const d of addDirs) args.push("--add-dir", d);
  return { args, env: { ...process.env, ...env, CLAUDE_CONFIG_DIR: configHome, SDLC_STAGE: stage } };
}

function runMock({ cwd, stage }) {
  const p = join(process.env.SDLC_MOCK_DIR ?? "", `${stage}.json`);
  if (!existsSync(p)) throw new Error(`mock executor: no canned response at ${p}`);
  const m = JSON.parse(readFileSync(p, "utf8"));
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

import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureConfigHome } from "./config-home.mjs";
import { writeText } from "../lib/fsx.mjs";

export function buildArgs({ prompt, stage, maxTurns = 40, systemPromptFile, addDirs = [], env = {} }, configHome) {
  const args = ["-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits",
    "--strict-mcp-config", "--no-session-persistence", "--max-turns", String(maxTurns)];
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
  return { ok: true, text: m.text ?? "", cost: 0, turns: 1, sessionId: "mock", raw: m };
}

export async function runAgent(opts) {
  if (process.env.SDLC_EXECUTOR === "mock") return runMock(opts);
  const { args, env } = buildArgs(opts, ensureConfigHome());
  const raw = await new Promise((resolve, reject) => {
    execFile("claude", args, { cwd: opts.cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(`claude failed: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
  let j; try { j = JSON.parse(raw); } catch { throw new Error(`claude returned non-JSON output:\n${raw.slice(0, 500)}`); }
  return { ok: !j.is_error, text: j.result ?? "", cost: j.total_cost_usd ?? 0, turns: j.num_turns ?? 0, sessionId: j.session_id ?? "", raw: j };
}

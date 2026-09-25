import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The OpenAI Codex CLI as an agent backend. Every flag used here is one `codex exec --help`
// lists (codex-cli 0.157.0); every `-c` key is a configuration key the same CLI reads. What
// each one is for, and what a Codex session cannot be made to do that a Claude session can,
// is `docs/decisions/0060-a-second-agent-backend.md`.

// The binary a Codex turn spawns. Overridable for the same reason `SDLC_CLAUDE_BIN` is: so
// the executor's handling of a real subprocess can be exercised against a stand-in.
export function codexBin() {
  return process.env.SDLC_CODEX_BIN || "codex";
}

// What a failed Codex session is told about how it signs in: the counterpart of the Claude
// paragraph in `executor.mjs`, naming the directory and file Codex actually reads, relative
// to the variable that sets it rather than by any path on a particular machine.
export const CODEX_AUTH_ADVICE = [
  "A stage session has no sign-in of its own: a Codex session authenticates with the operator's own ChatGPT sign-in,",
  "read from the `auth.json` file in the directory this pipeline points `CODEX_HOME` at",
  "(`SDLC_CODEX_HOME` names that directory when it is set). An API key is never used.",
  "Sign in again interactively with `codex login` and run this again.",
  "A sign-in a stage session refreshes is kept in that same directory rather than written back,",
  "so if signing in does not clear this, remove `auth.json` from that directory and the next stage takes a fresh copy.",
].join(" ");

// Variables through which the CLI would authenticate with an API key rather than the
// operator's subscription sign-in. Removed from the session's environment, whoever set them.
const API_KEY_VARS = ["OPENAI_API_KEY", "CODEX_API_KEY"];

// Codex has no turn cap, so the runner stops a session at a wall-clock ceiling instead:
// thirty seconds per turn the stage is allowed, and never less than two minutes, which is
// what a one-turn check needs for the CLI to start, connect and answer.
export const SECONDS_PER_TURN = 30;
export function codexWallClockMs(maxTurns) {
  return Math.max(120_000, maxTurns * SECONDS_PER_TURN * 1000);
}

// A single `-c` value is one argument, and Linux refuses any one argument over 128 KiB at
// `spawn` (`E2BIG`). The skill travels as one, so a skill near that size is refused here,
// by name, rather than failing the spawn with an error that names nothing.
const MAX_INSTRUCTIONS_BYTES = 100_000;

// Whether the stage may write, and whether it was given a shell, read off the one
// declaration both backends share: the Claude tool allowlist. No list at all is a writing
// stage confined by the project's guard. A list naming no editing tool is a turn that only
// reads — a ruling, the sign-in check.
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
export function writesFiles(allowedTools = []) {
  return allowedTools.length === 0 || allowedTools.some((t) => EDIT_TOOLS.has(t));
}
export function grantsShell(allowedTools = []) {
  return allowedTools.some((t) => t === "Bash" || t.startsWith("Bash("));
}

// A TOML value for `-c`. A JSON string literal is a valid TOML basic string, and a JSON
// array of strings a valid TOML inline array.
const toml = (v) => JSON.stringify(v);
const bareKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

// The front-matter `description` of a skill file, for the index below. Read line by line
// rather than parsed, since a skill's front matter is a handful of `key: value` lines.
function skillDescription(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return "";
  const line = m[1].split("\n").find((l) => l.startsWith("description:"));
  return line ? line.slice("description:".length).trim().replace(/^["']|["']$/g, "") : "";
}

// The skills a workspace carries under `.claude/skills/`, as a list the session is told
// about. A Claude session discovers that directory by itself; a Codex session does not, so
// each skill is named with its description and its path in the workspace, and read from
// there. Nothing is copied: the files are the workspace's own.
export function skillsIndex(cwd) {
  if (!cwd) return "";
  const dir = join(cwd, ".claude", "skills");
  if (!existsSync(dir)) return "";
  const entries = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const description = skillDescription(readFileSync(file, "utf8"));
    entries.push(`- \`${name}\` (\`.claude/skills/${name}/SKILL.md\`)${description ? `: ${description}` : ""}`);
  }
  if (!entries.length) return "";
  return ["## Skills in this workspace", "",
    "These skills are in the workspace under `.claude/skills/`. Before doing work one of them describes, read its `SKILL.md` and follow it.", "",
    ...entries].join("\n");
}

// The stage's MCP servers, as `mcp_servers.<name>` overrides. A server that needs
// environment values is refused: the only way to hand Codex a value from here is the
// command line, where anything a server needs a variable for — a token, a key — would be
// readable by every process on the machine.
function mcpOverrides(mcpConfig) {
  if (!mcpConfig) return [];
  const servers = JSON.parse(readFileSync(mcpConfig, "utf8")).mcpServers ?? {};
  const out = [];
  for (const [name, s] of Object.entries(servers)) {
    const env = Object.keys(s.env ?? {});
    if (env.length) {
      throw new Error(`MCP server ${name} needs environment values (${env.join(", ")}), and a Codex session can only be given them on its command line, where they would be visible to every process on the machine. Run this stage on claude.`);
    }
    const key = `mcp_servers.${bareKey(name)}`;
    out.push("-c", `${key}.command=${toml(s.command)}`);
    if (s.args?.length) out.push("-c", `${key}.args=${toml(s.args)}`);
  }
  return out;
}

// One Codex turn: `codex exec`, the prompt on stdin (`-`), the event stream on stdout as
// JSONL. The working root is the process's own cwd, which `runAgent` sets to the stage's
// workspace, so no path is passed on the command line.
//
// Isolation, in the terms `docs/decisions/0004` sets for a Claude session: `CODEX_HOME` is
// the pipeline's own directory; `--ignore-user-config` reads no `config.toml` even if one
// appears there; `--ephemeral` persists no session; `--skip-git-repo-check` because an
// ephemeral workspace is an extracted archive, not a repository; and
// `--dangerously-bypass-hook-trust` because the one hook in that directory is the one the
// pipeline wrote (`ensureCodexHome`), and Codex runs no hook it has not been told to trust.
export function buildCodexArgs({ prompt, stage, systemPromptFile, addDirs = [], allowedTools = [], env = {}, mcpConfig, model, cwd }, codexHome) {
  const writes = writesFiles(allowedTools);
  const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config",
    "--dangerously-bypass-hook-trust",
    "--sandbox", writes ? "workspace-write" : "read-only",
    "-c", 'approval_policy="never"'];
  // A stage given a shell was given it to reach something — a package registry, the
  // oracle — and Codex's workspace sandbox has no network unless it is granted.
  if (writes && grantsShell(allowedTools)) args.push("-c", "sandbox_workspace_write.network_access=true");
  if (model) args.push("--model", model);
  const instructions = [systemPromptFile ? readFileSync(systemPromptFile, "utf8") : "", skillsIndex(cwd)]
    .filter(Boolean).join("\n\n");
  if (instructions) {
    const value = `developer_instructions=${toml(instructions)}`;
    if (Buffer.byteLength(value) > MAX_INSTRUCTIONS_BYTES) {
      throw new Error(`the ${stage} skill is ${Buffer.byteLength(instructions)} bytes, and a Codex session takes it as one command-line argument, capped at ${MAX_INSTRUCTIONS_BYTES}. Shorten the skill or run this stage on claude.`);
    }
    args.push("-c", value);
  }
  args.push(...mcpOverrides(mcpConfig));
  for (const d of addDirs) args.push("--add-dir", d);
  args.push("-");
  const childEnv = { ...process.env, ...env, CODEX_HOME: codexHome, SDLC_STAGE: stage };
  for (const k of API_KEY_VARS) delete childEnv[k];
  return { args, env: childEnv, input: prompt };
}

// The item kinds that are the session doing something — the nearest thing Codex reports to
// Claude's turn count. Reasoning and error items are not steps.
const STEP_ITEMS = new Set(["agent_message", "command_execution", "file_change", "mcp_tool_call", "web_search"]);

// Reads the event stream `codex exec --json` prints. Returns null when there are no events
// at all, which is output this cannot interpret and the caller reports as such.
//
// A session succeeded when its turn completed and did not fail. Its text is the last agent
// message; a failed one's text is the failure the CLI reported, or the last error event when
// it reported none. Cost is always 0: a subscription session reports tokens, not money, and
// the tokens are kept on `raw.usage`.
export function parseCodexOutput(stdout) {
  const events = [];
  for (const line of String(stdout).split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const e = JSON.parse(s);
      if (e && typeof e.type === "string") events.push(e);
    } catch { /* a line that is not an event is not one of ours */ }
  }
  if (!events.length) return null;
  let sessionId = "";
  let message = "";
  let failure = null;
  let lastError = "";
  let completed = false;
  let usage = null;
  let steps = 0;
  for (const e of events) {
    if (e.type === "thread.started") sessionId = e.thread_id ?? sessionId;
    else if (e.type === "item.completed") {
      const item = e.item ?? {};
      if (item.type === "agent_message") message = item.text ?? message;
      if (STEP_ITEMS.has(item.type)) steps += 1;
    } else if (e.type === "turn.completed") {
      completed = true;
      if (e.usage) usage = e.usage;
    } else if (e.type === "turn.failed") failure = e.error?.message ?? "the turn failed";
    else if (e.type === "error") lastError = e.message ?? lastError;
  }
  const ok = completed && !failure;
  const text = ok ? message : (failure ?? lastError ?? "");
  const subtype = ok ? "success" : failure ? "turn_failed" : "incomplete";
  return { ok, text, cost: 0, turns: steps, sessionId, raw: { subtype, thread_id: sessionId, ...(usage ? { usage } : {}) } };
}

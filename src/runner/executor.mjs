import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureConfigHome, ensureCodexHome } from "./config-home.mjs";
import { buildCodexArgs, codexBin, parseCodexOutput, codexWallClockMs, CODEX_AUTH_ADVICE } from "./codex.mjs";
import { writeText } from "../lib/fsx.mjs";

// The MCP servers a stage names (`stage.mcp?.(ctx, config)`) live in their own scratch
// file rather than a project path, since the set is run-specific and never any stage's
// own output — written into a scratch directory the caller already owns and cleans up
// (the skill-file directory both a first turn and a fix turn create), so this adds no
// cleanup of its own. Shared by `run`'s first turn and `finish-stage`'s fix turn, which
// otherwise duplicated the same three lines. Returns `undefined` when the stage
// declares no `mcp` — the common case — so `buildArgs` passes no `--mcp-config` at all
// and the session reaches no servers under `--strict-mcp-config`.
export function writeMcpConfig(dir, mcpServers) {
  if (!mcpServers) return undefined;
  const path = join(dir, "mcp.json");
  writeText(path, JSON.stringify({ mcpServers }, null, 2) + "\n");
  return path;
}

// The turn ceiling a session runs with when nothing else sets one.
export const DEFAULT_MAX_TURNS = 40;

// A `policy.budgets` value at or above this reads as a token budget rather than a turn
// count, and is ignored. Below it, the value is a turn count and is honoured up to the ceiling.
export const TOKEN_BUDGET_FLOOR = 1000;

// The highest turn count any stage may be given: one below the token-budget floor, since
// a larger number stops being readable as a turn count at all. It is a ceiling rather than
// a clamp — `checkConfig` refuses a budget above it outright rather than letting this
// quietly reduce one, because a budget a gate approved is not the runner's to halve in
// silence. A stage that genuinely needs more turns than this needs splitting.
export const MAX_TURNS_CEILING = TOKEN_BUDGET_FLOOR - 1;

// A stage's turn ceiling is `config.policy.turns[<name>]`, a turn count the schema holds
// under the ceiling. `policy.budgets` is the same setting under the name existing projects
// carry, read where `policy.turns` does not name the stage: a value under 1000 is a turn
// count and is honoured up to the ceiling, and anything at or above 1000 reads as a token
// budget the runner has no conversion for, so it falls back to `fallback` — the default of
// 40 turns for a stage, or whatever the caller runs with when nothing is set at all (a
// ruling turn passes its own, smaller ceiling). `checks` refuses that value and reports
// the alias as deprecated.
// Warned names, so a run that calls `turnsFor` more than once for the same name says
// this once rather than once per call.
const warnedBudgets = new Set();

export function turnsFor(config, name, fallback = DEFAULT_MAX_TURNS) {
  const turns = config.policy?.turns?.[name];
  if (turns) return Math.min(turns, MAX_TURNS_CEILING);
  const budget = config.policy?.budgets?.[name];
  if (budget && budget < TOKEN_BUDGET_FLOOR) return Math.min(budget, MAX_TURNS_CEILING);
  // A token-sized budget is configured, understood, and then ignored. Saying so out
  // loud is the difference between "this stage is capped where I set it" and the truth,
  // which is that it is capped at the default.
  if (budget && !warnedBudgets.has(name)) {
    warnedBudgets.add(name);
    console.warn(`warning: policy.budgets.${name} is ${budget}, which reads as a token budget, not a turn count. There is no token-to-turn conversion, so this budget is ignored and ${name} runs with the default ceiling of ${fallback} turns. To cap turns, set policy.turns.${name} to a number below 1000.`);
  }
  return fallback;
}

// What a failed session is told about how it signs in. A stage session has no login of
// its own and no way to obtain one: it reads the operator's credential out of the config
// home the pipeline points `CLAUDE_CONFIG_DIR` at, so an expired sign-in fails the stage
// while looking exactly like a crash. The wording stays relative to that directory and
// names no path on any particular machine, because it is printed, journalled and read by
// people who did not set the directory up.
export const AUTH_ADVICE = [
  "A stage session has no sign-in of its own: it authenticates with the operator's own CLI login,",
  "read from the `.credentials.json` file in the config directory this pipeline points `CLAUDE_CONFIG_DIR`",
  "at (`SDLC_CLAUDE_HOME` names that directory when it is set).",
  "Sign in again interactively with the CLI and run this again.",
  "A credential a stage session refreshes is kept in that same directory rather than written back,",
  "so a stage and an interactive session can be holding different ones: if signing in does not clear this,",
  "remove `.credentials.json` from that directory and the next stage takes a fresh copy of the sign-in.",
].join(" ");

// Whether some text is a session complaining that it could not sign in. Matching on
// wording is the only evidence available — the CLI reports an authentication failure
// through the same `is_error` result and the same non-zero exit as anything else — so
// this errs toward saying yes: a false positive costs a paragraph of advice on an
// unrelated failure, and a false negative costs a person the diagnosis entirely.
const AUTH_FAILURE = /\boauth\b|\bauthenticat(e|ed|es|ing|ion)\b|\bunauthori[sz]ed\b|invalid[ _-]?api[ _-]?key|\brun\s+\/login\b|\bnot\s+logged\s+in\b|\bsession\s+(has\s+)?expired\b|\blogin\s+(required|expired)\b/i;

export function looksLikeAuthFailure(text) {
  return !!text && AUTH_FAILURE.test(text);
}

// The CLI's own account of the failure, followed by what a person can do about it. The
// account comes first and is never replaced: it is the only evidence of which failure
// this was, and the advice is a guess about the cause bolted onto it. Each backend signs
// in its own way, so each passes its own paragraph.
export function withAuthAdvice(text, advice = AUTH_ADVICE) {
  return looksLikeAuthFailure(text) ? `${text}\n\n${advice}` : text;
}

// The one-turn session that answers "can this machine sign in at all" before a stage
// spends its budget finding out. It runs against the same config home, the same binary
// and the same flags a stage turn does, so it exercises the credential a stage will
// actually use rather than a proxy for it.
export const PREFLIGHT_PROMPT = "Reply with one word: ok";
const PREFLIGHT_FAILED = "the stage was not started: a one-turn check could not authenticate, and the stage would have spent its whole budget to fail the same way.";

// `agent` is the backend and model the turn it guards will run on, so the check signs in
// exactly as that turn will.
export async function preflightAuth(agent = {}) {
  // Nothing to check: a mock turn never reaches a session at all.
  if (process.env.SDLC_EXECUTOR === "mock") return { ok: true, skipped: true, text: "" };
  let r;
  try {
    r = await runAgent({ prompt: PREFLIGHT_PROMPT, stage: "preflight", maxTurns: 1, allowedTools: ["Read"], agent });
  } catch (e) {
    // The CLI died rather than answering. That is this check's business only when it died
    // saying it could not sign in; anything else is a fault the stage is entitled to hit
    // and report for itself, and refusing the run on it would make this a second gate on
    // every stage rather than an authentication check.
    if (!looksLikeAuthFailure(e.message)) return { ok: true, unchecked: e.message };
    throw new Error(`${PREFLIGHT_FAILED}\n\n${e.message}`);
  }
  // Likewise for a turn that ran and failed for its own reasons: it reached the model,
  // which is the whole of what was asked.
  if (!r.ok && looksLikeAuthFailure(r.text)) throw new Error(`${PREFLIGHT_FAILED}\n\n${r.text}`);
  return { ok: true, text: r.text };
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

// The prompt travels on stdin, not argv: a persona ruling at G3 carries a diff of up to
// `DIFF_CAP_BY_GATE.G3` (120,000 characters, `src/runner/persona.mjs`), and an argument
// that size runs into the OS's argv/environment size limit (`spawn E2BIG`) well before
// it reaches that cap. `-p` with no positional prompt reads the prompt from stdin the
// same way an operator's own piped `claude -p` invocation would, so `runAgent` writes
// `input` to the child's stdin instead of appending it to `args`.
export function buildArgs({ prompt, stage, maxTurns = DEFAULT_MAX_TURNS, systemPromptFile, addDirs = [], allowedTools = [], env = {}, mcpConfig, model }, configHome) {
  const args = ["-p", "--output-format", "json", "--permission-mode", "acceptEdits",
    "--strict-mcp-config"];
  // `--mcp-config` sits right after `--strict-mcp-config`: strict mode refuses any
  // server not named in a config passed this way, so the two flags are read together —
  // this is the one and only source of servers for the session. Omitted when the stage
  // declares no `mcp`, the common case.
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  args.push("--no-session-persistence", "--max-turns", String(maxTurns));
  // Only a configured model is passed; without one the CLI chooses, as it always has.
  if (model) args.push("--model", model);
  // `--allowedTools` takes a space-separated list, so each entry is its own argument.
  // Omitted entirely when the caller names none: the flag with an empty list would read
  // as "allow nothing" to the session rather than "the caller did not narrow this".
  if (allowedTools.length) args.push("--allowedTools", ...allowedTools);
  if (systemPromptFile) args.push("--append-system-prompt-file", systemPromptFile);
  for (const d of addDirs) args.push("--add-dir", d);
  return { args, env: { ...process.env, ...env, CLAUDE_CONFIG_DIR: configHome, SDLC_STAGE: stage }, input: prompt };
}

// How many times each canned file has been consumed in this process, so a `sequence`
// below can hand back a different reply per call. Keyed by path, since two stages (or two
// tests) have their own files and their own counts.
const mockCalls = new Map();

function runMock({ cwd, stage, prompt, systemPromptFile }, agent) {
  // What the session was actually asked, written out for a test that needs to assert on
  // the prompt a stage built rather than on what it did with the reply — the recovery
  // block `archaeology` adds for a criterion it has been told to recover again reaches a
  // live agent only through this string. Off unless the variable names a path, and the
  // path is the caller's, never a project one, so nothing lands in the tree under test.
  if (process.env.SDLC_MOCK_PROMPT_FILE) writeText(process.env.SDLC_MOCK_PROMPT_FILE, prompt ?? "");
  // The skill the session was given, the same way: which copy of a stage's skill a run reads
  // is decided by the runner and reaches the agent only as this file.
  if (process.env.SDLC_MOCK_SKILL_FILE) writeText(process.env.SDLC_MOCK_SKILL_FILE, systemPromptFile ? readFileSync(systemPromptFile, "utf8") : "");
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
  // The engine a mock turn reports is the one the run resolved, marked as a mock, so a test
  // can follow provenance from configuration to every page that shows it.
  return { ok: m.ok !== false, text: m.text ?? "", cost: 0, turns: 1, sessionId: "mock", raw: m,
    engine: { backend: agent.backend, model: agent.model, version: "mock" } };
}

// The binary a real agent turn spawns. Overridable so the executor's own behaviour —
// how it reads the CLI's JSON, what it does with output that is not JSON at all, which
// flags it actually passed — can be exercised against a real subprocess, rather than only
// through the in-process mock that never goes near `execFile`.
export function claudeBin() {
  return process.env.SDLC_CLAUDE_BIN || "claude";
}

// The CLI's own version line, asked once per binary per process: it is what a record says
// ran the work, beside the backend and the model. Empty when the binary will not say.
const versions = new Map();
export function cliVersion(bin) {
  if (!versions.has(bin)) {
    let v = "";
    try {
      v = execFileSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 })
        .split("\n")[0].trim().slice(0, 100);
    } catch { v = ""; }
    versions.set(bin, v);
  }
  return versions.get(bin);
}

// The sign-in check is recorded nowhere — it answers one question and is discarded — so it
// asks nothing about the CLI's version and spawns the binary exactly once.
function recorded(opts) {
  return opts.stage !== "preflight";
}

// The model a Claude session reports having used. `modelUsage` names every model the
// session called, which can include a small one used for housekeeping, so the one that
// cost the most is the one that did the work.
function claudeModel(j) {
  const usage = j?.modelUsage;
  if (!usage || typeof usage !== "object") return "";
  const ranked = Object.entries(usage).sort((a, b) => (b[1]?.costUSD ?? 0) - (a[1]?.costUSD ?? 0));
  return ranked[0]?.[0] ?? "";
}

// The backend and model a turn runs on. `claude` with the CLI's own default model is what
// a caller that names nothing gets, which is what every turn was before there was a choice.
export function normaliseAgent(agent) {
  return { backend: agent?.backend || "claude", model: agent?.model || "" };
}

// Claude's `-p --output-format json` result: one JSON object for the whole session.
function parseClaudeOutput(stdout) {
  let j;
  try { j = JSON.parse(stdout); } catch { return null; }
  return { ok: !j.is_error, text: j.result ?? "", cost: j.total_cost_usd ?? 0, turns: j.num_turns ?? 0, sessionId: j.session_id ?? "", raw: j, model: claudeModel(j) };
}

// Whether a sign-in is there to be used, asked the way each CLI allows without reading a
// credential: for Claude, whether the file exists at all; for Codex, what `codex login
// status` says against the pipeline's own home, reduced to fixed words so nothing the CLI
// prints about an account is repeated.
function claudeSignIn() {
  const home = ensureConfigHome();
  const present = existsSync(join(home, ".credentials.json"));
  return present
    ? { ok: true, said: "a sign-in is present in the pipeline's config home" }
    : { ok: false, said: "no sign-in: run `claude` and sign in, then run this again" };
}

function codexSignIn() {
  let out = "";
  let ok = false;
  try {
    out = execFileSync(codexBin(), ["login", "status"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: ensureCodexHome() }, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
    ok = true;
  } catch (e) { out = `${e.stdout ?? ""}`; }
  if (ok && /chatgpt/i.test(out)) return { ok: true, said: "signed in with ChatGPT" };
  if (ok && /api key/i.test(out)) return { ok: false, said: "signed in with an API key; the pipeline signs in with ChatGPT only: run `codex login` and choose ChatGPT" };
  return { ok: false, said: "not signed in: run `codex login` and choose ChatGPT, then run this again" };
}

// The agent backends, each behind the same interface: the binary it spawns, the home it
// prepares (`src/runner/config-home.mjs`), the arguments for one turn, how its output is
// read, what a failed sign-in is told, how its sign-in is checked without spending a turn,
// and a line describing it. `runAgent` knows nothing about either beyond this.
//
// `stopAfterMs` is the ceiling the runner enforces for a CLI with no turn cap of its own;
// Claude has one (`--max-turns`) and gets none.
export const BACKENDS = {
  claude: {
    name: "claude",
    describe: "Claude Code CLI (`claude -p`), signed in with the operator's own Claude login",
    bin: claudeBin,
    ensureHome: ensureConfigHome,
    buildArgs,
    parse: parseClaudeOutput,
    unreadable: "non-JSON output",
    advice: AUTH_ADVICE,
    maxBuffer: 64 * 1024 * 1024,
    stopAfterMs: () => undefined,
    signIn: claudeSignIn,
  },
  codex: {
    name: "codex",
    describe: "OpenAI Codex CLI (`codex exec`), signed in with the operator's own ChatGPT sign-in",
    bin: codexBin,
    ensureHome: ensureCodexHome,
    buildArgs: buildCodexArgs,
    parse: parseCodexOutput,
    unreadable: "no JSONL events",
    advice: CODEX_AUTH_ADVICE,
    maxBuffer: 256 * 1024 * 1024,
    stopAfterMs: (opts) => opts.wallClockMs ?? codexWallClockMs(opts.maxTurns ?? DEFAULT_MAX_TURNS),
    signIn: codexSignIn,
  },
};

export function backendFor(name) {
  const b = BACKENDS[name];
  if (!b) throw new Error(`unknown agent backend ${name}: expected one of ${Object.keys(BACKENDS).join(", ")}`);
  return b;
}

// What a record of a turn carries: its cost, its turns, its session and what ran it. Every
// journal entry and gate file is written from this one shape.
export function metricsOf(r) {
  return { cost: r?.cost ?? 0, turns: r?.turns ?? 0, session: r?.sessionId ?? "", ...(r?.engine ? { engine: r.engine } : {}) };
}

// Every turn returns `engine`: the backend, the model (the one the CLI reports having used
// where it reports one, otherwise the one configured, otherwise empty — the CLI chose), and
// the CLI's version. It is what every record of the turn says ran the work.
export async function runAgent(opts) {
  const agent = normaliseAgent(opts.agent);
  if (process.env.SDLC_EXECUTOR === "mock") return runMock(opts, agent);
  const backend = backendFor(agent.backend);
  const bin = backend.bin();
  const { args, env, input } = backend.buildArgs({ ...opts, model: agent.model }, backend.ensureHome());
  // Asked before the session rather than after it, so the record names the binary that is
  // about to run and nothing the version probe does can land on top of the session's work.
  const version = recorded(opts) ? cliVersion(bin) : "";
  const limitMs = backend.stopAfterMs(opts);
  const { stdout, stopped } = await new Promise((resolve, reject) => {
    const child = execFile(bin, args, { cwd: opts.cwd, env, maxBuffer: backend.maxBuffer, ...(limitMs ? { timeout: limitMs, killSignal: "SIGTERM" } : {}) }, (err, out, stderr) => {
      if (limitMs && err?.killed) return resolve({ stdout: out ?? "", stopped: true });
      if (err && !out) return reject(new Error(withAuthAdvice(`${backend.name} failed: ${stderr || err.message}`, backend.advice)));
      resolve({ stdout: out, stopped: false });
    });
    // A child that exits before reading all of stdin (a crash, a non-zero exit before
    // the prompt is fully drained) raises 'error' on the stream; left unhandled that is
    // an uncaught exception that would crash this process instead of surfacing through
    // the exec callback's own err/stderr above, which is where a failure like that
    // already gets reported.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
  const parsed = backend.parse(stdout);
  const engine = { backend: backend.name, model: parsed?.model || agent.model, version };
  // A session the runner ended is a failed turn, and says how it ended in the CLI's own
  // vocabulary (`endedBecause`), with whatever it had reported by then.
  if (stopped) {
    const minutes = Math.round(limitMs / 6000) / 10;
    return { ok: false, text: `the session was stopped at its wall-clock ceiling of ${minutes} minutes: ${backend.name} has no turn cap, so the runner ends a session that runs longer than its turn ceiling allows.`,
      cost: parsed?.cost ?? 0, turns: parsed?.turns ?? 0, sessionId: parsed?.sessionId ?? "",
      raw: { ...(parsed?.raw ?? {}), subtype: undefined, terminal_reason: "wall_clock_limit" }, engine };
  }
  if (!parsed) throw new Error(withAuthAdvice(`${backend.name} returned ${backend.unreadable}:\n${stdout.slice(0, 500)}`, backend.advice));
  // The advice is attached to a FAILED result only. A stage that succeeded while
  // writing about sign-in screens returns text that goes on to the journal and the
  // proposal page, and an explanation of how the pipeline authenticates does not belong
  // in a stage's own account of what it built.
  const { model: _model, ...result } = parsed;
  return { ...result, text: result.ok ? result.text : withAuthAdvice(result.text, backend.advice), engine };
}

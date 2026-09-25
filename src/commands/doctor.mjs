import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkConfig } from "../checks/config.mjs";
import { checkBriefs } from "../checks/briefs.mjs";
import { checkConditions } from "../checks/conditions.mjs";
import { defaultNamesPath } from "../checks/egress.mjs";
import { composeVersion } from "../oracle/compose.mjs";
import { stagesFor } from "../profiles.mjs";
import { STAGES_BY_NAME } from "../stages/registry.mjs";
import { agentsInUse, agentFor, codexRefusal } from "../runner/agents.mjs";
import { backendFor, cliVersion } from "../runner/executor.mjs";
import { COMMANDS } from "../cli.mjs";

const VERSION_ARGS = { node: ["--version"], git: ["--version"], gh: ["--version"], claude: ["--version"], docker: ["--version"] };
const OPTIONAL_TOOLS = new Set(["gh", "claude", "docker"]);

export function toolReport(names) {
  return names.map((name) => {
    try { const v = execFileSync(name, VERSION_ARGS[name] ?? ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")[0]; return { name, found: true, version: v.trim() }; }
    catch { return { name, found: false }; }
  });
}

function denyListPresent(dir) {
  const p = join(dir, ".claude", "settings.json");
  try { return JSON.parse(readFileSync(p, "utf8")).permissions?.deny?.some((d) => d.startsWith("Bash(git push")) ?? false; } catch { return false; }
}
function nameListState() {
  try { const n = readFileSync(defaultNamesPath(), "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).length; return n ? `${n} names` : "empty"; }
  catch { return "missing"; }
}

// How to get each backend's CLI onto a machine and signed in, for the line that says it is
// missing. A subscription sign-in in both cases: the pipeline never uses an API key.
const INSTALL = {
  claude: "install Claude Code, then run `claude` and sign in",
  codex: "install it with `npm install -g @openai/codex`, then run `codex login` and choose ChatGPT",
};

function listed(names) {
  return names.join(", ");
}

// What the project's agent turns will run on (`src/runner/agents.mjs`), and whether this
// machine can run them: one line per backend in use naming the stages and gates it runs and
// the models configured for it, one line per backend saying whether its CLI is installed and
// signed in, and one line per stage the chosen backend will refuse. Reported, never a
// failure of `doctor` itself: a machine may check a project whose turns it never runs.
function agentLines(config) {
  const out = [];
  if (!config) return [["warn", "agents not resolved: the config is not valid"]];
  if (process.env.SDLC_AGENT_BACKEND) out.push(["warn", `agents SDLC_AGENT_BACKEND=${process.env.SDLC_AGENT_BACKEND} overrides policy.agents in this shell`]);
  let names;
  try {
    names = stagesFor(config.profile).filter((n) => STAGES_BY_NAME[n]?.implemented && STAGES_BY_NAME[n].agent !== false);
  } catch { names = []; }
  let used;
  try { used = agentsInUse(config, process.env, names); } catch (e) { return [...out, ["FAIL", `agents ${e.message}`]]; }
  const allRulings = used.flatMap((u) => u.rulings).sort();
  for (const u of used) {
    const all = used.length === 1;
    const runs = all
      ? `every stage with an agent turn and every agent ruling${allRulings.length ? ` (${listed(allRulings)})` : ""}`
      : [u.stages.length ? listed(u.stages) : "", u.rulings.length ? `rulings at ${listed(u.rulings)}` : ""].filter(Boolean).join(" and ");
    out.push(["ok  ", `agents ${u.backend} runs ${runs}; model: ${listed(u.models)}`]);
  }
  for (const u of used) {
    const backend = backendFor(u.backend);
    const version = cliVersion(backend.bin());
    if (!version) { out.push(["warn", `${u.backend} not found: ${INSTALL[u.backend]}`]); continue; }
    const signIn = backend.signIn();
    out.push([signIn.ok ? "ok  " : "warn", `${u.backend} ${version}, ${signIn.said}`]);
  }
  for (const name of names) {
    if (!codexRefusal(STAGES_BY_NAME[name], config, agentFor(config, name))) continue;
    out.push(["warn", `codex refuses ${name}: its tool allowlist gives it no shell; set policy.agents.stages.${name}.accept_weaker: true to run it there, or run it on claude`]);
  }
  return out;
}

COMMANDS.doctor = async ({ pos }) => {
  const dir = resolve(pos[0] ?? process.cwd());
  const tools = toolReport(["node", "git", "gh", "claude", "docker"]);
  for (const t of tools) {
    const status = t.found ? "ok  " : (OPTIONAL_TOOLS.has(t.name) ? "warn" : "FAIL");
    console.log(`${status} ${t.name} ${t.version ?? "(not found)"}`);
  }
  // `docker compose` is a separate binary check from plain `docker` above (a machine can
  // have one without the other — an old standalone `docker-compose` plugin, say) and
  // `sdlc oracle up` needs it specifically, so it gets its own report line rather than
  // being folded into the `docker --version` row.
  const dc = composeVersion();
  console.log(`${dc.found ? "ok  " : "warn"} docker compose ${dc.version ?? "(not found)"}`);
  const deny = denyListPresent(dir);
  console.log(`${deny ? "ok  " : "warn"} agent deny list ${deny ? "present in .claude/settings.json" : "missing: re-run sdlc init"}`);
  const nl = nameListState();
  console.log(`${nl === "missing" || nl === "empty" ? "warn" : "ok  "} egress name list ${nl} (${defaultNamesPath()})`);
  // Whether the sandbox sign-in password is in the environment, never what it is: a
  // `sandbox-idp` target cannot be bound or calibrated without it, and both stages refuse
  // up front rather than spending a session on sign-in failures. A project with no
  // `sandbox-idp` target never needs it, so an unset variable is a warning, not a failure.
  const sandbox = !!process.env.SDLC_SANDBOX_PASSWORD;
  console.log(`${sandbox ? "ok  " : "warn"} SDLC_SANDBOX_PASSWORD ${sandbox ? "set" : "not set (needed only for a sandbox-idp target)"}`);
  const cfg = checkConfig(dir);
  console.log(`${cfg.ok ? "ok  " : "FAIL"} config ${cfg.messages.join("; ")}`);
  for (const [status, line] of agentLines(cfg.ok ? cfg.config : null)) console.log(`${status} ${line}`);
  // What a ruling asked for and nobody has accounted for. A warning while it is merely
  // owed — the ordinary state between a return and the revision that answers it — and a
  // failure where an approval has gone past it, which is a record asserting two things that
  // cannot both be true.
  const conditions = checkConditions(dir);
  const owed = conditions.messages.length + conditions.warnings.length;
  console.log(`${conditions.ok ? (owed ? "warn" : "ok  ") : "FAIL"} ruling conditions ${owed ? `${owed} outstanding` : "none outstanding"}`);
  for (const m of [...conditions.messages, ...conditions.warnings]) console.log(`     ${m}`);
  // A persona brief that is behind the pipeline's own copy rules by instructions the
  // pipeline has since corrected, and reads as a complete brief while it does it. Never
  // a failure — a project may have written its own text into one on purpose — and never
  // silent either.
  const briefs = checkBriefs(dir);
  console.log(`${briefs.warnings.length ? "warn" : "ok  "} persona briefs ${briefs.warnings.length ? briefs.warnings.join("; ") : "current with the pipeline's templates"}`);
  const required = tools.filter((t) => ["node", "git"].includes(t.name)).every((t) => t.found);
  return required && cfg.ok && conditions.ok ? 0 : 1;
};

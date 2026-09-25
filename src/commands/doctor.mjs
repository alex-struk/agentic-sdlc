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
import { agentsInUse, stageAgent, rulingAgent, codexRefusal, isolationRefusal } from "../runner/agents.mjs";
import { dockerStatus, imageId, agentImageTag, proxyImageTag, shortId, leftoverSessions } from "../runner/container.mjs";
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
  let stages;
  let rulings;
  try {
    stages = names.map((name) => ({ name, stage: STAGES_BY_NAME[name], agent: stageAgent(config, STAGES_BY_NAME[name]) }));
    rulings = Object.entries(config?.policy?.gates ?? {}).filter(([, g]) => String(g?.holder ?? "").startsWith("agent:"))
      .map(([gate, g]) => ({ gate, agent: rulingAgent(config, { gate, persona: g.holder.slice("agent:".length) }) }));
  } catch (e) { return [...out, ["FAIL", `isolation ${e.message}`]]; }
  for (const { name, stage, agent } of stages) {
    if (!codexRefusal(stage, config, agent)) continue;
    out.push(["warn", `codex refuses ${name}: codex cannot hold it to its tool allowlist; set policy.agents.stages.${name}.accept_weaker: true to run it there, or run it on claude`]);
  }
  return [...out, ...isolationLines(config, stages, rulings)];
}

// Where each stage's turns run, and whether this machine can run the ones that are isolated
// (`docs/decisions/0061`): Docker, the images, anything a stopped run left behind, and per
// stage (and per isolated ruling) the backend, the isolation and the hosts it may reach.
function where(agent) {
  return agent.isolation === "container"
    ? `${agent.backend}, in a container (${agent.isolationFrom}), egress ${agent.egress}: ${agent.allow.join(", ")}`
    : `${agent.backend}, on the host`;
}

function isolationLines(config, stages, rulings) {
  const out = [];
  const isolated = [...stages.filter((s) => s.agent.isolation === "container"), ...rulings.filter((r) => r.agent.isolation === "container")];
  for (const { name, stage, agent } of stages) {
    const refusal = isolationRefusal(stage, config, agent);
    out.push(refusal ? ["warn", `stage ${name}: ${refusal}`] : ["ok  ", `stage ${name}: ${where(agent)}`]);
  }
  for (const { gate, agent } of rulings) if (agent.isolation === "container") out.push(["ok  ", `ruling ${gate}: ${where(agent)}`]);
  if (!isolated.length) return out;
  const docker = dockerStatus();
  if (!docker.ok) {
    const turns = isolated.map((t) => t.name ?? `ruling ${t.gate}`).join(", ");
    return [...out, ["warn", `isolation ${docker.said}; ${turns} will be refused until it is`]];
  }
  out.push(["ok  ", `isolation docker ${docker.version} answers, for the turns that run in a container`]);
  const image = (label, tag) => {
    const id = imageId(tag);
    return id ? ["ok  ", `isolation ${label} ${tag} built (${shortId(id)})`]
      : ["warn", `isolation ${label} ${tag} not built: it is built on first use, or now with \`sdlc isolation build\``];
  };
  for (const backend of [...new Set(isolated.map((t) => t.agent.backend))]) out.push(image(`${backend} image`, agentImageTag(backend)));
  out.push(image("egress proxy image", proxyImageTag()));
  const left = leftoverSessions();
  if (left.containers.length) {
    out.push(["warn", `isolation ${left.containers.length} session containers left behind by a run that did not finish: remove them with \`sdlc isolation clean\``]);
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

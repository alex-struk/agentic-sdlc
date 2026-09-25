import { backendFor, BACKENDS } from "./executor.mjs";
import { grantsShell } from "./codex.mjs";
import { dockerStatus } from "./container.mjs";

// Which agent backend, and which model, does a turn run on.
//
// `policy.agents` in the project's config names it, and being in `policy` is what makes a
// change to it a policy change, ruled at G-POL under `main`'s policy (`docs/decisions/0043`):
// it changes who does the work, the same kind of decision as who holds a gate. The layers,
// each overriding the one before:
//
//   1. claude, with the CLI's own default model — what a project that says nothing gets;
//   2. `policy.agents.backend` / `.model` — the project's default for every turn;
//   3. the turn's own entry — `policy.agents.stages.<stage>` for a stage,
//      `policy.agents.rulings.<persona>` and then `policy.agents.rulings.<gate>` for a ruling,
//      so a gate's entry is the more specific of the two;
//   4. `SDLC_AGENT_BACKEND` / `SDLC_AGENT_MODEL` — an operator's override for one run.
//
// A model belongs to the backend it is written beside: a layer that changes the backend and
// names no model drops the model it inherited, since a Claude model name means nothing to
// Codex and the reverse. `from` names the layer that decided, for a person reading why.

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;

function apply(choice, entry, from) {
  if (!entry || (entry.backend === undefined && entry.model === undefined)) return choice;
  const backend = entry.backend ?? choice.backend;
  const model = entry.model ?? (backend === choice.backend ? choice.model : "");
  return { backend, model, from };
}

function fromEnv(choice, env) {
  let next = choice;
  const backend = env.SDLC_AGENT_BACKEND;
  if (backend) {
    if (!BACKENDS[backend]) throw new Error(`SDLC_AGENT_BACKEND is ${backend}, which is not an agent backend: expected one of ${Object.keys(BACKENDS).join(", ")}`);
    next = { backend, model: backend === choice.backend ? choice.model : "", from: "SDLC_AGENT_BACKEND" };
  }
  const model = env.SDLC_AGENT_MODEL;
  if (model) {
    if (!MODEL.test(model)) throw new Error(`SDLC_AGENT_MODEL is not a model name: letters, digits and . _ : / @ [ ] - only`);
    next = { ...next, model, from: backend ? next.from : "SDLC_AGENT_MODEL" };
  }
  return next;
}

function base(config) {
  const a = config?.policy?.agents;
  return apply({ backend: "claude", model: "", from: "default" }, a, "policy.agents");
}

// The backend and model a stage's turns run on: its first turn and every repair turn.
export function agentFor(config, stageName, env = process.env) {
  const entry = config?.policy?.agents?.stages?.[stageName];
  return fromEnv(apply(base(config), entry, `policy.agents.stages.${stageName}`), env);
}

// The backend and model a persona's ruling turn runs on.
export function rulingAgentFor(config, { gate, persona }, env = process.env) {
  const rulings = config?.policy?.agents?.rulings ?? {};
  let choice = base(config);
  if (persona) choice = apply(choice, rulings[persona], `policy.agents.rulings.${persona}`);
  if (gate) choice = apply(choice, rulings[gate], `policy.agents.rulings.${gate}`);
  return fromEnv(choice, env);
}

// ---- isolation ------------------------------------------------------------------------------
//
// Whether a turn runs in a throwaway container, and which hosts it may reach from there
// (`docs/decisions/0061-an-agent-session-in-a-container.md`). Resolved beside the backend and
// in the same layers, each overriding the one before:
//
//   1. the default: `container` for a stage on codex that declares a tool allowlist and can
//      be isolated — exactly the stages 0060 refuses on codex — and `none` for everything
//      else, every ruling included;
//   2. `policy.agents.isolation` — the project's setting for every turn;
//   3. the turn's own entry — `policy.agents.stages.<stage>.isolation`, or for a ruling
//      `policy.agents.rulings.<persona>` and then `.<gate>`;
//   4. `SDLC_AGENT_ISOLATION=container` — an operator isolating one run. It turns isolation
//      on and never off: a value that would run a turn with less than the policy requires is
//      refused, not applied.
//
// It is under `policy` for the reason the backend is: it changes what a session can reach,
// so changing it is ruled at G-POL.

export const ISOLATIONS = ["container", "none"];

// The allowlists every project has without writing them. `model` adds nothing to the
// backend's own endpoints; `registry` adds the public npm registry, for a stage whose shell
// installs packages. A project redefines either, or adds its own, under
// `policy.agents.allowlists`.
export const BUILT_IN_ALLOWLISTS = { model: [], registry: ["registry.npmjs.org"] };

export function allowlistsFor(config) {
  return { ...BUILT_IN_ALLOWLISTS, ...(config?.policy?.agents?.allowlists ?? {}) };
}

// The hosts a session may reach: its backend's endpoints, then the named list's hosts.
function allowFor(config, backend, egress) {
  const list = allowlistsFor(config)[egress];
  if (!list) throw new Error(`egress allowlist ${egress} is not defined: name one of ${Object.keys(allowlistsFor(config)).join(", ")}, or define it under policy.agents.allowlists`);
  const hosts = [...(backendFor(backend).endpoints ?? [])];
  for (const h of list) if (!hosts.includes(h)) hosts.push(h);
  return hosts;
}

function isolationFromEnv(choice, env) {
  const v = env.SDLC_AGENT_ISOLATION;
  if (!v) return choice;
  if (v !== "container") {
    throw new Error(`SDLC_AGENT_ISOLATION is ${v}: it can only turn isolation on (SDLC_AGENT_ISOLATION=container). Turning it off is a policy change: policy.agents.isolation or policy.agents.stages.<stage>.isolation`);
  }
  return { isolation: "container", from: "SDLC_AGENT_ISOLATION" };
}

function layer(choice, entry, from) {
  return entry?.isolation ? { isolation: entry.isolation, from } : choice;
}

function withIsolation(config, agent, choice, egress) {
  if (choice.isolation !== "container") return { ...agent, isolation: "none", isolationFrom: choice.from, egress: null, allow: [] };
  return { ...agent, isolation: "container", isolationFrom: choice.from, egress, allow: allowFor(config, agent.backend, egress) };
}

// Why a stage cannot run in a container on this project, or null. A stage declares it as
// `isolationBlocker(config)` when its work needs something on the host that an isolated
// session is denied by construction — the host's Docker, a browser the image does not carry.
function blockerOf(stage, config) {
  return typeof stage?.isolationBlocker === "function" ? stage.isolationBlocker(config) : null;
}

// The backend, model and isolation a stage's turns run on: its first turn and every repair
// turn. `stage` is the stage's declaration, since the default depends on its allowlist.
export function stageAgent(config, stage, env = process.env) {
  const agent = agentFor(config, stage.name, env);
  const agents = config?.policy?.agents ?? {};
  const entry = agents.stages?.[stage.name];
  const isolates = agent.backend === "codex" && (stage.allowedTools ?? []).length > 0 && !blockerOf(stage, config);
  let choice = { isolation: isolates ? "container" : "none", from: "default" };
  choice = layer(choice, agents, "policy.agents");
  choice = layer(choice, entry, `policy.agents.stages.${stage.name}`);
  choice = isolationFromEnv(choice, env);
  return withIsolation(config, agent, choice, entry?.egress ?? stage.egress ?? "model");
}

// The backend, model and isolation a persona's ruling turn runs on.
export function rulingAgent(config, { gate, persona }, env = process.env) {
  const agent = rulingAgentFor(config, { gate, persona }, env);
  const agents = config?.policy?.agents ?? {};
  const rulings = agents.rulings ?? {};
  let choice = layer({ isolation: "none", from: "default" }, agents, "policy.agents");
  if (persona) choice = layer(choice, rulings[persona], `policy.agents.rulings.${persona}`);
  if (gate) choice = layer(choice, rulings[gate], `policy.agents.rulings.${gate}`);
  choice = isolationFromEnv(choice, env);
  const egress = (gate && rulings[gate]?.egress) || (persona && rulings[persona]?.egress) || "model";
  return withIsolation(config, agent, choice, egress);
}

// Why a stage set to run in a container cannot, or null. Refused rather than run on the host:
// a turn the policy says is isolated never runs without it.
export function isolationRefusal(stage, config, agent) {
  if (agent?.isolation !== "container") return null;
  const blocker = blockerOf(stage, config);
  if (!blocker) return null;
  return [
    `${stage.name} is set to run in a container (${agent.isolationFrom}), and it cannot: ${blocker}`,
    `Set policy.agents.stages.${stage.name}.isolation: none to run it on the host${agent.backend === "codex" ? `, which on codex also needs policy.agents.stages.${stage.name}.accept_weaker: true` : ""}, or run it on claude.`,
  ].join(" ");
}

// Whether this machine can run a turn in a container at all, checked with the pre-checks, before
// anything is spent: a turn the policy isolates is refused rather than run on the host when
// Docker is not there. A mock turn reaches no container and is not checked.
export function isolationUnavailable(agent, status = () => dockerStatus()) {
  if (agent?.isolation !== "container" || process.env.SDLC_EXECUTOR === "mock") return null;
  const s = status();
  return s.ok ? null : `this turn runs in a container (${agent.isolationFrom}), and ${s.said}. Start Docker, or change the isolation in policy.agents (a policy change ruled at G-POL).`;
}

// Why a stage may not run on Codex as the project has it configured, or null.
//
// A stage that declares a tool allowlist depends on it. Where the list gives no shell, the
// session opens files only through the file tools, inside its workspace, and that is what
// keeps a blind stage blind — the test writer never reads the application, the designer never
// reads the acceptance suite. Where it gives a narrowed shell, the patterns are the whole
// grant: the commands the stage exists to run and nothing else. Codex has no tool allowlist.
// Every Codex session has a full shell, and on the host its sandbox limits what the session
// writes, not what it reads or runs; the project's deny list is a Claude setting Codex never
// reads (`docs/decisions/0060-a-second-agent-backend.md`).
//
// A container restores the guarantee by construction: the session can read only what is
// mounted, which is its workspace, and reach only the hosts its allowlist names
// (`docs/decisions/0061`). So an isolated stage is not refused. On the host, the stage is
// weaker, and a project gets it only by saying so, stage by stage, in a policy change.
//
// A stage with no allowlist is confined on Claude by the project's guard and deny list and
// runs on Codex: the guard reaches a Codex session through its hook. A ruling is never
// refused: its allowlist exists to keep it read-only, and a Codex ruling runs in a read-only
// sandbox, which holds that at the operating system rather than in the session.
export function codexRefusal(stage, config, agent) {
  if (agent?.backend !== "codex") return null;
  if (agent.isolation === "container") return null;
  const tools = stage.allowedTools ?? [];
  if (!tools.length) return null;
  if (config?.policy?.agents?.stages?.[stage.name]?.accept_weaker === true) return null;
  const chose = agent.from && agent.from !== "default" ? ` (${agent.from} chose codex)` : "";
  const held = grantsShell(tools)
    ? `On claude its session runs only the tools its allowlist names (${tools.join(", ")}), so its shell runs only those commands; on codex it could run any command the sandbox allows, with the network access its commands need.`
    : `On claude its session has no shell and opens files only through the file tools, inside its workspace; on codex it has a shell and could read outside its workspace, and nothing would record that it had.`;
  const blocker = blockerOf(stage, config);
  const isolate = blocker
    ? `It cannot run in a container on this project, which is what would hold it to its workspace on codex: ${blocker}`
    : `Run it in a container (policy.agents.stages.${stage.name}.isolation: container), which holds it to its workspace and its egress allowlist,`;
  return [
    `${stage.name} is set to run on codex${chose}, and it cannot run there as configured.`,
    `Codex has no tool allowlist: every Codex session has a full shell, and on the host its sandbox limits what it writes, not what it reads or runs.`,
    held,
    blocker
      ? `${isolate} Run it on claude (policy.agents.stages.${stage.name}.backend: claude), or accept the weaker stage with policy.agents.stages.${stage.name}.accept_weaker: true, a policy change ruled at G-POL.`
      : `${isolate} run it on claude (policy.agents.stages.${stage.name}.backend: claude), or accept the weaker stage with policy.agents.stages.${stage.name}.accept_weaker: true, a policy change ruled at G-POL.`,
  ].join(" ");
}

// Each backend the project's turns will run on, with the stages and gates it runs and the
// models configured for it: what `doctor` reports, and what a person reads to know which
// CLI has to be installed and signed in. `stageNames` are the stages with an agent turn.
export function agentsInUse(config, env = process.env, stageNames = []) {
  const by = new Map();
  const entry = (backend) => {
    if (!by.has(backend)) by.set(backend, { backend, describe: backendFor(backend).describe, models: new Set(), stages: [], rulings: [] });
    return by.get(backend);
  };
  for (const name of stageNames) {
    const a = agentFor(config, name, env);
    const e = entry(a.backend);
    e.stages.push(name);
    e.models.add(a.model || "the CLI's default model");
  }
  for (const [gate, g] of Object.entries(config?.policy?.gates ?? {})) {
    if (!String(g?.holder ?? "").startsWith("agent:")) continue;
    const a = rulingAgentFor(config, { gate, persona: g.holder.slice("agent:".length) }, env);
    const e = entry(a.backend);
    e.rulings.push(gate);
    e.models.add(a.model || "the CLI's default model");
  }
  return [...by.values()].map((e) => ({ ...e, models: [...e.models] }));
}

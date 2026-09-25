import { backendFor, BACKENDS } from "./executor.mjs";
import { grantsShell } from "./codex.mjs";

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

// Why a stage may not run on Codex as the project has it configured, or null.
//
// A stage that declares a tool allowlist depends on it. Where the list gives no shell, the
// session opens files only through the file tools, inside its workspace, and that is what
// keeps a blind stage blind — the test writer never reads the application, the designer never
// reads the acceptance suite. Where it gives a narrowed shell, the patterns are the whole
// grant: the commands the stage exists to run and nothing else. Codex has no tool allowlist.
// Every Codex session has a full shell, and its sandbox limits what the session writes, not
// what it reads or runs; the project's deny list is a Claude setting Codex never reads. The
// runner still seals the workspace and checks everything that comes back out of it, but it
// cannot see what a session read or ran. That is a weaker stage, and a project gets one only
// by saying so, stage by stage, in a policy change
// (`docs/decisions/0060-a-second-agent-backend.md`).
//
// A stage with no allowlist is confined on Claude by the project's guard and deny list and
// runs on Codex: the guard reaches a Codex session through its hook. A ruling is never
// refused: its allowlist exists to keep it read-only, and a Codex ruling runs in a read-only
// sandbox, which holds that at the operating system rather than in the session.
export function codexRefusal(stage, config, agent) {
  if (agent?.backend !== "codex") return null;
  const tools = stage.allowedTools ?? [];
  if (!tools.length) return null;
  if (config?.policy?.agents?.stages?.[stage.name]?.accept_weaker === true) return null;
  const chose = agent.from && agent.from !== "default" ? ` (${agent.from} chose codex)` : "";
  const held = grantsShell(tools)
    ? `On claude its session runs only the tools its allowlist names (${tools.join(", ")}), so its shell runs only those commands; on codex it could run any command the sandbox allows, with the network access its commands need.`
    : `On claude its session has no shell and opens files only through the file tools, inside its workspace; on codex it has a shell and could read outside its workspace, and nothing would record that it had.`;
  return [
    `${stage.name} is set to run on codex${chose}, and it cannot run there as configured.`,
    `Codex has no tool allowlist: every Codex session has a full shell, and its sandbox limits what it writes, not what it reads or runs.`,
    held,
    `Run it on claude (policy.agents.stages.${stage.name}.backend: claude), or accept the weaker stage with policy.agents.stages.${stage.name}.accept_weaker: true, a policy change ruled at G-POL.`,
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

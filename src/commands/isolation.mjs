import { resolve } from "node:path";
import { checkConfig } from "../checks/config.mjs";
import { stagesFor } from "../profiles.mjs";
import { STAGES_BY_NAME } from "../stages/registry.mjs";
import { stageAgent, rulingAgent } from "../runner/agents.mjs";
import { AGENT_CLIS, buildAgentImage, buildProxyImage, cleanSessions } from "../runner/container.mjs";
import { COMMANDS } from "../cli.mjs";

// `sdlc isolation build [dir] [--backend claude|codex]` builds the images the project's
// isolated turns run on — the agent image for each backend they use, and the egress proxy —
// ahead of the first turn that would otherwise build them. `sdlc isolation clean [dir]` removes
// the session containers and networks a run that did not finish left behind
// (`docs/decisions/0061`).

// The backends the project's isolated turns run on: every stage in its profile with an agent
// turn, and every ruling an agent holds.
function isolatedBackends(config) {
  const names = stagesFor(config.profile).filter((n) => STAGES_BY_NAME[n]?.implemented && STAGES_BY_NAME[n].agent !== false);
  const agents = [
    ...names.map((n) => stageAgent(config, STAGES_BY_NAME[n])),
    ...Object.entries(config?.policy?.gates ?? {}).filter(([, g]) => String(g?.holder ?? "").startsWith("agent:"))
      .map(([gate, g]) => rulingAgent(config, { gate, persona: g.holder.slice("agent:".length) })),
  ];
  return [...new Set(agents.filter((a) => a.isolation === "container").map((a) => a.backend))];
}

async function build(dir, flags) {
  let backends;
  if (flags.backend) {
    if (!AGENT_CLIS[flags.backend]) throw new Error(`--backend ${flags.backend} is not an agent backend: expected one of ${Object.keys(AGENT_CLIS).sort().join(", ")}`);
    backends = [flags.backend];
  } else {
    const cfg = checkConfig(dir);
    if (!cfg.ok) throw new Error(`the config is not valid: ${cfg.messages.join("; ")}`);
    backends = isolatedBackends(cfg.config);
    if (!backends.length) {
      console.log("no turn in this project runs in a container, so there is no image to build; name one with --backend claude or --backend codex");
      return 0;
    }
  }
  for (const b of backends) console.log(`built ${buildAgentImage(b)} (${AGENT_CLIS[b].package}@${AGENT_CLIS[b].version})`);
  console.log(`built ${buildProxyImage()}`);
  return 0;
}

COMMANDS.isolation = async ({ pos, flags }) => {
  const [sub, target] = pos;
  const dir = resolve(target ?? process.cwd());
  if (sub === "build") return build(dir, flags);
  if (sub === "clean") {
    const left = cleanSessions();
    console.log(`removed ${left.containers.length} containers and ${left.networks.length} network${left.networks.length === 1 ? "" : "s"} left behind by isolated sessions`);
    return 0;
  }
  throw new Error("usage: sdlc isolation build [dir] [--backend claude|codex] | sdlc isolation clean");
};

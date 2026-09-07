import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkConfig } from "../checks/config.mjs";
import { defaultNamesPath } from "../checks/egress.mjs";
import { composeVersion } from "../oracle/compose.mjs";
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
  const cfg = checkConfig(dir);
  console.log(`${cfg.ok ? "ok  " : "FAIL"} config ${cfg.messages.join("; ")}`);
  const required = tools.filter((t) => ["node", "git"].includes(t.name)).every((t) => t.found);
  return required && cfg.ok ? 0 : 1;
};

import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { git, gitOk } from "../lib/git.mjs";
import { readText, writeText } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { COMMANDS } from "../cli.mjs";

const SDLC_AUTHOR = ["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost"];

export function rule(projectDir, name, verdict, { by, note = "" }) {
  projectDir = resolve(projectDir);
  if (!["approve", "return"].includes(verdict)) throw new Error("verdict must be approve or return");
  if (!by) throw new Error("rule needs --by <role or agent:persona>");
  const branch = `proposal/${name}`;
  if (!gitOk(["rev-parse", "--verify", branch], projectDir)) throw new Error(`no proposal branch ${branch}`);
  git(["checkout", "-q", branch], projectDir);
  const proposalPath = join(projectDir, ".sdlc", "proposals", `${name}.md`);
  const gateMatch = existsSync(proposalPath) ? readText(proposalPath).match(/^gate:\s*(\S+)/m) : null;
  if (!gateMatch) throw new Error(`proposal ${name} has no gate line`);
  const gate = gateMatch[1];
  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);
  const g = config.policy.gates[gate];
  if (!g) throw new Error(`gate ${gate} is not in policy`);
  const allowed = [g.holder, g.escalate_to].filter(Boolean);
  if (!allowed.includes(by)) throw new Error(`${by} is not a holder of ${gate} (allowed: ${allowed.join(", ")})`);
  const heldBy = by.startsWith("agent:") ? "agent" : "human";
  writeText(join(projectDir, ".sdlc", "gates", `${name}.yaml`),
    `gate: ${gate}\nverdict: ${verdict}\nby: ${by}\nheld_by: ${heldBy}\nnote: ${JSON.stringify(note)}\nat: ${new Date().toISOString()}\n`);
  appendRun(projectDir, `rule ${name} ${verdict} at ${gate} by ${by} (${heldBy})`);
  git(["add", "-A"], projectDir);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `rule(${gate}): ${name} ${verdict} by ${by}`], projectDir);
  if (verdict === "approve") {
    git(["checkout", "-q", "main"], projectDir);
    git([...SDLC_AUTHOR, "merge", "-q", "--no-ff", "-m", `merge: ${name} approved at ${gate} by ${by}`, branch], projectDir);
  }
  return { gate, verdict, heldBy };
}

COMMANDS.rule = async ({ pos, flags }) => {
  const r = rule(process.cwd(), pos[0], pos[1], { by: flags.by, note: flags.note ?? "" });
  console.log(`${pos[0]}: ${r.verdict} at ${r.gate}`); return 0;
};

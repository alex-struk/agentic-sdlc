import { resolve } from "node:path";
import { runChecks } from "../checks/index.mjs";
import { COMMANDS } from "../cli.mjs";

export function formatChecks(results) {
  return results.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.id}`
    + r.messages.map((m) => `\n    ${m}`).join("")
    + (r.warnings ?? []).map((m) => `\n    warning: ${m}`).join("")).join("\n");
}

COMMANDS.checks = async ({ pos, flags }) => {
  const dir = resolve(pos[0] ?? process.cwd());
  const results = await runChecks(dir, { self: !!flags.self });
  console.log(flags.json ? JSON.stringify(results, null, 2) : formatChecks(results));
  return results.every((r) => r.ok) ? 0 : 1;
};

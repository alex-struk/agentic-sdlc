import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fsx.mjs";

const COMMAND = "node node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false";

export async function acceptanceTypecheck(projectDir, { name, gate, revision }) {
  if (gate !== "G3" || !/^(derive-tests|bind-adapter)-/.test(name)) return null;
  const base = { revision, command: COMMAND, directory: "tests" };
  const unavailable = (output) => ({ ...base, status: "unavailable", exitCode: null, output });
  const cwd = join(projectDir, "tests");
  const manifest = join(cwd, "package.json");
  if (!existsSync(manifest)) return unavailable("tests/package.json is missing; no typecheck ran.");
  const { scripts = {} } = JSON.parse(readText(manifest));
  if (scripts.typecheck !== "tsc --noEmit" || scripts.pretypecheck || scripts.posttypecheck) {
    return unavailable("The harness does not use the supported tsc --noEmit script without lifecycle hooks; no typecheck ran.");
  }
  if (!existsSync(join(cwd, "tsconfig.json"))) {
    return unavailable("tests/tsconfig.json is missing; no typecheck ran.");
  }
  if (!existsSync(join(cwd, "node_modules", "typescript", "bin", "tsc"))) {
    return unavailable("TypeScript is not installed in tests/node_modules. Restore the harness dependencies outside the blind agent workspace; no typecheck ran.");
  }

  // Invoke only the installed compiler, never arbitrary package scripts or a shell.
  // Disabling incremental output keeps this evidence collection read-only.
  return new Promise((resolve) => {
    execFile(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false", "--pretty", "false"],
      { cwd, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        resolve({
          ...base,
          status: error ? "failed" : "passed",
          exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
          output: output || (error
            ? `Compiler process failed (${error.killed ? "timeout or termination" : error.code ?? "unknown error"}); no diagnostics were returned.`
            : "No diagnostics."),
        });
      });
  });
}

export function formatTypecheckEvidence(result) {
  if (!result) return "";
  const output = result.output.length > 18000
    ? `${result.output.slice(0, 18000)}\n[diagnostics truncated]` : result.output;
  return [
    `Proposal revision: \`${result.revision}\``,
    `Typecheck: **${result.status}**; exit code: ${result.exitCode ?? "none"}.`,
    `Command (in \`${result.directory}\`): \`${result.command}\``,
    "",
    ...output.split("\n").map((line) => `    ${line}`),
  ].join("\n");
}

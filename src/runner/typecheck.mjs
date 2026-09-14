import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fsx.mjs";

const COMMAND = "node node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false";

// The directory a G3 proposal is answerable for, relative to `tests/` — the same root
// the compiler prints its diagnostics against. An adapter owns its target's bindings; a
// derivation owns its domain's specs. Both names may carry a revision suffix (`-3`) and a
// derivation may carry `-stale` as well, and neither belongs to the directory name.
export function ownedDirectory(name) {
  const bind = /^bind-adapter-(.+?)(?:-\d+)?$/.exec(name ?? "");
  if (bind) return `adapters/${bind[1]}/`;
  const derive = /^derive-tests-(.+?)(?:-stale)?(?:-\d+)?$/.exec(name ?? "");
  if (derive) return `acceptance/${derive[1]}/`;
  return null;
}

export async function acceptanceTypecheck(projectDir, { name, gate, revision }) {
  if (gate !== "G3" || !/^(derive-tests|bind-adapter)-/.test(name)) return null;
  const base = { revision, command: COMMAND, directory: "tests", owned: ownedDirectory(name) };
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

// A whole-suite typecheck reports every domain's diagnostics, and one domain's errors can
// run to hundreds of lines. Truncating that list at a fixed size answers the wrong
// question: a reviewer ruling on one adapter or one domain needs its own diagnostics in
// full and needs to know that the rest belong to somebody else. So the owned directory's
// lines are never dropped, and everything outside it is reported as a count per directory
// — enough to see that the suite does not compile, without burying the part being ruled.
const DIAGNOSTIC = /^([^\s(]+)\(\d+,\d+\):/;

function directoryOf(line) {
  const m = DIAGNOSTIC.exec(line);
  if (!m) return null;
  const slash = m[1].lastIndexOf("/");
  return slash === -1 ? "" : m[1].slice(0, slash + 1);
}

export function splitDiagnostics(output, owned) {
  const mine = [];
  const elsewhere = new Map();
  for (const line of String(output ?? "").split("\n")) {
    const dir = directoryOf(line);
    if (dir === null || !owned) { mine.push(line); continue; }
    if (dir.startsWith(owned)) { mine.push(line); continue; }
    elsewhere.set(dir, (elsewhere.get(dir) ?? 0) + 1);
  }
  return { mine, elsewhere };
}

export function formatTypecheckEvidence(result) {
  if (!result) return "";
  const { mine, elsewhere } = splitDiagnostics(result.output, result.owned);
  const body = mine.join("\n");
  const shown = body.length > 18000 ? `${body.slice(0, 18000)}\n[diagnostics truncated]` : body;
  const others = [...elsewhere.entries()].sort((a, b) => b[1] - a[1])
    .map(([dir, n]) => `    ${dir || "(root)"}: ${n} ${n === 1 ? "diagnostic" : "diagnostics"}`);
  const head = [
    `Proposal revision: \`${result.revision}\``,
    `Typecheck: **${result.status}**; exit code: ${result.exitCode ?? "none"}.`,
    `Command (in \`${result.directory}\`): \`${result.command}\``,
  ];
  if (result.owned) head.push(`Diagnostics below are those under \`${result.owned}\`, which this proposal answers for.`);
  return [
    ...head,
    "",
    ...shown.split("\n").map((line) => `    ${line}`),
    ...(others.length ? ["", "Diagnostics elsewhere in the suite, which this proposal does not answer for:", "", ...others] : []),
  ].join("\n");
}

// The same compiler run as `acceptanceTypecheck`, made a post-check rather than evidence
// for a reviewer. A stage that writes TypeScript against a generated declaration file and
// has no shell cannot discover that it guessed a parameter name wrong: the surface says
// `open({ opportunityId })`, the criterion says "the opportunity", and a whole domain's
// tests can be written to the second without anything contradicting them until a reviewer
// reads a compiler report hours later. Run here, the contradiction arrives while the
// workspace is still open and a fix turn can act on it.
//
// A compiler is not a test runner, which is what keeps this inside the blindness rule
// (`docs/decisions/0007-calibrate-before-mass-derivation.md`): it reports that the code is
// ill-typed, never whether an assertion holds. Only diagnostics under the directory the
// stage answers for fail it — another domain's errors are not this run's to repair, and a
// stage that could be failed by them would be unable to finish at all.
export function typecheckPostCheck(projectDir, name) {
  const id = "typecheck";
  const cwd = join(projectDir, "tests");
  const tsc = join(cwd, "node_modules", "typescript", "bin", "tsc");
  // No compiler installed is not this stage's failure to report: `acceptanceTypecheck`
  // already tells the reviewer the typecheck was unavailable, and failing every run of
  // every stage on a missing dev dependency would be a worse answer than saying nothing.
  if (!existsSync(tsc)) return { id, ok: true, messages: [] };
  const owned = ownedDirectory(name);
  if (!owned) return { id, ok: true, messages: [] };
  let output = "";
  try {
    execFileSync(process.execPath, [tsc, "--noEmit", "--incremental", "false", "--pretty", "false"],
      { cwd, encoding: "utf8", timeout: 180000, maxBuffer: 1024 * 1024 * 8, stdio: ["ignore", "pipe", "pipe"] });
    return { id, ok: true, messages: [] };
  } catch (e) {
    if (e.code === "ETIMEDOUT" || e.signal) return { id, ok: true, messages: [] };
    output = [e.stdout, e.stderr].filter(Boolean).join("\n");
  }
  const { mine } = splitDiagnostics(output, owned);
  const errors = mine.filter((l) => l.includes("error TS"));
  if (!errors.length) return { id, ok: true, messages: [] };
  return {
    id,
    ok: false,
    messages: [`the acceptance suite does not compile; every diagnostic below is in ${owned}, which this run wrote:`, ...errors],
  };
}

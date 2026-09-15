// Compiling the design catalogue and scanning it for accessibility violations, run by the
// pipeline rather than by the agent that drew the screens.
//
// The design stage writes React and has no shell, so it cannot discover that a component
// it named is not exported, that a prop it passed does not exist, or that the markup it
// wrote fails an accessibility rule. Left there, every one of those is found by a reviewer
// reading source text, which is to say not found at all: the UX reviewer persona refused
// to approve a catalogue nothing had compiled and an unproven zero violations, and was
// right to (`docs/decisions/0009-a-catalogue-is-compiled-and-scanned.md`).
//
// Run here, after the stage's work is collected, the compiler and the scanner both report
// while the gate is still open, and their report is what the gate reads.
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const INSTALL_TIMEOUT = 20 * 60 * 1000;
const SCAN_TIMEOUT = 30 * 60 * 1000;

function exec(cmd, args, cwd, timeout) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  return { status: res.status, stderr: res.stderr || (res.error ? res.error.message : "") };
}

// The same staleness test `npm ci` makes itself: the lockfile against the snapshot a clean
// install leaves behind. Installing Storybook and the design system takes minutes, and a
// design run that reinstalled them every time would spend longer on its dependencies than
// on its screens.
function ensureDeps(designDir) {
  const lockfile = join(designDir, "package-lock.json");
  if (!existsSync(lockfile)) return exec("npm", ["install", "--no-audit", "--no-fund"], designDir, INSTALL_TIMEOUT);
  const snapshot = join(designDir, "node_modules", ".package-lock.json");
  const fresh = existsSync(snapshot) && statSync(snapshot).mtimeMs >= statSync(lockfile).mtimeMs;
  if (fresh) return { status: 0, stderr: "" };
  return exec("npm", ["ci", "--no-audit", "--no-fund"], designDir, INSTALL_TIMEOUT);
}

// Returns nothing. What it produces is `design/report.json`, which `checkDesignCompiles`
// and `checkDesignAccessibility` read — a failed scan is a report saying what failed, so
// there is no outcome here for a caller to act on that the checks do not already carry.
// A project with no design harness is left alone: the checks say the catalogue was never
// compiled, which is the accurate thing to tell a reviewer and is theirs to say, not this.
export function runCatalogueScan(projectDir) {
  const designDir = join(projectDir, "design");
  if (!existsSync(join(designDir, "package.json")) || !existsSync(join(designDir, "scan.mjs"))) return;
  ensureDeps(designDir);
  if (!existsSync(join(designDir, "node_modules"))) return;
  exec(process.execPath, ["scan.mjs"], designDir, SCAN_TIMEOUT);
}

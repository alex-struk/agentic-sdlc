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
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { catalogueFiles, surfacePageIds } from "../checks/design.mjs";

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

// Where the pictures go: inside `design/` so the ruler's Read reaches them, and ignored by
// git (`REQUIRED_IGNORES`) so a ruling neither commits them nor counts them as a change it made.
export const SCREENS_DIR = "screenshots";

// Pictures of one domain's screens, for whoever rules its design. The scanner renders each
// of the domain's stories and saves it; nothing is committed. Returns where the pictures
// are, or why there are none — a ruler is told either way, since one who is not told assumes
// the screens were looked at.
export function captureScreens(projectDir, domain, { exec: run = exec, ensure = ensureDeps } = {}) {
  const designDir = join(projectDir, "design");
  const result = (files, error = null) => ({ dir: `design/${SCREENS_DIR}`, files, error });
  const scanner = join(designDir, "scan.mjs");
  if (!existsSync(join(designDir, "package.json")) || !existsSync(scanner)) return result([], "this project has no design harness (design/scan.mjs)");
  if (!readFileSync(scanner, "utf8").includes("--screens")) return result([], "this project's design/scan.mjs cannot take screenshots; `sdlc init` installs the pipeline's current one");
  const pages = surfacePageIds(projectDir, domain);
  const stories = catalogueFiles(projectDir).filter((f) => pages.some((p) => f.startsWith(`${p}.`)));
  if (!stories.length) return result([], `no story in design/catalogue/ draws a page of the ${domain} domain`);
  const out = join(designDir, SCREENS_DIR);
  rmSync(out, { recursive: true, force: true });
  ensure(designDir);
  if (!existsSync(join(designDir, "node_modules"))) return result([], "the design harness's dependencies could not be installed");
  const r = run(process.execPath, ["scan.mjs", "--screens", SCREENS_DIR, "--only", stories.join(",")], designDir, SCAN_TIMEOUT);
  const files = existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(".png")).sort().map((f) => `design/${SCREENS_DIR}/${f}`) : [];
  if (files.length) return result(files);
  const said = (r.stderr ?? "").trim().split("\n").filter(Boolean).pop();
  return result([], `the screenshot run produced no pictures${said ? `: ${said}` : ""}`);
}

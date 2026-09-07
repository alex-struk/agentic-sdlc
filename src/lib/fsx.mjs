import { mkdirSync, readdirSync, statSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
export function ensureDir(p) { mkdirSync(p, { recursive: true }); }
export function readText(p) { return readFileSync(p, "utf8"); }
export function writeText(p, text) { ensureDir(dirname(p)); writeFileSync(p, text); }
export function copyTree(src, dst) {
  ensureDir(dst);
  for (const name of readdirSync(src)) {
    const s = join(src, name), d = join(dst, name);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else if (!existsSync(d)) copyFileSync(s, d);
  }
}

// `copyTree`'s "never overwrite" rule is right for laying down a template or a skill
// pack once, but wrong for collecting an agent's own output back out of an isolated
// workspace (`src/runner/workspace.mjs`'s `collect`): the workspace started as a copy of
// whatever the project already had, and an existing destination file is exactly the file
// the agent read and rewrote — a stage that updates `tests/acceptance/not-testable.yaml`,
// or rewrites an already-committed spec file on a `--stale` re-run, needs its edit to
// land, not be silently kept as the file it started from.
export function copyTreeOverwrite(src, dst) {
  ensureDir(dst);
  for (const name of readdirSync(src)) {
    const s = join(src, name), d = join(dst, name);
    if (statSync(s).isDirectory()) copyTreeOverwrite(s, d);
    else copyFileSync(s, d);
  }
}

import { mkdirSync, readdirSync, lstatSync, copyFileSync, existsSync, readFileSync, writeFileSync, readlinkSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
export function ensureDir(p) { mkdirSync(p, { recursive: true }); }
export function readText(p) { return readFileSync(p, "utf8"); }
export function writeText(p, text) { ensureDir(dirname(p)); writeFileSync(p, text); }
// `lstat`, not `stat`: a symlink is copied as a symlink. Following it instead turns a
// link to a file into a plain file holding that file's bytes, and a link to a directory
// into a real directory holding a copy of its contents — which breaks anything that
// resolves paths relative to where it thinks it lives. A package manager's `.bin` entries
// are exactly that: links whose targets `require` a sibling by a relative path.
function copyEntry(s, d, { overwrite, skip, recurse }) {
  const st = lstatSync(s);
  if (st.isSymbolicLink()) {
    if (existsSync(d) || lstatSync(d, { throwIfNoEntry: false })) {
      if (!overwrite) return;
      rmSync(d, { force: true });
    }
    symlinkSync(readlinkSync(s), d);
    return;
  }
  if (st.isDirectory()) { recurse(s, d); return; }
  if (overwrite || !existsSync(d)) copyFileSync(s, d);
}

function walk(src, dst, opts) {
  ensureDir(dst);
  for (const name of readdirSync(src)) {
    if (opts.skip?.has(name)) continue;
    copyEntry(join(src, name), join(dst, name), { ...opts, recurse: (s, d) => walk(s, d, opts) });
  }
}

export function copyTree(src, dst, opts = {}) {
  walk(src, dst, { ...opts, overwrite: false });
}

// `copyTree`'s "never overwrite" rule is right for laying down a template or a skill
// pack once, but wrong for collecting an agent's own output back out of an isolated
// workspace (`src/runner/workspace.mjs`'s `collect`): the workspace started as a copy of
// whatever the project already had, and an existing destination file is exactly the file
// the agent read and rewrote — a stage that updates `tests/acceptance/not-testable.yaml`,
// or rewrites an already-committed spec file on a `--stale` re-run, needs its edit to
// land, not be silently kept as the file it started from.
export function copyTreeOverwrite(src, dst, opts = {}) {
  walk(src, dst, { ...opts, overwrite: true });
}

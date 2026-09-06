import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { copyTree, ensureDir } from "../lib/fsx.mjs";

const MODES = {
  "project": null,
  "spec-only": ["spec", "tests/seed", "constitution.md", ".sdlc/config.yaml"],
  "blind-adapter": ["spec/contract", "tests/adapters", "tests/seed", "constitution.md"],
};

export function materialise(projectDir, mode) {
  if (!(mode in MODES)) throw new Error(`unknown workspace mode: ${mode}`);
  if (mode === "project") return { dir: projectDir, mode, cleanup() {} };
  const dir = mkdtempSync(join(tmpdir(), `sdlc-ws-${mode}-`));
  const paths = MODES[mode].filter((p) => existsSync(join(projectDir, p)));
  // git archive only pulls committed content, so an uncommitted edit in the project
  // does not leak into the workspace (and does not appear there either).
  const tar = execFileSync("git", ["archive", "HEAD", "--", ...paths], { cwd: projectDir, maxBuffer: 256 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  mkdirSync(join(dir, "tests", "acceptance"), { recursive: true });
  return { dir, mode, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

export function collect(projectDir, dir, paths) {
  for (const p of paths) if (existsSync(join(dir, p))) { ensureDir(join(projectDir, p)); copyTree(join(dir, p), join(projectDir, p)); }
}

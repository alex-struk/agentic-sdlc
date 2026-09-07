import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { copyTree, ensureDir } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { ensureSources } from "./sources.mjs";

// The pipeline-owned acceptance harness (its config, the `surface`/`mail` fixtures, and
// the generated types they re-export) — every blind workspace that runs the suite or
// writes against it needs all of this, so it is named once here and appended to both
// `spec-only` and `blind-adapter` below rather than repeated.
export const HARNESS = [
  "tests/package.json",
  "tests/tsconfig.json",
  "tests/playwright.config.ts",
  "tests/README.md",
  "tests/fixtures",
  "tests/generated",
];

const MODES = {
  "project": null,
  "spec-only": ["spec", "tests/seed", "constitution.md", ".sdlc/config.yaml", ...HARNESS, "tests/acceptance"],
  "blind-adapter": ["spec/contract", "tests/adapters", "tests/seed", "constitution.md", ...HARNESS],
  "with-sources": null,
};

export function materialise(projectDir, mode) {
  if (!(mode in MODES)) throw new Error(`unknown workspace mode: ${mode}`);
  if (mode === "project") return { dir: projectDir, mode, cleanup() {} };
  if (mode === "with-sources") {
    const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
    if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);
    ensureSources(projectDir, config);
    return { dir: projectDir, mode, cleanup() {} };
  }
  const dir = mkdtempSync(join(tmpdir(), `sdlc-ws-${mode}-`));
  const paths = MODES[mode].filter((p) => existsSync(join(projectDir, p)));
  // git archive only pulls committed content, so an uncommitted edit in the project
  // does not leak into the workspace (and does not appear there either).
  // An empty pathspec means "the whole tree" to git archive, not "nothing" —
  // so when none of a mode's paths exist, skip the archive/extract step
  // entirely and leave the workspace empty (plus tests/acceptance/ below).
  if (paths.length > 0) {
    const tar = execFileSync("git", ["archive", "HEAD", "--", ...paths], { cwd: projectDir, maxBuffer: 256 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", dir], { input: tar });
  }
  // Only spec-only gets an (empty, if nothing is committed there yet) tests/acceptance:
  // derive-tests writes the acceptance suite into it and needs it to exist even on a
  // project with no suite yet. blind-adapter must never see one at all — bind-adapter
  // stays blind to the very tests it will be run against — so it gets no directory here,
  // committed or not.
  if (mode === "spec-only") mkdirSync(join(dir, "tests", "acceptance"), { recursive: true });
  if (existsSync(join(dir, "app"))) {
    throw new Error(`blindness violated: app/ present in ${mode} workspace`);
  }
  return { dir, mode, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

export function collect(projectDir, dir, paths) {
  for (const p of paths) if (existsSync(join(dir, p))) { ensureDir(join(projectDir, p)); copyTree(join(dir, p), join(projectDir, p)); }
}

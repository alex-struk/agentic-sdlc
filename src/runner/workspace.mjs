import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { copyTreeOverwrite, ensureDir } from "../lib/fsx.mjs";
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
  // `.sdlc/config.yaml` is deliberately absent: it names the old application's repository
  // and commit, and nothing on the derive-tests path reads it from the workspace —
  // `prepare` generates types from `spec/contract` and `tests/seed/manifest.yaml`, and the
  // prompt is built from `ctx` in the project, before the workspace exists.
  "spec-only": ["spec", "tests/seed", "constitution.md", ...HARNESS, "tests/acceptance"],
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

// Copies an agent's own output back out of a temporary workspace — always overwriting
// (`copyTreeOverwrite`, not `copyTree`), since a destination path that already exists in
// the project is exactly the file the workspace started from and the agent may have
// rewritten: `derive-tests` rewriting an already-committed spec file on a `--stale`
// re-run, or updating the project's own `tests/acceptance/not-testable.yaml`, both
// depend on the workspace's version winning rather than being silently discarded.
export function collect(projectDir, dir, paths) {
  for (const p of paths) if (existsSync(join(dir, p))) { ensureDir(join(projectDir, p)); copyTreeOverwrite(join(dir, p), join(projectDir, p)); }
}

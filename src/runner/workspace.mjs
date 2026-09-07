import { mkdtempSync, rmSync, mkdirSync, existsSync, statSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { copyTreeOverwrite, ensureDir } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { ensureSources } from "./sources.mjs";
import { gitOk } from "../lib/git.mjs";

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

// Workspace modes whose agent works directly in the project directory rather than an
// ephemeral temporary one that `materialise` tears down. Shared by `resume` (deciding
// whether an interrupted run's output survived) and `finish-stage`'s fix-turn
// eligibility (deciding whether a post-check failure has something in `projectDir`
// worth asking the agent to repair) — both are the same question, "is `projectDir`
// itself where this stage's agent left its work?", asked at two different points in
// the run.
export const IN_PLACE_MODES = new Set(["project", "with-sources"]);

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

// `overlay` re-archives a second, smaller set of paths from a commit other than `HEAD`,
// on top of the ordinary archive every workspace starts from — `derive-tests --revise`
// uses it to hand its agent a workspace built exactly like any other run (this domain's
// siblings, the shared `tests/acceptance/redo.yaml` and `attestations.yaml`, the spec and
// contract) except for the one domain under revision, which is overlaid from the returned
// branch's own commit so the agent sees exactly what was proposed and returned for that
// domain, not whatever `main` has done since. Every other caller passes no `overlay` and
// sees the same behaviour as before. `overlay.paths` is checked for existence against
// `overlay.ref` itself — unlike the base archive's own `paths` (checked against the
// project's working tree, since every one of those is created at project init long before
// any commit could name it) an overlay path is expected to sometimes be genuinely absent
// from the ref it names (a returned branch that never wrote a `not-testable.yaml`, say),
// and is skipped rather than failing the whole overlay.
export function materialise(projectDir, mode, { overlay } = {}) {
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
  // Extracted after the base archive (and after the empty tests/acceptance/ above), so an
  // overlaid path always wins over whatever the base archive put in the same place — tar
  // extraction overwrites an existing file by default, the same way `collect` below always
  // overwrites the project on its way back out.
  if (overlay) {
    const overlayPaths = overlay.paths.filter((p) => gitOk(["cat-file", "-e", `${overlay.ref}:${p}`], projectDir));
    if (overlayPaths.length > 0) {
      const tar = execFileSync("git", ["archive", overlay.ref, "--", ...overlayPaths], { cwd: projectDir, maxBuffer: 256 * 1024 * 1024 });
      execFileSync("tar", ["-x", "-C", dir], { input: tar });
    }
  }
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
// depend on the workspace's version winning rather than being silently discarded. A path
// may name a directory (`tests/acceptance`) or a single file (`tests/acceptance/not-
// testable.yaml`, the shape a `--revise` run's own scoped collect uses) — the two need
// different copy logic, since `copyTreeOverwrite` reads its source with `readdirSync` and
// throws on a plain file.
export function collect(projectDir, dir, paths) {
  for (const p of paths) {
    const src = join(dir, p);
    if (!existsSync(src)) continue;
    const dst = join(projectDir, p);
    if (statSync(src).isDirectory()) { ensureDir(dst); copyTreeOverwrite(src, dst); }
    else { ensureDir(dirname(dst)); copyFileSync(src, dst); }
  }
}

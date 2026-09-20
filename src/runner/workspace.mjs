import { mkdtempSync, rmSync, mkdirSync, existsSync, statSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { copyTreeOverwrite, ensureDir, readText, writeText } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { ensureSources } from "./sources.mjs";
import { git, gitOk } from "../lib/git.mjs";

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

export const MODES = {
  "project": null,
  // `.sdlc/config.yaml` is deliberately absent: it names the old application's repository
  // and commit, and nothing on the derive-tests path reads it from the workspace —
  // `prepare` generates types from `spec/contract` and `tests/seed/manifest.yaml`, and the
  // prompt is built from `ctx` in the project, before the workspace exists.
  "spec-only": ["spec", "tests/seed", "constitution.md", ...HARNESS, "tests/acceptance"],
  "blind-adapter": ["spec/contract", "tests/adapters", "tests/seed", "constitution.md", ...HARNESS],
  // What the design gate and the planner both work from: the criteria, the surface the
  // screens have to offer, whatever design work is already done, and the constitution.
  // No application, so a screen is designed from what the product must do rather than from
  // what some earlier one happened to look like. No acceptance suite either: a design that
  // knows which assertions are waiting for it is a design drawn to satisfy them, and a plan
  // that knows which criteria already have tests will cut its slices around the tests
  // rather than around the work.
  // `.claude/skills` is what makes the design system available to the session that draws
  // the screens: the packs a project installs (`sdlc init`) are the org's own accessibility
  // and component guidance, and a design drawn without them is a design drawn against
  // nothing in particular. Committed content like everything else here, so the workspace
  // gets the pinned version rather than whatever is installed today.
  "spec-and-design": ["spec", "design", "constitution.md", ".claude/skills"],
  // What a builder works from: the criteria, the contract and design it has to meet, the
  // plan that says which slice this is, the application as it stands, and the seed
  // manifest the application's own seed service has to load. No acceptance suite and no
  // adapter: a build that can read the tests it will be judged by is a build written to
  // them (spec §5.10), and the rebuilt application is checked by running them, afterwards.
  "build": ["app", "plan", "spec", "design", "docs/decisions", "tests/seed", "constitution.md", ".claude/skills"],
  "with-sources": null,
};

// The list under `key` in a YAML document's text — `[]` for a document that does not
// parse or does not carry that key, the same forgiving read `checkTests`'s own
// `readYamlList` (`src/checks/tests.mjs`) gives a malformed `tests/acceptance/*.yaml`:
// this runs while a workspace is only being built, with nowhere to report a parse error
// to, so a malformed file reads as empty rather than failing the whole run.
function yamlList(text, key) {
  try {
    const parsed = parseYaml(text);
    return Array.isArray(parsed?.[key]) ? parsed[key] : [];
  } catch {
    return [];
  }
}

// The merged content for one shared, overlaid YAML file (see `overlay.merge`, below):
// `HEAD`'s own list (read from `headPath`, the workspace's copy already extracted from
// `HEAD` by the base archive) with every entry `ownsId` claims for the domain under
// revision dropped, plus the returned branch's own entries for that domain (parsed from
// `branchText`, `git show <ref>:<path>`) — every entry belonging to another domain
// survives exactly as `HEAD` had it, and the domain under revision ends up with exactly
// what the returned branch proposed for it, the same promise a full overlay keeps for a
// path only one domain owns.
function mergeYamlList(headPath, branchText, key, ownsId) {
  const head = existsSync(headPath) ? yamlList(readText(headPath), key) : [];
  const theirs = yamlList(branchText, key).filter((e) => ownsId(e?.id));
  return [...head.filter((e) => !ownsId(e?.id)), ...theirs];
}

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
//
// `overlay.merge` (`[{ path, key, ownsId }]`) names the overlay paths that are shared by
// more than one domain rather than owned by the one under revision —
// `tests/acceptance/not-testable.yaml` is the only one today. Overlaying a shared file the
// ordinary way (the returned branch's content replacing whatever the base archive put
// there) would discard every entry another domain added to `HEAD`'s copy after the branch
// was cut, which is exactly the defect this exists to avoid: those entries are merged in
// instead, by `mergeYamlList` above. Every overlay path `overlay.merge` does not name is
// still overlaid the ordinary way.
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
    const mergeByPath = new Map((overlay.merge ?? []).map((m) => [m.path, m]));
    const overlayPaths = overlay.paths.filter((p) => gitOk(["cat-file", "-e", `${overlay.ref}:${p}`], projectDir));
    const archivePaths = overlayPaths.filter((p) => !mergeByPath.has(p));
    if (archivePaths.length > 0) {
      const tar = execFileSync("git", ["archive", overlay.ref, "--", ...archivePaths], { cwd: projectDir, maxBuffer: 256 * 1024 * 1024 });
      execFileSync("tar", ["-x", "-C", dir], { input: tar });
    }
    // A merged path is never handed to `tar`: its workspace copy is whatever the base
    // archive already put there (HEAD's own version, extracted above), rewritten in place
    // rather than replaced.
    for (const p of overlayPaths.filter((path) => mergeByPath.has(path))) {
      const { key, ownsId } = mergeByPath.get(p);
      const dst = join(dir, p);
      const merged = mergeYamlList(dst, git(["show", `${overlay.ref}:${p}`], projectDir), key, ownsId);
      writeText(dst, stringifyYaml({ [key]: merged }));
    }
  }
  // The build workspace is the one mode that works on the application; every other ephemeral
  // mode stays blind to it. Reject app/ in any ephemeral mode except build.
  if (existsSync(join(dir, "app")) && mode !== "build") {
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
// Never carried back out of a workspace. An installed dependency tree is a build
// artifact of the machine it was installed on: it is gitignored, it is the largest thing
// in the workspace by far, and the project runs its own install before it checks anything
// — so copying one back is slow, pointless, and the only way a half-copied tree can reach
// the project at all. A destination that already holds one keeps it; nothing here touches
// what the project installed for itself.
const NEVER_COLLECTED = new Set(["node_modules"]);

export function collect(projectDir, dir, paths) {
  for (const p of paths) {
    const src = join(dir, p);
    if (!existsSync(src)) continue;
    const dst = join(projectDir, p);
    if (statSync(src).isDirectory()) { ensureDir(dst); copyTreeOverwrite(src, dst, { skip: NEVER_COLLECTED }); }
    else { ensureDir(dirname(dst)); copyFileSync(src, dst); }
  }
}

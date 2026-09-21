import { mkdtempSync, rmSync, mkdirSync, existsSync, statSync, copyFileSync, readdirSync, readFileSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
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

// `tests/generated` is regenerated inside the workspace by `derive-tests`'s own `prepare`
// and carried back out by its `collect`, so for that one mode it is the stage's output
// rather than context it reads. Every path is declared exactly once — as context here or
// as output in a stage's `collect` — which is what lets `materialise` seal the difference.
const HARNESS_CONTEXT = HARNESS.filter((p) => p !== "tests/generated");

// A workspace mode is the READ-ONLY CONTEXT a stage's agent is given: the committed
// material it needs in front of it to do the work, and nothing it is expected to produce.
// What it produces is its stage's `collect`, which `materialise` archives in alongside
// these and is the only part of the workspace that travels back to the project.
//
// The split is the declaration, not a convention: every path a workspace holds is either
// collected (writable, delivered) or context (sealed, and a change to it fails the run).
// A path may be named in one place or the other and never in both, because a path named
// in both is a path whose status nobody can read off the declaration — which is how a
// stage came to hand its agent a directory it was free to edit and could never deliver.
// A collect path may sit INSIDE a context path (a stage that reads a whole tree and
// writes one file in it); the reverse is refused, since a context path inside a collected
// tree is copied back wholesale and is therefore not context at all.
export const MODES = {
  "project": null,
  // `.sdlc/config.yaml` is deliberately absent: it names the old application's repository
  // and commit, and nothing on the derive-tests path reads it from the workspace —
  // `prepare` generates types from `spec/contract` and `tests/seed/manifest.yaml`, and the
  // prompt is built from `ctx` in the project, before the workspace exists.
  // `tests/acceptance` and `tests/generated` are derive-tests' own output and are declared
  // in its `collect`.
  "spec-only": ["spec", "tests/seed", "constitution.md", ...HARNESS_CONTEXT],
  // `tests/adapters` is bind-adapter's output and is declared in its `collect`.
  "blind-adapter": ["spec/contract", "tests/seed", "constitution.md", ...HARNESS],
  // What the designer works from: the criteria and the constitution. No application, so a
  // screen is designed from what the product must do rather than from what some earlier one
  // happened to look like. No acceptance suite either: a design that knows which assertions
  // are waiting for it is a design drawn to satisfy them.
  // `.claude/skills` is what makes the design system available to the session that draws
  // the screens: the packs a project installs (`sdlc init`) are the org's own accessibility
  // and component guidance, and a design drawn without them is a design drawn against
  // nothing in particular. Committed content like everything else here, so the workspace
  // gets the pinned version rather than whatever is installed today.
  // `design/` and the contract's `surface.yaml` are the stage's output and are declared in
  // its `collect`.
  "design": ["spec", "constitution.md", ".claude/skills"],
  // What the planner works from: the same criteria and design system the designer had, plus
  // the whole design it is cutting into slices. A plan that knows which criteria already
  // have tests will cut its slices around the tests rather than around the work, so there is
  // no acceptance suite here either.
  "plan": ["spec", "design", "constitution.md", ".claude/skills"],
  // What a builder works from: the criteria, the contract and design it has to meet, the
  // plan that says which slice this is, and the seed manifest the application's own seed
  // service has to load. No acceptance suite and no adapter: a build that can read the
  // tests it will be judged by is a build written to them (spec §5.10), and the rebuilt
  // application is checked by running them, afterwards. The application itself and
  // `docs/decisions` are the builder's output and are declared in its `collect`.
  "build": ["plan", "spec", "design", "tests/seed", "constitution.md", ".claude/skills"],
  "with-sources": null,
};

// Whether `path` is `parent` or sits underneath it. Plain string work on `/`-joined
// project-relative paths, so `plan` covers `plan/tasks.md` and never `planning/x`.
function covers(parent, path) {
  return path === parent || path.startsWith(`${parent}/`);
}

export function coveredBy(parents, path) {
  return (parents ?? []).some((p) => covers(p, path));
}

// What a stage's workspace holds that it will not take back: its mode's context, minus
// anything the stage collects out of it. This is the set `materialise` seals and
// `workspaceDrift` re-reads, and it is the whole of the invariant — a path in here is one
// the agent may read, and a change to it reaches nobody.
export function sealedPathsFor(mode, collect, context = []) {
  return contextPathsFor(mode, context).filter((p) => !coveredBy(collect, p));
}

// A stage's whole read-only context for one run: its mode's standing list, plus whatever
// that run adds. A run that narrows its collect set — `derive-tests --revise`, which
// delivers one domain out of a suite it reads whole — adds back, as context, the tree the
// full run delivers, so the workspace still carries it and the parts this run cannot
// deliver are sealed rather than silently dropped.
export function contextPathsFor(mode, context = []) {
  const standing = MODES[mode] ?? [];
  return [...standing, ...context.filter((p) => !standing.includes(p))];
}

// Every file under `root` (workspace-relative), each with a digest of what it holds, so a
// later read can name exactly which paths changed rather than reporting that something
// did. A symlink is digested by its target text rather than followed: a link that is
// repointed is a change, and following one could walk out of the workspace entirely.
// `node_modules` is skipped for the reason `NEVER_COLLECTED` gives below — it is a build
// artifact of the machine, it is never carried anywhere, and it is by far the largest
// thing a workspace can hold.
function digestTree(dir, rel, collect, into) {
  // A sealed path may contain collected ones — a stage that reads a whole tree and
  // delivers one file or one subdirectory out of it — so the exclusion is applied per
  // path on the way down rather than to the top of the tree alone.
  if (coveredBy(collect, rel)) return into;
  const abs = join(dir, rel);
  let st;
  try { st = lstatSync(abs); } catch { return into; }
  if (st.isSymbolicLink()) { into.set(rel, `link:${readlinkSync(abs)}`); return into; }
  if (st.isDirectory()) {
    if (NEVER_COLLECTED.has(rel.split("/").pop())) return into;
    for (const entry of readdirSync(abs).sort()) digestTree(dir, `${rel}/${entry}`, collect, into);
    return into;
  }
  into.set(rel, createHash("sha256").update(readFileSync(abs)).digest("hex"));
  return into;
}

function digestPaths(dir, paths, collect) {
  const into = new Map();
  for (const p of paths) digestTree(dir, p, collect, into);
  return into;
}

// The paths that changed under a sealed set between `seal` and now: written, deleted or
// created. Sorted, so the same drift is reported the same way twice.
function driftBetween(before, after) {
  const changed = new Set();
  for (const [p, d] of before) if (after.get(p) !== d) changed.add(p);
  for (const p of after.keys()) if (!before.has(p)) changed.add(p);
  return [...changed].sort();
}

// The declaration errors a stage's workspace scope can carry, as messages. Read off the
// stage and its mode alone, so the whole registry can be swept without running anything.
//
// `collect` is resolved by the caller, since a stage may narrow it per run.
export function workspaceScopeViolations(name, mode, collect, context = []) {
  const out = [];
  if (!(mode in MODES)) return [`stage ${name}: unknown workspace mode: ${mode}`];
  const paths = collect ?? [];
  for (const p of paths) {
    if (!p || isAbsolute(p) || p.split(/[/\\]/).includes("..") || p.includes(`${sep}${sep}`))
      out.push(`stage ${name}: collect path ${JSON.stringify(p)} is not a path inside the workspace`);
  }
  if (IN_PLACE_MODES.has(mode) || MODES[mode] === null) {
    if (paths.length)
      out.push(`stage ${name}: workspace ${mode} works in the project directory, so its collect list (${paths.join(", ")}) `
        + "names work nothing carries anywhere; a stage in this mode collects nothing");
    return out;
  }
  for (const readable of contextPathsFor(mode, context)) {
    for (const p of paths) {
      if (readable === p)
        out.push(`stage ${name}: ${readable} is declared both as workspace ${mode}'s read-only context and as this stage's own output; `
          + "a path is one or the other, and a path that is both cannot be sealed");
      else if (covers(p, readable))
        out.push(`stage ${name}: workspace ${mode} offers ${readable} as read-only context inside ${p}, which this stage collects; `
          + `everything under ${p} is copied back to the project, so ${readable} is not read-only and must not be declared as context`);
    }
  }
  return out;
}

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
//
// `collect` is the stage's own output set, and `materialise` needs it for two reasons.
// It is archived in alongside the mode's context, so a stage always starts from whatever
// the project already holds at the paths it is about to deliver — a planner that cannot
// see the plan it is revising would otherwise deliver a tree it never read. And it is
// what the sealed set is computed against: everything the mode carries that this run will
// not collect is digested by `seal` and re-read by `drift`, so work written where it
// cannot be delivered is found instead of discarded.
export function materialise(projectDir, mode, { collect = [], context = [], overlay } = {}) {
  if (!(mode in MODES)) throw new Error(`unknown workspace mode: ${mode}`);
  if (mode === "project") return { dir: projectDir, mode, seal() {}, drift: () => [], cleanup() {} };
  if (mode === "with-sources") {
    const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
    if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);
    ensureSources(projectDir, config);
    return { dir: projectDir, mode, seal() {}, drift: () => [], cleanup() {} };
  }
  const dir = mkdtempSync(join(tmpdir(), `sdlc-ws-${mode}-`));
  const readable = contextPathsFor(mode, context);
  const declared = [...readable, ...collect.filter((p) => !readable.includes(p))];
  const paths = declared.filter((p) => existsSync(join(projectDir, p)));
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
  const sealed = sealedPathsFor(mode, collect, context);
  let baseline = null;
  return {
    dir,
    mode,
    sealed,
    // Taken after `prepare` rather than at materialisation, because `prepare` is the
    // pipeline generating what the agent is about to read — types derived from a contract
    // the workspace already holds — and that is not a change the agent made. What `seal`
    // records is the workspace exactly as the session first sees it.
    seal() { baseline = digestPaths(dir, sealed, collect); },
    // Empty for a workspace that was never sealed, so a caller that does not seal is not
    // handed a list of everything as though the agent had written it.
    drift() { return baseline ? driftBetween(baseline, digestPaths(dir, sealed, collect)) : []; },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

// What a stage's agent is told about the workspace it has been put in, appended to its
// prompt by the runner. Two sentences, both facts about this run rather than advice: which
// paths become the proposal, and that everything else is context whose edits reach nobody.
//
// It is generated from the same two declarations the runner enforces, so a prompt cannot
// come to disagree with them. A prompt that names a criterion, a slice or a file out of a
// read-only path and then asks for it to be changed is the shape this closes: the list
// above it is read out of something the stage cannot deliver, and saying so is what stops
// an agent from doing the work and reporting it.
export function workspaceScopeNote(mode, collect, context = []) {
  if (MODES[mode] === null || MODES[mode] === undefined) return null;
  const sealed = sealedPathsFor(mode, collect, context);
  const out = (collect ?? []).length ? (collect ?? []).join(", ") : "nothing";
  const note = [`This is a workspace, not the project. What you write under ${out} is what travels back and becomes the proposal.`];
  if (sealed.length)
    note.push(`Everything else it carries — ${sealed.join(", ")} — is here to be read. Nothing written under those paths leaves this workspace, `
      + "and a change to any of them ends the run with the paths named rather than being delivered. "
      + "If something asks you to change one of them, it is not this stage's to deliver: leave it alone and say so in your journal entry.");
  return note.join(" ");
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

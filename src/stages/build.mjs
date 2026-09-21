// `build --slice N`: an agent builds one slice of the rebuilt application, in a workspace
// that has no acceptance suite (spec §5.10), and the result is opened at G3 as
// `proposal/build-slice-<n>`. It is not ruled until `verify` has run the suite against it
// (docs/decisions/0011-build-verify-review.md); `--revise` rebuilds from a returned ruling,
// which is how a failing verify comes back here.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readText } from "../lib/fsx.mjs";
import { changedPaths, git } from "../lib/git.mjs";
import { checkSeparation } from "../checks/separation.mjs";
import { readSlice, buildProposalBase, buildProposals } from "./slices.mjs";
import { nextProposalName, recommendationFrom, recordReturnOnMain, returnedRulingOn } from "./proposals.mjs";
import { skillPath } from "./shared.mjs";
import { targetSettings } from "../sandbox/local.mjs";

function defaultExec(cmd, args, { cwd } = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr || (res.error ? res.error.message : "") };
}

const ALLOWED = /^(app\/|docs\/decisions\/|\.sdlc\/(journal|runs|proposals)\/)/;

export function checkBuildScope(projectDir) {
  const id = "build-scope";
  const outside = changedPaths(projectDir).filter((p) => !ALLOWED.test(p) && p !== ".sdlc/run-state.json");
  return { id, ok: outside.length === 0, messages: outside.map((p) => `${p}: a build changes only app/ and docs/decisions/`) };
}

// The application's own typecheck and unit tests, run by the runner after the turn. The
// builder runs them too, but a proposal is answerable for what the runner saw, not what the
// builder said it saw.
export function appCheck(projectDir, { exec = defaultExec } = {}) {
  const id = "app-check";
  const manifest = join(projectDir, "app", "package.json");
  if (!existsSync(manifest)) return { id, ok: false, messages: ["app/package.json is missing; the stack requires one with a \"check\" script"] };
  let scripts;
  try { scripts = JSON.parse(readText(manifest)).scripts ?? {}; } catch (e) { return { id, ok: false, messages: [`app/package.json does not parse: ${e.message}`] }; }
  if (!scripts.check) return { id, ok: false, messages: ["app/package.json has no \"check\" script; the stack requires one that typechecks and runs the unit tests"] };
  const install = exec("npm", ["--prefix", "app", "install", "--no-audit", "--no-fund"], { cwd: projectDir });
  if (install.status !== 0) return { id, ok: false, messages: [`npm install in app/ failed:\n${(install.stderr || install.stdout).trim().split("\n").slice(-20).join("\n")}`] };
  const r = exec("npm", ["--prefix", "app", "run", "check"], { cwd: projectDir });
  if (r.status === 0) return { id, ok: true, messages: [] };
  return { id, ok: false, messages: [`npm --prefix app run check failed:\n${`${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-40).join("\n")}`] };
}

function checkSliceOption(projectDir, ctx) {
  const id = "build-slice";
  if (ctx.slice === undefined || Number.isNaN(ctx.slice)) return { id, ok: false, messages: ["build needs --slice <n>"] };
  const slice = readSlice(projectDir, ctx.slice);
  if (!slice) return { id, ok: false, messages: [`plan/tasks.md has no slice ${ctx.slice}`] };
  ctx.buildSlice = slice;
  return { id, ok: true, messages: [] };
}

function checkBuildRevisionSource(projectDir, ctx) {
  const id = "build-revise-source";
  if (!ctx.revise || !ctx.buildSlice) return { id, ok: true, messages: [] };
  for (const name of buildProposals(projectDir, ctx.slice)) {
    const found = returnedRulingOn(projectDir, name, `proposal/${name}`);
    if (!found) continue;
    ctx.revision = { name, branch: `proposal/${name}`, ...found, branchCommit: git(["rev-parse", `proposal/${name}`], projectDir) };
    if (!ctx.dryRun) recordReturnOnMain(projectDir, ctx.revision, { gate: "G3", keepBranch: true });
    return { id, ok: true, messages: [] };
  }
  return { id, ok: false, messages: [`build --revise: no returned ruling for slice ${ctx.slice} to revise from`] };
}

function revisionInstructions(ctx) {
  const conditions = (ctx.revision?.conditions ?? []).map((c) => `- ${c}`).join("\n");
  return [
    "This is a revision. The application as the returned proposal left it is already under app/; change what the ruling below names and leave the rest.",
    `The ruling that returned it:\n\n${ctx.revision?.rationale ?? ""}`,
    conditions ? `What it must now do:\n\n${conditions}` : "",
    "A failing criterion is described by what the running application did, never by the test's code, which you will not see. Read the criterion again and find where the application departs from it.",
  ].filter(Boolean).join("\n\n");
}

export const build = {
  name: "build",
  title: (ctx) => `build slice ${ctx.slice}`,
  skill: skillPath("build"),
  workspace: "build",
  gate: "G3",
  collect: ["app", "docs/decisions"],
  // A slice is a feature end to end — pages, API, data — and a first slice also stands the
  // application up, which alone runs past any smaller ceiling.
  defaultTurns: 400,
  revisionOverlayPaths: () => ["app", "docs/decisions"],
  implemented: true,
  allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash(npm *)", "Bash(npx *)", "Bash(node *)", "Bash(ls *)", "Bash(mkdir *)"],
  prompt(ctx) {
    const s = ctx.buildSlice;
    // The build skill tells the builder its compose file must answer on the port in
    // `targets.new.base_url`, and the build workspace deliberately has no
    // `.sdlc/config.yaml` to read it from — it names the old application's repository and
    // commit, which a builder must not see. So the value is stated here instead, where
    // the prompt is composed in the project. An instruction naming a value the agent
    // cannot reach is an instruction it has to guess at, and the first build guessed a
    // port the identity provider was already on: the health check found something
    // answering and called the sandbox up.
    const { baseUrl, dependsOn } = targetSettings(ctx.config, "new");
    // The same substitution, for the same reason, for the addresses the target says it
    // cannot be used without: `sandbox up` waits for every one of them and the run stops
    // where one does not answer, so a builder that cannot read them is a builder that
    // cannot satisfy them.
    const deps = Object.entries(dependsOn ?? {});
    return [
      `Build slice ${s.number} of plan/tasks.md. Its entry in the plan:\n\n${s.body}`,
      `The criteria it is answerable for: ${s.criteria.join(", ")}.`,
      `The application must answer at ${baseUrl}: that is this project's \`targets.new.base_url\`, `
        + `it is the address the acceptance suite drives, and app/compose/compose.yaml must publish `
        + `it there. No other service in that file may take that port.`,
      deps.length
        ? `The same compose file must stand up, and publish at exactly these addresses, everything this target cannot be used without: `
          + `${deps.map(([n, u]) => `${n} at ${u}`).join("; ")}. `
          + `Each is waited for before the sandbox is reported up, and the run stops where one does not answer. `
          + `Publish each at the address that exists only once its service is usable rather than one that answers earlier — `
          + `an identity provider's realm endpoint answers when the realm is loaded, while its server root answers before that and goes on answering if the load fails.`
        : null,
      ctx.revise ? revisionInstructions(ctx) : null,
    ].filter(Boolean).join("\n\n");
  },
  proposal(ctx) {
    return {
      name: ctx.buildName ?? nextProposalName(ctx.projectDir, buildProposalBase(ctx.slice)),
      question: `Does slice ${ctx.slice} (${ctx.buildSlice?.title ?? ""}) do what its criteria say?`,
      recommendation: recommendationFrom(ctx.agentText),
    };
  },
  preChecks(projectDir, ctx) {
    const slice = checkSliceOption(projectDir, ctx);
    return [slice, checkBuildRevisionSource(projectDir, ctx)];
  },
  postChecks(projectDir, ctx) {
    ctx.buildName = nextProposalName(projectDir, buildProposalBase(ctx.slice));
    return [checkSeparation(projectDir), checkBuildScope(projectDir), appCheck(projectDir)];
  },
};

// `deploy --platform P`: an agent writes the one deployment definition, the one deploy script and
// the GitHub workflow that calls that script, from the deploy profile for platform P
// (`deploys/<P>/`). Before it proposes, the runner runs the script from this machine against a
// test environment and checks the application answers; that result goes to the gate with the
// proposal (`docs/stages/deploy.md`). Once the proposal is approved, GitHub does every deploy
// from then on, by running the same script, so there is no second path to keep in step.
import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { readText } from "../lib/fsx.mjs";
import { changedPaths } from "../lib/git.mjs";
import { PIPELINE_ROOT } from "../lib/root.mjs";
import { redactLocalPaths } from "../lib/redact.mjs";
import { nextProposalName, recommendationFrom } from "./proposals.mjs";
import { skillPath } from "./shared.mjs";

const PROFILES_DIR = join(PIPELINE_ROOT, "deploys");
const PLATFORM = /^[a-z0-9][a-z0-9-]*$/;

export const deployDir = (platform) => `deploy/${platform}`;
export const deployScript = (platform) => `${deployDir(platform)}/deploy.sh`;
export const deployWorkflow = (platform) => `.github/workflows/deploy-${platform}.yml`;
// What a platform's bootstrap chose: names, ids and a region, never a credential. It matches the
// `.sdlc/*.local.txt` line every project ignores, because it describes this machine's setup and
// the workflow reads the same values from the repository's own variables.
export const deploySettingsFile = (platform) => `.sdlc/deploy-${platform}.local.txt`;

export function readDeploySettings(projectDir, platform) {
  const file = join(projectDir, deploySettingsFile(platform));
  if (!existsSync(file)) return {};
  const settings = {};
  for (const line of readText(file).split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) settings[m[1]] = m[2].replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
  }
  return settings;
}

// A profile may carry `bootstrap/preflight.sh` and `bootstrap/bootstrap.sh`. They run on this
// machine, before the agent turn, with the terminal attached: the preflight checks the operator
// is signed in and can do what the bootstrap needs, and the bootstrap asks what to create or
// reuse, makes sure it exists, and writes its choices to the settings file. The agent session
// never runs them: it holds no cloud sign-in and cannot ask anyone anything.
export function bootstrapPlatform(projectDir, platform, { profilesDir = PROFILES_DIR, env = process.env, stdio = "inherit" } = {}) {
  const dir = join(profilesDir, platform, "bootstrap");
  const scripts = ["preflight.sh", "bootstrap.sh"].filter((f) => existsSync(join(dir, f)));
  if (!scripts.length) return { ok: true, ran: false, messages: [] };
  const rel = deploySettingsFile(platform);
  const runEnv = { ...env, SDLC_PROJECT_DIR: projectDir, SDLC_PLATFORM: platform, SDLC_SETTINGS_FILE: join(projectDir, rel) };
  for (const f of scripts) {
    const r = spawnSync("bash", [join(dir, f)], { cwd: projectDir, env: runEnv, stdio, encoding: "utf8" });
    if (r.status !== 0) {
      const said = stdio === "inherit" ? "" : `\n${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-20).join("\n")}`;
      const step = f === "preflight.sh" ? "preflight" : "bootstrap";
      return { ok: false, ran: true, messages: [redactLocalPaths(`${platform} ${step} did not pass${r.error ? `: ${r.error.message}` : ""}; nothing past it ran${said}`, projectDir)] };
    }
  }
  const keys = Object.keys(readDeploySettings(projectDir, platform));
  if (!keys.length) return { ok: false, ran: true, messages: [`${platform} bootstrap wrote no settings to ${rel}`] };
  return { ok: true, ran: true, messages: [
    `${platform} is set up; its settings (${keys.join(", ")}) are in ${rel}. To use them in a shell: set -a; . ${rel}; set +a`,
  ] };
}

// The platforms the pipeline has a profile for, by name.
export function deployProfiles() {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR)
    .filter((n) => statSync(join(PROFILES_DIR, n)).isDirectory() && existsSync(join(PROFILES_DIR, n, "SKILL.md")))
    .sort();
}

function templateFiles(root, dir = root) {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? templateFiles(root, p) : [relative(root, p)];
  });
}

// The profile as the agent reads it: its standards, then each template with the path the
// project's copy goes to. The workspace is the project, which does not carry the pipeline's
// own checkout, so the text travels in the prompt.
export function profileText(platform) {
  if (!PLATFORM.test(platform ?? "") || !deployProfiles().includes(platform)) throw new Error(`no deploy profile for ${platform}`);
  const root = join(PROFILES_DIR, platform);
  const parts = [readText(join(root, "SKILL.md")).replace(/^---[\s\S]*?---\r?\n/, "").trim()];
  const tdir = join(root, "templates");
  if (existsSync(tdir)) {
    for (const f of templateFiles(tdir)) parts.push(`### Template: ${f}\n\n\`\`\`\n${readText(join(tdir, f)).trimEnd()}\n\`\`\``);
  }
  return parts.join("\n\n");
}

function checkPlatformOption(ctx) {
  const id = "deploy-platform";
  if (!ctx.platform) return { id, ok: false, messages: ["deploy needs --platform <name>"] };
  if (!PLATFORM.test(ctx.platform)) return { id, ok: false, messages: [`--platform ${ctx.platform}: lowercase letters, digits, hyphens`] };
  const listed = ctx.config?.deploy ?? [];
  if (!listed.includes(ctx.platform)) {
    return { id, ok: false, messages: [`${ctx.platform} is not in the project's deploy setting (${listed.length ? listed.join(", ") : "none listed"}); add it to .sdlc/config.yaml`] };
  }
  if (!deployProfiles().includes(ctx.platform)) {
    return { id, ok: false, messages: [`no deploy profile for ${ctx.platform}; the pipeline has: ${deployProfiles().join(", ")}`] };
  }
  return { id, ok: true, messages: [] };
}

function checkApplicationExists(projectDir) {
  const id = "deploy-application";
  return existsSync(join(projectDir, "app"))
    ? { id, ok: true, messages: [] }
    : { id, ok: false, messages: ["app/ is missing; deploy runs after the application is built"] };
}

// The stage changes its own platform's definition, script and workflow and nothing else.
export function checkDeployScope(projectDir, platform) {
  const id = "deploy-scope";
  const own = (p) => p === deployWorkflow(platform) || p.startsWith(`${deployDir(platform)}/`)
    || p.startsWith("docs/decisions/") || /^\.sdlc\/(journal|runs|proposals)\//.test(p) || p === ".sdlc/run-state.json";
  const outside = changedPaths(projectDir).filter((p) => !own(p));
  return { id, ok: outside.length === 0, messages: outside.map((p) => `${p}: deploy changes only ${deployDir(platform)}/, ${deployWorkflow(platform)} and docs/decisions/`) };
}

export function checkDeployFiles(projectDir, platform) {
  const id = "deploy-files";
  const messages = [];
  const dir = join(projectDir, deployDir(platform));
  const files = existsSync(dir) ? readdirSync(dir) : [];
  if (!files.some((f) => /\.(bicep|ya?ml)$/.test(f))) messages.push(`${deployDir(platform)}/ has no deployment definition (a .bicep or .yaml file)`);
  if (!existsSync(join(projectDir, deployScript(platform)))) messages.push(`${deployScript(platform)} is missing`);
  if (!existsSync(join(projectDir, deployWorkflow(platform)))) messages.push(`${deployWorkflow(platform)} is missing`);
  return { id, ok: messages.length === 0, messages };
}

// The workflow runs the script this stage ran, and nothing else deploys: a production run by
// hand, and an automatic run on the `development` branch.
export function checkWorkflowCallsScript(projectDir, platform) {
  const id = "deploy-workflow";
  const file = join(projectDir, deployWorkflow(platform));
  if (!existsSync(file)) return { id, ok: false, messages: [`${deployWorkflow(platform)} is missing`] };
  const text = readText(file);
  const messages = [];
  if (!text.includes(deployScript(platform))) messages.push(`${deployWorkflow(platform)} does not run ${deployScript(platform)}; the workflow and the local run must be the same script`);
  if (!/workflow_dispatch/.test(text)) messages.push(`${deployWorkflow(platform)} has no workflow_dispatch trigger for the manual production deploy`);
  if (!/\bdevelopment\b/.test(text)) messages.push(`${deployWorkflow(platform)} does not deploy automatically on the development branch`);
  return { id, ok: messages.length === 0, messages };
}

function defaultExec(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60 * 1000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr || (r.error ? r.error.message : "") };
}

// Runs the script from this machine against the test environment, then asks the deployed
// application for its address. The script prints `DEPLOYED_URL=<address>`; anything below 400
// from that address is an answer. Credentials come from the environment the run is started in
// and are never read or reported here. The bootstrap's settings are laid over that environment,
// so the run uses what was chosen at the start of this deploy rather than a stale export.
export async function testEnvironmentRun(projectDir, platform, { exec = defaultExec, fetchFn = fetch, env = process.env } = {}) {
  const id = "deploy-test-run";
  const ran = exec("bash", [deployScript(platform), "test"], { cwd: projectDir, env: { ...env, ...readDeploySettings(projectDir, platform) } });
  const tail = (s) => s.trim().split("\n").slice(-20).join("\n");
  if (ran.status !== 0) return { id, ok: false, messages: [`${deployScript(platform)} test failed:\n${tail(`${ran.stdout}\n${ran.stderr}`)}`] };
  const url = /^DEPLOYED_URL=(\S+)\s*$/m.exec(ran.stdout)?.[1];
  if (!url) return { id, ok: false, messages: [`${deployScript(platform)} test succeeded but printed no DEPLOYED_URL=<address> line`] };
  let status;
  try { status = (await fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) })).status; }
  catch (e) { return { id, ok: false, url, messages: [`${url} did not answer: ${e.message}`] }; }
  if (status >= 400) return { id, ok: false, url, status, messages: [`${url} answered ${status}`] };
  return { id, ok: true, url, status, messages: [] };
}

export const deploy = {
  name: "deploy",
  title: (ctx) => `deploy to ${ctx.platform}`,
  skill: skillPath("deploy"),
  workspace: "project",
  gate: "G3",
  proposalPrefix: "deploy-",
  defaultTurns: 80,
  implemented: true,
  allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash(ls *)", "Bash(mkdir *)", "Bash(chmod *)"],
  prompt(ctx) {
    return [
      `Deploy the application in app/ to ${ctx.platform}. Write ${deployDir(ctx.platform)}/ (the one deployment definition and the one deploy script, ${deployScript(ctx.platform)}) and ${deployWorkflow(ctx.platform)}, which runs that same script.`,
      `The deploy profile for ${ctx.platform} follows. It is the pipeline's standard for this platform; a departure from it is a decision record under docs/decisions/ naming what departs and why.`,
      profileText(ctx.platform),
    ].join("\n\n");
  },
  proposal(ctx) {
    return {
      name: ctx.deployName ?? nextProposalName(ctx.projectDir, `deploy-${ctx.platform}`),
      question: `Is this the right way to deploy the application to ${ctx.platform}, and did it run from the test environment?`,
      recommendation: recommendationFrom(ctx.agentText),
    };
  },
  // What the runner saw when it ran the script, appended to the page the gate rules on.
  proposalEvidence(ctx) {
    const r = ctx.deployRun;
    if (!r) return "";
    const body = r.ok
      ? `The deploy script ran against the test environment and ${r.url} answered ${r.status}.`
      : `The deploy script did not pass against the test environment:\n\n${r.messages.join("\n")}`;
    return redactLocalPaths(`\n\n## Test-environment run\n\n${body}\n`, ctx.projectDir ?? process.cwd());
  },
  preChecks(projectDir, ctx) {
    return [checkPlatformOption(ctx), checkApplicationExists(projectDir)];
  },
  bootstrap(projectDir, ctx) {
    return bootstrapPlatform(projectDir, ctx.platform);
  },
  async postChecks(projectDir, ctx) {
    ctx.deployName = nextProposalName(projectDir, `deploy-${ctx.platform}`);
    const before = [checkDeployScope(projectDir, ctx.platform), checkDeployFiles(projectDir, ctx.platform), checkWorkflowCallsScript(projectDir, ctx.platform)];
    if (before.some((r) => !r.ok) || ctx.dryRun) return before;
    const run = await testEnvironmentRun(projectDir, ctx.platform);
    ctx.deployRun = run;
    return [...before, run];
  },
};

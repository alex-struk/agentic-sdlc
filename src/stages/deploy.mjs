// `deploy --platform P`: an agent reads the application, writes down in `deploy/<P>/plan.md` what
// deploying it needs (the resources, the changes to the application, the secrets by name), then
// makes those changes and writes the one deployment definition, the one deploy script and the
// GitHub workflow that calls that script, from the deploy profile for platform P (`deploys/<P>/`).
// The person running the stage, signed in to the platform as themselves, then provisions what the
// definition names, and GitHub deploys the work to the development environment as a trial and
// the runner checks the application answers. What both did goes to the gate with the proposal
// (`docs/stages/deploy.md`, `docs/decisions/0117`). Once the proposal is approved, GitHub does
// every deploy from then on by running the same script, which creates nothing, so the identity it
// deploys as can change the application and nothing else.
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { readText } from "../lib/fsx.mjs";
import { changedPaths, gitOk, gitRaw, SDLC_AUTHOR } from "../lib/git.mjs";
import { checkEgress } from "../checks/egress.mjs";
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

// A profile may carry `bootstrap/preflight.sh` and `bootstrap/bootstrap.sh`, the platform's
// provisioning. A deploy run runs them on this machine with the terminal attached, once the
// session's files pass their checks and before the trial; `sdlc run deploy --platform P --setup`
// runs them alone, against the definition the checkout holds. The preflight checks the person is
// signed in and can do what the bootstrap needs; the bootstrap asks what to create or reuse,
// creates the resources the project's definition names, gives the identity GitHub deploys as only
// what a deploy needs, and writes its choices to the settings file. The agent session never runs
// them: it holds no cloud sign-in and cannot ask anyone anything.
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
// project's copy goes to. The workspace does not carry the pipeline's own checkout, so the text
// travels in the prompt.
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

const hasSetup = (platform) => existsSync(join(PROFILES_DIR, platform, "bootstrap", "bootstrap.sh"));

// A setup run is for a platform whose profile carries a setup.
function checkHasSetup(platform) {
  const id = "deploy-has-setup";
  if (!PLATFORM.test(platform ?? "") || !deployProfiles().includes(platform) || hasSetup(platform)) return { id, ok: true, messages: [] };
  return { id, ok: false, messages: [`${platform} has no setup; its deploys need none, so run the stage itself`] };
}

function checkApplicationExists(projectDir) {
  const id = "deploy-application";
  return existsSync(join(projectDir, "app"))
    ? { id, ok: true, messages: [] }
    : { id, ok: false, messages: ["app/ is missing; deploy runs after the application is built"] };
}

export const deployPlan = (platform) => `${deployDir(platform)}/plan.md`;

// The stage changes its own platform's plan, definition, script and workflow, and the application
// only where the plan names the change by its path, so the gate reads every change to app/ with
// the reason for it.
export function checkDeployScope(projectDir, platform) {
  const id = "deploy-scope";
  const planFile = join(projectDir, deployPlan(platform));
  const plan = existsSync(planFile) ? readText(planFile) : "";
  const own = (p) => p === deployWorkflow(platform) || p.startsWith(`${deployDir(platform)}/`)
    || p.startsWith("docs/decisions/") || /^\.sdlc\/(journal|runs|proposals)\//.test(p) || p === ".sdlc/run-state.json";
  const messages = [];
  for (const p of changedPaths(projectDir).filter((p) => !own(p))) {
    if (p.startsWith("app/")) {
      const named = new RegExp(`(?<![\\w./-])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-]|\\.\\w)`).test(plan);
      if (!named) messages.push(`${p}: a deploy changes the application only where ${deployPlan(platform)} names the change; name it there with why the deploy needs it, or leave it to the build stage`);
    } else {
      messages.push(`${p}: deploy changes only ${deployDir(platform)}/, ${deployWorkflow(platform)}, docs/decisions/, and app/ where ${deployPlan(platform)} names the change`);
    }
  }
  return { id, ok: messages.length === 0, messages };
}

export function checkDeployFiles(projectDir, platform) {
  const id = "deploy-files";
  const messages = [];
  const dir = join(projectDir, deployDir(platform));
  const files = existsSync(dir) ? readdirSync(dir) : [];
  if (!existsSync(join(projectDir, deployPlan(platform)))) messages.push(`${deployPlan(platform)} is missing; it says what the application needs to deploy and what changes to it`);
  if (!files.some((f) => /\.(bicep|ya?ml)$/.test(f))) messages.push(`${deployDir(platform)}/ has no deployment definition (a .bicep or .yaml file)`);
  if (!existsSync(join(projectDir, deployScript(platform)))) messages.push(`${deployScript(platform)} is missing`);
  if (!existsSync(join(projectDir, deployWorkflow(platform)))) messages.push(`${deployWorkflow(platform)} is missing`);
  return { id, ok: messages.length === 0, messages };
}

// What a Bicep definition may do, since provisioning deploys it signed in as the person running
// the stage, before anyone has ruled on it: create and change resources in the one resource group
// it is deployed to, from files the project holds. It may not reach another scope, grant a role,
// lock or set policy on anything, run a script of its own in the cloud, or pull a module from a
// registry, whose content the gate cannot read.
const OTHER_SCOPE = /\bscope\s*:\s*(?:subscription|tenant|managementGroup|resourceGroup)\s*\(/;
const REMOTE_MODULE = /^\s*(?:module\s+\w+\s+|using\s+)'((?:br|ts)[:/][^']*)'/;

export function checkDefinitionScope(projectDir, platform) {
  const id = "deploy-definition";
  const dir = join(projectDir, deployDir(platform));
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.bicep(param)?$/.test(f)).sort() : [];
  const messages = [];
  for (const f of files) {
    readText(join(dir, f)).split(/\r?\n/).forEach((line, i) => {
      const at = `${f}:${i + 1}`;
      const code = line.replace(/\/\/.*$/, "");
      const target = /^\s*targetScope\s*=\s*'([^']*)'/.exec(code)?.[1];
      if (target && target !== "resourceGroup") messages.push(`${at}: targetScope is ${target}; a definition is deployed to its one resource group`);
      if (/Microsoft\.Authorization\//.test(code)) messages.push(`${at}: Microsoft.Authorization resources (roles, locks, policy) are not the definition's to create; provisioning assigns the roles a deploy needs`);
      if (/Microsoft\.Resources\/deploymentScripts/.test(code)) messages.push(`${at}: a deploymentScripts resource runs code in the cloud as provisioning signs in; do what it would in deploy.sh or the definition`);
      if (OTHER_SCOPE.test(code)) messages.push(`${at}: a module deployed to another scope; everything is deployed to the definition's own resource group`);
      const remote = REMOTE_MODULE.exec(code)?.[1];
      if (remote) messages.push(`${at}: ${remote} is not a file in ${deployDir(platform)}; the gate rules on what the definition holds, so every module is one of its files`);
    });
  }
  return { id, ok: messages.length === 0, messages };
}

// The branch a deploy's trial is pushed to, and so the one besides `main` whose pushes deploy
// the development environment (`docs/decisions/0116`).
export const TRIAL_BRANCH = "development";

// What a deploy workflow's token may hold: the repository's contents to read, the sign-in token
// the platform's federated credential accepts, and, for images kept in GitHub's own container
// registry, the right to push them. Nothing else a deploy does writes anything on GitHub, and a
// trial runs the workflow before anyone has read it.
const GRANTS = { contents: "read", "id-token": "write", packages: "write" };
const GRANTED = "contents: read, id-token: write and, for images in GitHub's container registry, packages: write";
const PINNED = /@[0-9a-f]{40}$/;

function triggersOf(on) {
  if (typeof on === "string") return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((t) => [t, null]));
  return on && typeof on === "object" ? on : {};
}

function grantProblems(file, where, permissions) {
  if (permissions === undefined || permissions === null) return [];
  if (typeof permissions !== "object") return [`${file} grants ${where} ${permissions}; a deploy workflow grants only ${GRANTED}`];
  // Reading what a grant could write is a grant of less.
  return Object.entries(permissions).filter(([k, v]) => v !== "none" && GRANTS[k] !== v && !(GRANTS[k] === "write" && v === "read"))
    .map(([k, v]) => `${file} grants ${where} ${k}: ${v}; a deploy workflow grants only ${GRANTED}`);
}

const DIGEST = /@sha256:[0-9a-f]{64}$/;

// What a step or a job runs that the workflow does not hold itself: an action or reusable workflow
// from elsewhere is pinned to a full commit SHA, an image by its digest, and an action in the
// repository is read as the workflow is, since a trial runs whatever it uses as well.
function usesProblems(projectDir, from, uses, seen) {
  if (typeof uses !== "string") return [];
  if (uses.startsWith("docker://")) return DIGEST.test(uses) ? [] : [`${from} uses ${uses}, which is not pinned to an image digest; a trial runs this workflow before it is ruled on`];
  if (!uses.startsWith("./")) return PINNED.test(uses) ? [] : [`${from} uses ${uses}, which is not pinned to a full commit SHA; a trial runs this workflow before it is ruled on`];
  const dir = uses.slice(2).replace(/\/+$/, "");
  if (seen.has(dir)) return [];
  seen.add(dir);
  const file = ["action.yml", "action.yaml"].map((n) => join(projectDir, dir, n)).find((p) => existsSync(p));
  if (!file) return [`${from} uses ${uses}, which is not in the repository`];
  let action;
  try { action = parseYaml(readText(file)); } catch (e) { return [`${dir}/${basename(file)} is not YAML: ${e.message}`]; }
  const runs = action?.runs ?? {};
  if (runs.using === "composite") return (Array.isArray(runs.steps) ? runs.steps : []).flatMap((s) => usesProblems(projectDir, dir, s?.uses, seen));
  if (runs.using === "docker" && typeof runs.image === "string" && runs.image.startsWith("docker://")) return usesProblems(projectDir, dir, runs.image, seen);
  return [];
}

function imageProblems(from, image) {
  const ref = typeof image === "string" ? image : image?.image;
  if (typeof ref !== "string" || DIGEST.test(ref)) return [];
  return [`${from} ${ref}, which is not pinned to an image digest; a trial runs this workflow before it is ruled on`];
}

// The workflow runs the script this stage's trial ran, and deploys development on a push to
// `main` or to the trial branch. Because a trial runs the
// workflow before it is ruled on, every action it uses is pinned to a full commit SHA and its
// token can read the repository, sign in to the platform and push images, and do nothing else.
export function checkWorkflowCallsScript(projectDir, platform) {
  const id = "deploy-workflow";
  const rel = deployWorkflow(platform);
  const file = join(projectDir, rel);
  if (!existsSync(file)) return { id, ok: false, messages: [`${rel} is missing`] };
  const text = readText(file);
  let wf;
  try { wf = parseYaml(text); } catch (e) { return { id, ok: false, messages: [`${rel} is not YAML: ${e.message}`] }; }
  if (!wf || typeof wf !== "object") return { id, ok: false, messages: [`${rel} holds no workflow`] };
  const messages = [];
  if (!text.includes(deployScript(platform))) messages.push(`${rel} does not run ${deployScript(platform)}; the workflow and the trial must run the same script`);
  const on = triggersOf(wf.on);
  const branches = Array.isArray(on.push?.branches) ? on.push.branches : [];
  if (!branches.includes("main")) messages.push(`${rel} does not deploy development on a push to main`);
  if (!branches.includes(TRIAL_BRANCH)) messages.push(`${rel} does not deploy development on a push to ${TRIAL_BRANCH}, the branch a deploy's trial is pushed to`);
  if (!("permissions" in wf)) messages.push(`${rel} sets no permissions of its own, so its jobs get the repository's default token; set permissions: {} and grant each job only ${GRANTED}`);
  else messages.push(...grantProblems(rel, "the workflow", wf.permissions));
  // A secret reaches a step only where the workflow names it, and a deploy names the ones its
  // environment holds; one that reads them all, or one by a name worked out as it runs, could read
  // any the repository has.
  if (/toJSON\(\s*secrets\s*\)/.test(text)) messages.push(`${rel} reads every secret at once; name each secret the deploy needs`);
  if (/\bsecrets\s*\[/.test(text)) messages.push(`${rel} reads a secret by a name worked out at run time; name each secret the deploy needs`);
  const seen = new Set();
  for (const [name, job] of Object.entries(wf.jobs ?? {})) {
    messages.push(...grantProblems(rel, `job ${name}`, job?.permissions));
    if (job?.secrets === "inherit") messages.push(`${rel}: job ${name} hands every secret on to ${job.uses ?? "the workflow it calls"}; name each secret the deploy needs`);
    for (const u of [job?.uses, ...(Array.isArray(job?.steps) ? job.steps.map((s) => s?.uses) : [])]) messages.push(...usesProblems(projectDir, rel, u, seen));
    messages.push(...imageProblems(`${rel}: job ${name} runs in`, job?.container));
    for (const [svc, def] of Object.entries(job?.services ?? {})) messages.push(...imageProblems(`${rel}: job ${name}'s service ${svc} runs`, def));
  }
  return { id, ok: messages.length === 0, messages };
}

function defaultGh(args) {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000 });
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || (r.error ? r.error.message : "")).trim()}`);
  return r.stdout ?? "";
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The `owner/name` of the repository `origin` names on GitHub, read from the remote's own
// configuration, which is where the trial is pushed and so where its run is.
function originRepo(projectDir) {
  let url = "";
  try { url = gitRaw(["config", "--get", "remote.origin.url"], projectDir).trim(); } catch { return null; }
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
}

// What `main` may hold that `origin` does not when a trial publishes it: the pipeline's own
// records of runs, which a setup or a run out of sequence commits before a person pushes.
const PIPELINE_RECORDS = /^\.sdlc\/(runs|journal)\//;

// Text that looks like a credential, which a trial must not publish whatever put it in a file.
// Assembled from pieces where the source would otherwise hold the very shape it looks for.
const CREDENTIAL_SHAPES = [
  [new RegExp("-----BEGIN [A-Z ]*PRIVATE " + "KEY-----"), "a private key"],
  [/\b(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/=]{20,}/, "a storage or messaging key"],
  [/[?&]sig=[A-Za-z0-9%+/=]{20,}/, "a shared access signature"],
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/, "a GitHub token"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a signed access token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "a cloud access key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a chat token"],
];

function credentialShapes(projectDir, files) {
  const found = [];
  for (const f of files) {
    const abs = join(projectDir, f);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    readText(abs).split("\n").forEach((line, i) => {
      for (const [re, what] of CREDENTIAL_SHAPES) if (re.test(line)) found.push(`${f}:${i + 1}: ${what}`);
    });
  }
  return found;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The working tree as the session left it, committed on top of `HEAD` through an index of its
// own, so neither the project's index nor any of its branches moves. What git ignores (the
// settings file among it) is left out, as from any commit.
function trialCommit(projectDir, message) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-trial-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
  const g = (args) => execFileSync("git", args, { cwd: projectDir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    g(["read-tree", "HEAD"]);
    g(["add", "-A"]);
    return g([...SDLC_AUTHOR, "commit-tree", g(["write-tree"]), "-p", "HEAD", "-m", message]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const lastLines = (text, n = 20) => String(text ?? "").trim().split("\n").slice(-n).join("\n");

// The trial (`docs/decisions/0116`): the session's work, committed on top of `main` and pushed to
// the trial branch, which the workflow deploys to the development environment. GitHub's run of it
// signs in as the development environment's own identity, which can reach nothing but that
// environment, so the workflow is tried before it is ruled on without this machine ever signing
// in to the platform. The run's `DEPLOYED_URL=<address>` is then asked whether the application
// answers; anything below 400 is an answer.
//
// Before anything is published it is refused: while the commits `main` holds and `origin` does
// not touch anything but the pipeline's own records, since the push publishes their history;
// while the files the trial adds hold anything the egress check forbids or anything shaped like a
// credential; and while the repository's workflows can read a secret no environment holds back,
// since the workflow it runs has not been ruled on yet.
export async function trialDeploy(projectDir, platform, {
  gh = defaultGh, fetchFn = fetch, sleep = defaultSleep, pollMs = 15_000, appearPolls = 40, finishPolls = 240, tries = 5, config,
} = {}) {
  const id = "deploy-trial";
  const fail = (messages, more = {}) => ({ id, ok: false, ...more, messages: messages.map((m) => redactLocalPaths(m, projectDir)) });
  // A call to GitHub that fails is tried again a few times before the trial gives up on it.
  const call = async (args) => {
    for (let i = 1; ; i++) {
      try { return gh(args); } catch (e) { if (i >= tries) throw e; await sleep(pollMs); }
    }
  };
  const repo = originRepo(projectDir);
  if (!repo) return fail([`origin is not a repository on GitHub, where the trial runs`]);
  const named = readDeploySettings(projectDir, platform).GITHUB_REPO;
  if (named && named !== repo) return fail([`the setup named ${named}, but origin is ${repo}; the trial runs where origin is, so set the platform up for ${repo}`]);
  if (!gitOk(["fetch", "-q", "origin", "main"], projectDir)) return fail([`could not fetch main from origin, where the trial is pushed`]);
  let unpushed;
  try {
    const touched = gitRaw(["log", "--name-only", "--format=", "refs/remotes/origin/main..HEAD"], projectDir).split("\n").filter(Boolean);
    unpushed = [...new Set(touched)].filter((p) => !PIPELINE_RECORDS.test(p));
  } catch (e) { return fail([`could not compare main with origin's: ${e.message}`]); }
  if (unpushed.length) {
    const listed = `${unpushed.slice(0, 5).join(", ")}${unpushed.length > 5 ? `, and ${unpushed.length - 5} more` : ""}`;
    return fail([`main has commits origin does not, changing ${listed}; push main first, so a trial publishes only this deploy's files and the pipeline's own records`]);
  }
  let sha;
  try { sha = trialCommit(projectDir, `deploy(${platform}): trial`); }
  catch (e) { return fail([`could not commit the trial: ${e.message}`]); }
  const adds = gitRaw(["diff", "--name-only", "HEAD", sha], projectDir).split("\n").filter(Boolean);
  const leaks = [...checkEgress(projectDir, { config, files: adds }).messages, ...credentialShapes(projectDir, adds)];
  if (leaks.length) return fail([`the trial would publish what must not leave this machine, so nothing was pushed:\n${leaks.join("\n")}`]);
  let readable;
  try {
    const count = async (path) => Number(String(await call(["api", `repos/${repo}/${path}`, "--jq", ".total_count"])).trim()) || 0;
    readable = { repo: await count("actions/secrets"), org: await count("actions/organization-secrets") };
  } catch (e) { return fail([`could not ask GitHub which secrets ${repo}'s workflows can read: ${e.message}`]); }
  if (readable.repo || readable.org) {
    return fail([`${repo}'s workflows can read ${plural(readable.repo, "repository secret")} and ${plural(readable.org, "organization secret")}, which no environment holds back; a trial runs a workflow before it is ruled on, so keep secrets in the environments that use them`]);
  }
  try { gitRaw(["push", "-q", "--force", "origin", `${sha}:refs/heads/${TRIAL_BRANCH}`], projectDir); }
  catch (e) { return fail([`could not push the trial to ${TRIAL_BRANCH}: ${e.message}`]); }

  // The push may start other workflows too, and a workflow that is not yet on the default branch
  // cannot be asked for by file, so the deploy's run is found among the trial branch's runs by its
  // commit and its workflow's name, which GitHub takes from the file's `name:` or else its path.
  const workflowFile = deployWorkflow(platform);
  const workflow = basename(workflowFile);
  let workflowName = workflowFile;
  try {
    const declared = parseYaml(readText(join(projectDir, workflowFile)))?.name;
    if (typeof declared === "string" && declared.trim()) workflowName = declared.trim();
  } catch { /* the post-checks read it before the trial, and refuse one that is not YAML */ }
  const runOf = async () => {
    const runs = JSON.parse(await call(["run", "list", "--repo", repo, "--branch", TRIAL_BRANCH, "--event", "push",
      "--limit", "30", "--json", "databaseId,headSha,status,conclusion,url,workflowName"]) || "[]");
    return runs.find((r) => r.headSha === sha && r.workflowName === workflowName) ?? null;
  };
  let run = null;
  try {
    for (let i = 0; !run; i++) {
      run = await runOf();
      if (run) break;
      if (i >= appearPolls) return fail([`GitHub started no run of ${workflow} for the trial commit ${sha.slice(0, 12)} on ${TRIAL_BRANCH}`]);
      await sleep(pollMs);
    }
    for (let i = 0; run.status !== "completed"; i++) {
      if (i >= finishPolls) return fail([`GitHub's run of the trial did not finish in time: ${run.url}`], { runUrl: run.url });
      await sleep(pollMs);
      run = (await runOf()) ?? run;
    }
    if (run.conclusion !== "success") {
      // Two deploys of development share one concurrency group, and a newer one waiting replaces
      // an older one that is still waiting.
      const why = run.conclusion === "cancelled" ? "; another deploy of development took its place; run the stage again" : "";
      let said = "";
      try { said = lastLines(await call(["run", "view", String(run.databaseId), "--repo", repo, "--log-failed"])); } catch { /* the run's page has it */ }
      return fail([`GitHub's run of the trial ended ${run.conclusion}: ${run.url}${why}${said ? `\n${said}` : ""}`], { runUrl: run.url });
    }
    // A finished run's log can take a moment to be readable in full.
    let url = null;
    for (let i = 1; !url; i++) {
      url = /DEPLOYED_URL=(\S+)/.exec(await call(["run", "view", String(run.databaseId), "--repo", repo, "--log"]))?.[1] ?? null;
      if (url) break;
      if (i >= tries) return fail([`GitHub's run of the trial succeeded but printed no DEPLOYED_URL=<address> line: ${run.url}`], { runUrl: run.url });
      await sleep(pollMs);
    }
    let status;
    try { status = (await fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) })).status; }
    catch (e) { return fail([`${url} did not answer: ${e.message}`], { url, runUrl: run.url }); }
    if (status >= 400) return fail([`${url} answered ${status}`], { url, status, runUrl: run.url });
    return { id, ok: true, url, status, runUrl: run.url, messages: [] };
  } catch (e) {
    return fail([`could not follow GitHub's run of the trial: ${e.message}`], run ? { runUrl: run.url } : {});
  }
}

export const deploy = {
  name: "deploy",
  title: (ctx) => `deploy to ${ctx.platform}`,
  skill: skillPath("deploy"),
  workspace: "deploy",
  // A run delivers its own platform's files, and the changes to the application its plan names.
  // Asked with no platform, as the registry asks when it works out which stage can deliver a
  // path, it delivers any platform's it has a profile for.
  collect: (ctx) => [...(ctx?.platform ? [ctx.platform] : deployProfiles()).flatMap((p) => [deployDir(p), deployWorkflow(p)]), "app", "docs/decisions"],
  gate: "G3",
  proposalPrefix: "deploy-",
  defaultTurns: 80,
  implemented: true,
  allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash(ls *)", "Bash(mkdir *)", "Bash(chmod *)"],
  prompt(ctx) {
    const p = ctx.platform;
    return [
      `Deploy the application in app/ to ${p}. First read app/ through and write ${deployPlan(p)}: every resource the application needs to run on ${p} and why, every change the application needs to deploy there (each by its path under app/, with what changes and why), and every secret it needs, by name and where it comes from, never a value.`,
      `Then make those changes to app/ and nothing else in it, and write the rest of ${deployDir(p)}/ (the one deployment definition and the one deploy script, ${deployScript(p)}) and ${deployWorkflow(p)}, which runs that same script. Once your files pass their checks, the person running the stage provisions what the definition names, signed in as themselves, and GitHub then deploys your work to the development environment as a trial.`,
      `The deploy profile for ${p} follows. It is the pipeline's standard for this platform; a departure from it is a decision record under docs/decisions/ naming what departs and why.`,
      profileText(p),
    ].join("\n\n");
  },
  proposal(ctx) {
    return {
      name: ctx.deployName ?? nextProposalName(ctx.projectDir, `deploy-${ctx.platform}`),
      question: `Is this the right way to deploy the application to ${ctx.platform}, and did its trial deploy the development environment?`,
      recommendation: recommendationFrom(ctx.agentText),
    };
  },
  // What provisioning did and what the trial saw, appended to the page the gate rules on.
  proposalEvidence(ctx) {
    const parts = [];
    const p = ctx.provisionRun;
    if (p?.ran) {
      parts.push(`## Provisioning\n\n${p.ok
        ? `The person who ran the stage, signed in as themselves, provisioned what ${deployDir(ctx.platform)}/ defines on ${ctx.platform} before the trial, and gave the identity GitHub deploys as only what a deploy needs.`
        : `Provisioning did not pass:\n\n${p.messages.join("\n")}`}`);
    }
    const r = ctx.deployRun;
    if (r) {
      const run = r.runUrl ? ` (${r.runUrl})` : "";
      parts.push(`## Trial deploy\n\n${r.ok
        ? `GitHub deployed the development environment from this proposal's trial commit${run}, and ${r.url} answered ${r.status}.`
        : `The trial deploy did not pass${run}:\n\n${r.messages.join("\n")}`}`);
    }
    if (!parts.length) return "";
    return redactLocalPaths(`\n\n${parts.join("\n\n")}\n`, ctx.projectDir ?? process.cwd());
  },
  // A setup run checks that the platform is one the project deploys to and has a setup; a deploy
  // run also needs the application. Neither needs a setup before it: a deploy run provisions what
  // its own definition names.
  preChecks(projectDir, ctx) {
    if (ctx.setup) return [checkPlatformOption(ctx), checkHasSetup(ctx.platform)];
    return [checkPlatformOption(ctx), checkApplicationExists(projectDir)];
  },
  // `--setup`: provisioning alone, from the definition the checkout holds.
  bootstrap(projectDir, ctx) {
    return bootstrapPlatform(projectDir, ctx.platform);
  },
  // Provisioning within a deploy run. It runs again on every repair turn, so a bootstrap makes
  // sure of what it creates rather than creating it twice.
  provision(projectDir, ctx) {
    return bootstrapPlatform(projectDir, ctx.platform);
  },
  async postChecks(projectDir, ctx) {
    ctx.deployName = nextProposalName(projectDir, `deploy-${ctx.platform}`);
    const before = [
      checkDeployScope(projectDir, ctx.platform), checkDeployFiles(projectDir, ctx.platform),
      checkDefinitionScope(projectDir, ctx.platform), checkWorkflowCallsScript(projectDir, ctx.platform),
    ];
    if (before.some((r) => !r.ok) || ctx.dryRun) return before;
    const provisioned = await deploy.provision(projectDir, ctx);
    ctx.provisionRun = provisioned;
    const provision = { id: "deploy-provision", ok: provisioned.ok, messages: provisioned.ok ? [] : provisioned.messages };
    if (!provision.ok) return [...before, provision];
    const run = await trialDeploy(projectDir, ctx.platform, { config: ctx.config });
    ctx.deployRun = run;
    return [...before, provision, run];
  },
};

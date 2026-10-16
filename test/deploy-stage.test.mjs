import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config/load.mjs";
import { routeOf, SUBJECT_OF } from "../src/runner/routes.mjs";
import { STAGES_BY_NAME } from "../src/stages/registry.mjs";
import { PIPELINE_ROOT } from "../src/lib/root.mjs";
import {
  deploy, deployProfiles, profileText, checkDeployFiles, checkWorkflowCallsScript, testEnvironmentRun,
  bootstrapPlatform, deploySettingsFile, readDeploySettings,
} from "../src/stages/deploy.mjs";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { workspaceScopeViolations } from "../src/runner/workspace.mjs";

const BASE = `
pipeline: { repo: agentic-sdlc, ref: v0.1.0 }
profile: greenfield
stack: openshift-ts
project: { name: example-service, domains: [accounts] }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-1, E-2, E-3, E-4] }
`;

function project(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-deploy-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function lay(d, platform, { workflow = true, callsScript = true } = {}) {
  mkdirSync(join(d, "deploy", platform), { recursive: true });
  mkdirSync(join(d, ".github", "workflows"), { recursive: true });
  writeFileSync(join(d, "deploy", platform, "main.bicep"), "targetScope = 'resourceGroup'\n");
  writeFileSync(join(d, "deploy", platform, "deploy.sh"), "#!/usr/bin/env bash\necho ok\n");
  if (workflow) {
    writeFileSync(join(d, ".github", "workflows", `deploy-${platform}.yml`),
      `name: deploy\non: { push: { branches: [development] }, workflow_dispatch: {} }\njobs:\n  go:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: ${callsScript ? `bash deploy/${platform}/deploy.sh development` : "echo nothing"}\n`);
  }
}

test("the deploy setting is a list of platforms and is not the targets setting", () => {
  const { config, errors } = parseConfig(`${BASE}deploy: [azure-container-apps]\n`);
  assert.deepEqual(errors, []);
  assert.deepEqual(config.deploy, ["azure-container-apps"]);
  assert.equal(config.targets, undefined);
  const bad = parseConfig(`${BASE}deploy: azure-container-apps\n`);
  assert.ok(bad.errors.length);
});

test("a deploy proposal is routed to the deploy stage and its platform", () => {
  assert.deepEqual(routeOf("deploy-azure-container-apps", {}), { stage: "deploy", platform: "azure-container-apps" });
  assert.deepEqual(routeOf("deploy-azure-container-apps-2", {}), { stage: "deploy", platform: "azure-container-apps" });
  assert.equal(SUBJECT_OF.deploy, "platform");
});

test("the deploy stage is implemented, gated at G3 and works from the project", () => {
  assert.equal(deploy.implemented, true);
  assert.equal(STAGES_BY_NAME.deploy, deploy);
  assert.equal(deploy.gate, "G3");
  assert.equal(deploy.workspace, "project");
  assert.deepEqual(workspaceScopeViolations("deploy", deploy.workspace, deploy.collect, deploy.context?.({ platform: "azure-container-apps" }) ?? []), []);
});

test("each platform has a deploy profile and the stack names no deploy", () => {
  assert.deepEqual(deployProfiles(), ["azure-container-apps", "openshift"]);
  for (const p of deployProfiles()) assert.match(profileText(p), /^# /m);
  const stack = readFileSync(join(PIPELINE_ROOT, "stacks", "openshift-ts", "SKILL.md"), "utf8");
  assert.doesNotMatch(stack, /^## Deploy/m);
  assert.doesNotMatch(stack, /quickstart-openshift-helpers/);
  const plan = readFileSync(join(PIPELINE_ROOT, "src", "stages", "skills", "plan.md"), "utf8");
  assert.doesNotMatch(plan, /sign-in flow, deploy/);
  assert.match(profileText("openshift"), /quickstart-openshift-helpers/);
});

test("a platform the project does not list, or without a profile, fails the pre-checks", (t) => {
  const d = project(t);
  mkdirSync(join(d, "app"));
  const { config } = parseConfig(`${BASE}deploy: [openshift]\n`);
  const run = (platform) => deploy.preChecks(d, { platform, config }).filter((r) => !r.ok).flatMap((r) => r.messages);
  assert.deepEqual(run("openshift"), []);
  assert.match(run("azure-container-apps").join("\n"), /not in the project's deploy setting/);
  assert.match(run(undefined).join("\n"), /--platform/);
  const c2 = parseConfig(`${BASE}deploy: [nowhere]\n`).config;
  assert.match(deploy.preChecks(d, { platform: "nowhere", config: c2 }).flatMap((r) => r.messages).join("\n"), /no deploy profile/);
});

test("the definition, the script and the workflow must all exist", (t) => {
  const d = project(t);
  assert.equal(checkDeployFiles(d, "azure-container-apps").ok, false);
  lay(d, "azure-container-apps");
  assert.equal(checkDeployFiles(d, "azure-container-apps").ok, true);
  const e = project(t);
  lay(e, "azure-container-apps", { workflow: false });
  assert.match(checkDeployFiles(e, "azure-container-apps").messages.join("\n"), /deploy-azure-container-apps\.yml/);
});

test("the workflow must call the script the stage ran", (t) => {
  const d = project(t);
  lay(d, "azure-container-apps");
  assert.equal(checkWorkflowCallsScript(d, "azure-container-apps").ok, true);
  const e = project(t);
  lay(e, "azure-container-apps", { callsScript: false });
  assert.equal(checkWorkflowCallsScript(e, "azure-container-apps").ok, false);
});

test("the development run needs the script to succeed and the app to answer", async (t) => {
  const d = project(t);
  lay(d, "azure-container-apps");
  const ok = async () => ({ status: 200 });
  const exec = (out, status = 0) => () => ({ status, stdout: out, stderr: "" });
  const seen = [];
  const good = await testEnvironmentRun(d, "azure-container-apps", {
    exec: (...a) => { seen.push(a); return exec("working\nDEPLOYED_URL=https://app.example.test\n")(); }, fetchFn: ok,
  });
  assert.equal(good.ok, true);
  assert.equal(good.url, "https://app.example.test");
  assert.equal(seen[0][0], "bash");
  assert.deepEqual(seen[0][1], ["deploy/azure-container-apps/deploy.sh", "development"]);

  const failed = await testEnvironmentRun(d, "azure-container-apps", { exec: exec("", 3), fetchFn: ok });
  assert.equal(failed.ok, false);
  const noUrl = await testEnvironmentRun(d, "azure-container-apps", { exec: exec("done\n"), fetchFn: ok });
  assert.match(noUrl.messages.join("\n"), /DEPLOYED_URL/);
  const down = await testEnvironmentRun(d, "azure-container-apps", {
    exec: exec("DEPLOYED_URL=https://app.example.test\n"), fetchFn: async () => ({ status: 503 }),
  });
  assert.equal(down.ok, false);
  assert.match(down.messages.join("\n"), /503/);
});

test("the proposal page carries what the development run saw", (t) => {
  const d = project(t);
  const ctx = { platform: "openshift", deployRun: { ok: true, url: "https://app.example.test", status: 200, messages: [] } };
  const page = deploy.proposalEvidence(ctx);
  assert.match(page, /Development run/);
  assert.match(page, /development environment/);
  assert.match(page, /https:\/\/app\.example\.test/);
  assert.equal(existsSync(d), true);
});

// ---- setting up the platform before the turn ----

function profileWith(t, platform, scripts) {
  const root = project(t);
  mkdirSync(join(root, platform, "bootstrap"), { recursive: true });
  writeFileSync(join(root, platform, "SKILL.md"), "# profile\n");
  for (const [name, body] of Object.entries(scripts)) writeFileSync(join(root, platform, "bootstrap", name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  return root;
}

test("the settings a bootstrap chose live in a file every project already ignores", () => {
  assert.equal(deploySettingsFile("azure-container-apps"), ".sdlc/deploy-azure-container-apps.local.txt");
  const ignores = readFileSync(join(PIPELINE_ROOT, "src", "lib", "git.mjs"), "utf8");
  assert.match(ignores, /"\.sdlc\/\*\.local\.txt"/);
});

test("a platform with no bootstrap has nothing to set up", (t) => {
  const d = project(t);
  const profiles = project(t);
  mkdirSync(join(profiles, "openshift"));
  const r = bootstrapPlatform(d, "openshift", { profilesDir: profiles, stdio: "pipe" });
  assert.equal(r.ok, true);
  assert.equal(r.ran, false);
});

test("the preflight runs first, and a failing preflight stops the bootstrap", (t) => {
  const d = project(t);
  const profiles = profileWith(t, "cloud", {
    "preflight.sh": "echo 'not signed in' >&2; exit 1",
    "bootstrap.sh": "touch \"$SDLC_PROJECT_DIR/bootstrapped\"",
  });
  const r = bootstrapPlatform(d, "cloud", { profilesDir: profiles, stdio: "pipe" });
  assert.equal(r.ok, false);
  assert.match(r.messages.join("\n"), /preflight/);
  assert.equal(existsSync(join(d, "bootstrapped")), false);
});

test("what the bootstrap chose is kept, named without its values, and handed to the development run", async (t) => {
  const d = project(t);
  const profiles = profileWith(t, "cloud", {
    "preflight.sh": "true",
    "bootstrap.sh": "mkdir -p \"$(dirname \"$SDLC_SETTINGS_FILE\")\"; printf 'RESOURCE_GROUP=rg-example-test\\nLOCATION=%s\\n' \"$SDLC_PLATFORM-region\" > \"$SDLC_SETTINGS_FILE\"",
  });
  const r = bootstrapPlatform(d, "cloud", { profilesDir: profiles, stdio: "pipe" });
  assert.equal(r.ok, true, r.messages.join("\n"));
  assert.deepEqual(readDeploySettings(d, "cloud"), { RESOURCE_GROUP: "rg-example-test", LOCATION: "cloud-region" });
  const said = r.messages.join("\n");
  assert.match(said, /RESOURCE_GROUP, LOCATION/);
  assert.doesNotMatch(said, /rg-example-test/);
  assert.match(said, /set -a; \. \.sdlc\/deploy-cloud\.local\.txt; set \+a/);
  assert.ok(!said.includes(d), "no local path is reported");

  lay(d, "cloud");
  let seen;
  await testEnvironmentRun(d, "cloud", {
    env: { PATH: process.env.PATH, RESOURCE_GROUP: "stale" },
    exec: (cmd, args, opts) => { seen = opts.env; return { status: 0, stdout: "DEPLOYED_URL=https://app.example.test\n", stderr: "" }; },
    fetchFn: async () => ({ status: 200 }),
  });
  assert.equal(seen.RESOURCE_GROUP, "rg-example-test");
  assert.equal(seen.LOCATION, "cloud-region");
});

test("a bootstrap that writes no settings has not set the platform up", (t) => {
  const d = project(t);
  const profiles = profileWith(t, "cloud", { "preflight.sh": "true", "bootstrap.sh": "true" });
  const r = bootstrapPlatform(d, "cloud", { profilesDir: profiles, stdio: "pipe" });
  assert.equal(r.ok, false);
  assert.match(r.messages.join("\n"), /wrote no settings/);
});

const AZ = join(PIPELINE_ROOT, "deploys", "azure-container-apps", "bootstrap");

test("the Azure bootstrap scripts parse", () => {
  for (const f of ["lib.sh", "preflight.sh", "bootstrap.sh"]) {
    const r = spawnSync("bash", ["-n", join(AZ, f)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test("an answer is taken from the environment, then a default, and is never guessed without a terminal", () => {
  const ask = (env, args) => spawnSync("bash", ["-c", `. "${join(AZ, "lib.sh")}"; ask ${args} </dev/null; echo "got=$REGION"`],
    { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.match(ask({ REGION: "region-a" }, "REGION 'Which region?'").stdout, /got=region-a/);
  assert.match(ask({}, "REGION 'Which region?' region-b").stdout, /got=region-b/);
  const none = ask({}, "REGION 'Which region?'");
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /REGION/);
});

test("the Azure preflight says when the Azure CLI is not signed in", (t) => {
  const bin = project(t);
  writeFileSync(join(bin, "az"), "#!/bin/sh\ncase \"$1 $2\" in\n  'account show') echo 'Please run az login' >&2; exit 1 ;;\n  *) exit 0 ;;\nesac\n");
  chmodSync(join(bin, "az"), 0o755);
  const r = spawnSync("bash", [join(AZ, "preflight.sh")], { encoding: "utf8", input: "", env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /not signed in/i);
});

const FROM = join(PIPELINE_ROOT, "fixture-project", "fixture.config.yaml");

test("a deploy whose preflight fails stops before any agent turn and records the run", async (t) => {
  const tmp = project(t);
  const keep = { PATH: process.env.PATH, SDLC_EGRESS_NAMES: process.env.SDLC_EGRESS_NAMES, SDLC_EXECUTOR: process.env.SDLC_EXECUTOR, SDLC_MOCK_DIR: process.env.SDLC_MOCK_DIR };
  t.after(() => { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  writeFileSync(join(tmp, "names.txt"), "");
  process.env.SDLC_EGRESS_NAMES = join(tmp, "names.txt");
  const dir = join(tmp, "service");
  await newProject({ dir, from: FROM });
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  const cfg = join(dir, ".sdlc", "config.yaml");
  writeFileSync(cfg, `${readFileSync(cfg, "utf8")}deploy: [azure-container-apps]\n`);
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app", "index.js"), "export {};\n");
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "built"], dir);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "az"), "#!/bin/sh\n[ \"$1 $2\" = 'account show' ] && exit 1\nexit 0\n");
  chmodSync(join(bin, "az"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = join(tmp, "no-replies");
  mkdirSync(process.env.SDLC_MOCK_DIR);
  const r = await runStage(dir, "deploy", { platform: "azure-container-apps" });
  assert.equal(r.ok, false);
  assert.match(r.messages.join("\n"), /preflight/);
  assert.match(git(["log", "-1", "--format=%s"], dir), /run\(deploy\): bootstrap failed/);
  assert.equal(existsSync(join(dir, ".sdlc", "run-state.json")), false);
});

test("the Azure bootstrap creates the shared, development and production groups and tests in development", (t) => {
  const tmp = project(t);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const log = join(tmp, "az.log");
  writeFileSync(join(bin, "az"), [
    "#!/bin/bash",
    `echo "$*" >> "${log}"`,
    'case "$*" in',
    '  "account show --query id -o tsv") echo sub-id;;',
    '  "account show --query tenantId -o tsv") echo tenant-id;;',
    '  "provider show --namespace Microsoft.App --query"*) echo region-a;;',
    '  "provider show"*) echo Registered;;',
    '  "group show"*|"acr show --name"*"--query id"*|"identity show --resource-group"*) exit 3;;',
    '  "acr check-name"*) echo true;;',
    '  "acr create"*) echo /subscriptions/sub-id/resourceGroups/rg-svc-shared/providers/Microsoft.ContainerRegistry/registries/svcacr;;',
    '  "acr show"*loginServer*) echo svcacr.azurecr.io;;',
    '  "identity create"*) echo /subscriptions/sub-id/resourceGroups/rg-svc-shared/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-svc-pull;;',
    '  "identity show --ids"*) echo principal-id;;',
    "esac",
    "",
  ].join("\n"));
  chmodSync(join(bin, "az"), 0o755);
  const settings = join(tmp, deploySettingsFile("azure-container-apps"));
  const r = spawnSync("bash", [join(AZ, "bootstrap.sh")], {
    cwd: tmp, encoding: "utf8", input: "",
    env: { PATH: `${bin}:${process.env.PATH}`, SDLC_PROJECT_DIR: tmp, SDLC_SETTINGS_FILE: settings,
      NAME_PREFIX: "svc", LOCATION: "region-a", GITHUB_REPO: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  const created = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("group create"))
    .map((l) => /--name (\S+)/.exec(l)[1]);
  assert.deepEqual(created, ["rg-svc-shared", "rg-svc-development", "rg-svc-production"]);
  const saved = readDeploySettings(tmp, "azure-container-apps");
  assert.equal(saved.RESOURCE_GROUP, "rg-svc-development");
  assert.equal(saved.RESOURCE_GROUP_PRODUCTION, "rg-svc-production");
  assert.equal("RESOURCE_GROUP_DEVELOPMENT" in saved, false);
});

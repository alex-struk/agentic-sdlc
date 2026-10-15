import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config/load.mjs";
import { routeOf, SUBJECT_OF } from "../src/runner/routes.mjs";
import { STAGES_BY_NAME } from "../src/stages/registry.mjs";
import { PIPELINE_ROOT } from "../src/lib/root.mjs";
import {
  deploy, deployProfiles, profileText, checkDeployFiles, checkWorkflowCallsScript, testEnvironmentRun,
} from "../src/stages/deploy.mjs";

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
  assert.deepEqual(deploy.collect({ platform: "azure-container-apps" }).sort(),
    [".github/workflows/deploy-azure-container-apps.yml", "deploy/azure-container-apps"].sort());
  assert.deepEqual(deploy.collect({}), []);
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

test("the test-environment run needs the script to succeed and the app to answer", async (t) => {
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
  assert.deepEqual(seen[0][1], ["deploy/azure-container-apps/deploy.sh", "test"]);

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

test("the proposal page carries what the test-environment run saw", (t) => {
  const d = project(t);
  const ctx = { platform: "openshift", deployRun: { ok: true, url: "https://app.example.test", status: 200, messages: [] } };
  const page = deploy.proposalEvidence(ctx);
  assert.match(page, /Test-environment run/);
  assert.match(page, /https:\/\/app\.example\.test/);
  assert.equal(existsSync(d), true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config/load.mjs";
import { routeOf, SUBJECT_OF } from "../src/runner/routes.mjs";
import { STAGES_BY_NAME } from "../src/stages/registry.mjs";
import { PIPELINE_ROOT } from "../src/lib/root.mjs";
import {
  deploy, deployProfiles, profileText, checkDeployFiles, checkWorkflowCallsScript, trialDeploy, TRIAL_BRANCH,
  bootstrapPlatform, deploySettingsFile, readDeploySettings,
} from "../src/stages/deploy.mjs";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";
import { IN_PLACE_MODES, MODES, workspaceScopeViolations } from "../src/runner/workspace.mjs";

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

const PIN = "0123456789abcdef0123456789abcdef01234567";

function lay(d, platform, {
  workflow = true, callsScript = true, on = "{ push: { branches: [main, development] }, workflow_dispatch: {} }",
  permissions = "{}", jobPermissions = "{ contents: read, id-token: write }", steps = [`- uses: actions/checkout@${PIN}`], jobUses,
} = {}) {
  mkdirSync(join(d, "deploy", platform), { recursive: true });
  mkdirSync(join(d, ".github", "workflows"), { recursive: true });
  writeFileSync(join(d, "deploy", platform, "main.bicep"), "targetScope = 'resourceGroup'\n");
  writeFileSync(join(d, "deploy", platform, "deploy.sh"), "#!/usr/bin/env bash\necho ok\n");
  if (workflow) {
    const job = jobUses
      ? [`  go:`, `    uses: ${jobUses}`]
      : [`  go:`, `    runs-on: ubuntu-24.04`, ...(jobPermissions === null ? [] : [`    permissions: ${jobPermissions}`]), `    steps:`,
        ...steps.map((s) => `      ${s}`), `      - run: ${callsScript ? `bash deploy/${platform}/deploy.sh development` : "echo nothing"}`];
    writeFileSync(join(d, ".github", "workflows", `deploy-${platform}.yml`), [
      "name: deploy", `on: ${on}`, ...(permissions === null ? [] : [`permissions: ${permissions}`]), "jobs:", ...job, "",
    ].join("\n"));
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

test("the deploy stage is implemented, gated at G3, and writes only its platform's files from a workspace of its own", () => {
  assert.equal(deploy.implemented, true);
  assert.equal(STAGES_BY_NAME.deploy, deploy);
  assert.equal(deploy.gate, "G3");
  const ctx = { platform: "azure-container-apps" };
  assert.deepEqual(deploy.collect(ctx), ["deploy/azure-container-apps", ".github/workflows/deploy-azure-container-apps.yml", "docs/decisions"]);
  assert.deepEqual(workspaceScopeViolations("deploy", deploy.workspace, deploy.collect(ctx), deploy.context?.(ctx) ?? []), []);
  // The application is read, not changed; and a workspace that is not the project tree is one a
  // person's branch can be handed in to.
  assert.ok(MODES[deploy.workspace].includes("app"));
  assert.equal(IN_PLACE_MODES.has(deploy.workspace), false);
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

test("the workflow deploys development on a push to main or to development, and production only by hand", (t) => {
  const P = "azure-container-apps";
  for (const [on, why] of [
    ["{ push: { branches: [development] }, workflow_dispatch: {} }", /on a push to main/],
    ["{ push: { branches: [main] }, workflow_dispatch: {} }", /on a push to development, the branch a deploy's trial is pushed to/],
    ["{ push: { branches: [main, development] } }", /workflow_dispatch/],
  ]) {
    const d = project(t);
    lay(d, P, { on });
    assert.match(checkWorkflowCallsScript(d, P).messages.join("\n"), why, on);
  }
});

test("the workflow a trial runs before it is ruled on pins every action and grants nothing but a read and a sign-in token", (t) => {
  const P = "azure-container-apps";
  const said = (opts) => { const d = project(t); lay(d, P, opts); return checkWorkflowCallsScript(d, P).messages.join("\n"); };
  assert.match(said({ steps: ["- uses: actions/checkout@v7"] }), /actions\/checkout@v7, which is not pinned to a full commit SHA/);
  assert.match(said({ jobUses: "example/workflows/.github/workflows/deploy.yml@main" }), /deploy\.yml@main, which is not pinned to a full commit SHA/);
  assert.match(said({ jobPermissions: "{ contents: write, id-token: write }" }), /job go contents: write/);
  assert.match(said({ permissions: "write-all" }), /grants the workflow write-all/);
  assert.match(said({ permissions: null }), /sets no permissions of its own/);
  // A job with no permissions of its own has the workflow's.
  assert.equal(said({ jobPermissions: null }), "");
  // Images kept in GitHub's own container registry are pushed with the job's token, or only read.
  assert.equal(said({ jobPermissions: "{ contents: read, id-token: write, packages: write }" }), "");
  assert.equal(said({ jobPermissions: "{ contents: read, id-token: write, packages: read }" }), "");
});

test("a workflow a trial runs reads no secret it was not handed by name, and runs no image or local action it has not pinned", (t) => {
  const P = "azure-container-apps";
  const said = (opts, extra = {}) => {
    const d = project(t);
    lay(d, P, opts);
    for (const [rel, text] of Object.entries(extra)) { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), text); }
    return checkWorkflowCallsScript(d, P).messages.join("\n");
  };
  assert.match(said({ steps: ["- run: echo '${{ toJSON(secrets) }}'"] }), /reads every secret at once/);
  assert.match(said({ steps: ["- run: echo '${{ secrets[matrix.name] }}'"] }), /reads a secret by a name worked out at run time/);
  assert.match(said({ jobUses: `example/workflows/.github/workflows/deploy.yml@${PIN}\n    secrets: inherit` }), /hands every secret on/);
  // An action in the repository is read as the workflow is: what it uses is pinned too.
  const composite = "runs:\n  using: composite\n  steps:\n    - uses: example/tool@v2\n";
  assert.match(said({ steps: ["- uses: ./deploy/azure-container-apps/act"] }, { "deploy/azure-container-apps/act/action.yml": composite }),
    /deploy\/azure-container-apps\/act uses example\/tool@v2, which is not pinned/);
  assert.match(said({ steps: ["- uses: ./deploy/azure-container-apps/missing"] }), /missing, which is not in the repository/);
  assert.equal(said({ steps: ["- uses: ./deploy/azure-container-apps/act"] }, { "deploy/azure-container-apps/act/action.yml": `runs:\n  using: composite\n  steps:\n    - uses: example/tool@${PIN}\n` }), "");
  assert.match(said({ steps: ["- uses: docker://alpine:3"] }), /docker:\/\/alpine:3, which is not pinned to an image digest/);
  assert.match(said({ jobPermissions: "{ contents: read }\n    container: node:24" }), /job go runs in node:24, which is not pinned to an image digest/);
  assert.equal(said({ jobPermissions: `{ contents: read }\n    container: node@sha256:${"a".repeat(64)}` }), "");
});

test("the Azure profile's deploy script runs the image its own run built, by digest, so an image another deploy pushed under that tag is never what it runs", () => {
  const script = readFileSync(join(PIPELINE_ROOT, "deploys", "azure-container-apps", "templates", "deploy", "azure-container-apps", "deploy.sh"), "utf8");
  assert.doesNotMatch(script, /manifest inspect/, "the build is never skipped because the tag is already there");
  assert.match(script, /RepoDigests/);
  assert.match(script, /deploy_stack true "\$DIGEST"/);
  const skill = readFileSync(join(PIPELINE_ROOT, "deploys", "azure-container-apps", "SKILL.md"), "utf8");
  assert.match(skill.replace(/\s+/g, " "), /by the digest of the image its own run pushed/);
});

test("the Azure profile's own workflow template passes the checks a project's workflow is held to", (t) => {
  const d = project(t);
  const P = "azure-container-apps";
  lay(d, P, { workflow: false });
  const tpl = readFileSync(join(PIPELINE_ROOT, "deploys", P, "templates", ".github", "workflows", `deploy-${P}.yml`), "utf8");
  writeFileSync(join(d, ".github", "workflows", `deploy-${P}.yml`), tpl);
  assert.deepEqual(checkWorkflowCallsScript(d, P).messages, []);
});

// ---- the trial, on GitHub ----

const ID = ["-c", "user.name=t", "-c", "user.email=t@example.org"];

const GITHUB_URL = "https://github.com/example/service.git";

// `origin` as a project on GitHub names it, with git told to fetch and push it from a bare
// repository on this machine, so the trial's own git commands run for real.
function originOnGitHub(d, remote) {
  git(["remote", "add", "origin", GITHUB_URL], d);
  git(["config", `url.${remote}.insteadOf`, GITHUB_URL], d);
}

// A project whose `origin` is that, with `main` pushed to it, and a deploy's files laid in the
// working tree as a session leaves them.
function pushedProject(t, { settings } = {}) {
  const root = project(t);
  const remote = join(root, "origin.git");
  const d = join(root, "service");
  mkdirSync(d);
  git(["init", "-q", "--bare", "-b", "main", remote], root);
  git(["init", "-q", "-b", "main"], d);
  writeFileSync(join(d, ".gitignore"), ".sdlc/*.local.txt\n");
  writeFileSync(join(d, "README.md"), "service\n");
  git(["add", "-A"], d); git([...ID, "commit", "-q", "-m", "start"], d);
  originOnGitHub(d, remote);
  git(["push", "-q", "origin", "main"], d);
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  if (settings) writeFileSync(join(d, deploySettingsFile("azure-container-apps")), settings);
  lay(d, "azure-container-apps");
  return { d, remote };
}

// `gh` as GitHub would answer it for one run of the workflow on the commit the trial pushed: not
// listed at first, then running, then finished with `conclusion` and the log the script wrote.
// `secrets` are how many repository and organisation secrets the repository's workflows can read;
// the first `failing` calls fail as a network or GitHub's API sometimes does.
function fakeGh(remote, { conclusion = "success", log = "deploy\tDeploy\t2026-10-19T00:00:00Z DEPLOYED_URL=https://app.example.test\n", secrets = { repo: 0, org: 0 }, failing = 0 } = {}) {
  const calls = [];
  let lists = 0;
  let failed = 0;
  const gh = (args) => {
    calls.push(args);
    if (failed < failing) { failed += 1; throw new Error("gh run list failed: connection reset"); }
    if (args[0] === "api" && args[1] === "repos/example/service/actions/secrets") return `${secrets.repo}\n`;
    if (args[0] === "api" && args[1] === "repos/example/service/actions/organization-secrets") return `${secrets.org}\n`;
    if (args[0] === "run" && args[1] === "list") {
      lists += 1;
      if (lists === 1) return "[]";
      const headSha = git(["rev-parse", `refs/heads/${TRIAL_BRANCH}`], remote);
      // Another workflow ran on the same push, and finished first; it is not the deploy.
      const other = { databaseId: 6, headSha, status: "completed", conclusion: "failure", url: "https://github.example/run/6", workflowName: "checks" };
      return JSON.stringify([other, { databaseId: 7, headSha, status: lists === 2 ? "in_progress" : "completed", conclusion: lists === 2 ? "" : conclusion, url: "https://github.example/run/7", workflowName: "deploy" }]);
    }
    if (args[0] === "run" && args[1] === "view") return args.includes("--log-failed") ? "deploy\tDeploy\tthe registry refused the push\n" : log;
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, calls };
}

const quick = { sleep: async () => {}, fetchFn: async () => ({ status: 200 }) };

test("a trial commits the session's work on top of main, pushes it to the trial branch, and reads what GitHub's deploy of it said", async (t) => {
  const { d, remote } = pushedProject(t);
  const head = git(["rev-parse", "HEAD"], d);
  const status = git(["status", "--porcelain"], d);
  const { gh, calls } = fakeGh(remote);
  const r = await trialDeploy(d, "azure-container-apps", { gh, ...quick });
  assert.deepEqual(r.messages, []);
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://app.example.test");
  assert.equal(r.status, 200);
  assert.equal(r.runUrl, "https://github.example/run/7");
  // The trial branch holds the session's files on top of main, and nothing here moved.
  const pushed = git(["rev-parse", `refs/heads/${TRIAL_BRANCH}`], remote);
  assert.equal(git(["rev-parse", `${pushed}^`], remote), head);
  assert.match(git(["show", `${pushed}:.github/workflows/deploy-azure-container-apps.yml`], remote), /deploy\.sh development/);
  assert.notEqual(spawnSync("git", ["cat-file", "-e", `${pushed}:${deploySettingsFile("azure-container-apps")}`], { cwd: remote }).status, 0, "the settings file is not pushed");
  assert.equal(git(["rev-parse", "HEAD"], d), head);
  assert.equal(git(["status", "--porcelain"], d), status);
  // GitHub was asked about origin's repository, for the runs a push to the trial branch started;
  // the deploy's is told from the others by its commit and its workflow's name.
  const list = calls.find((c) => c[1] === "list");
  assert.deepEqual(list.slice(0, 8), ["run", "list", "--repo", "example/service", "--branch", TRIAL_BRANCH, "--event", "push"]);
  assert.ok(calls.some((c) => c[1] === "view" && c[2] === "7"), "the deploy's run is the one read");
});

const nothingPushed = (remote) => spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${TRIAL_BRANCH}`], { cwd: remote }).status === 1;

test("a trial is refused while main has commits GitHub does not, so it publishes only the deploy's files", async (t) => {
  const { d, remote } = pushedProject(t);
  writeFileSync(join(d, "NOTES.md"), "not pushed\n");
  git(["add", "NOTES.md"], d); git([...ID, "commit", "-q", "-m", "local only"], d);
  lay(d, "azure-container-apps");
  const { gh, calls } = fakeGh(remote);
  const r = await trialDeploy(d, "azure-container-apps", { gh, ...quick });
  assert.equal(r.ok, false);
  assert.match(r.messages.join("\n"), /changing NOTES\.md; push main first/);
  assert.equal(calls.length, 0);
  assert.ok(nothingPushed(remote));
});

test("a file a later commit took out again is still in the history a trial would publish", async (t) => {
  const { d, remote } = pushedProject(t);
  writeFileSync(join(d, "NOTES.md"), "not pushed\n");
  git(["add", "NOTES.md"], d); git([...ID, "commit", "-q", "-m", "local only"], d);
  git(["rm", "-q", "NOTES.md"], d); git([...ID, "commit", "-q", "-m", "taken out"], d);
  const r = await trialDeploy(d, "azure-container-apps", { gh: fakeGh(remote).gh, ...quick });
  assert.match(r.messages.join("\n"), /changing NOTES\.md; push main first/);
  assert.ok(nothingPushed(remote));
  // The pipeline's records are the run records and the journal, not the project's configuration.
  const config = pushedProject(t);
  writeFileSync(join(config.d, ".sdlc", "config.yaml"), "deploy: [azure-container-apps]\n");
  git(["add", ".sdlc/config.yaml"], config.d); git([...ID, "commit", "-q", "-m", "config"], config.d);
  const c = await trialDeploy(config.d, "azure-container-apps", { gh: fakeGh(config.remote).gh, ...quick });
  assert.match(c.messages.join("\n"), /changing \.sdlc\/config\.yaml/);
});

test("a trial whose files hold a home path or a credential is refused before anything is published", async (t) => {
  const home = pushedProject(t);
  writeFileSync(join(home.d, "deploy", "azure-container-apps", "notes.md"), `Built on ${"/" + "home/"}someone/work.\n`);
  const a = await trialDeploy(home.d, "azure-container-apps", { gh: fakeGh(home.remote).gh, ...quick });
  assert.match(a.messages.join("\n"), /deploy\/azure-container-apps\/notes\.md:1: local home path/);
  assert.ok(nothingPushed(home.remote));

  const key = pushedProject(t);
  writeFileSync(join(key.d, "deploy", "azure-container-apps", "id.txt"), `${"-----BEGIN " + "PRIVATE KEY-----"}\nMIIE\n`);
  const b = await trialDeploy(key.d, "azure-container-apps", { gh: fakeGh(key.remote).gh, ...quick });
  assert.match(b.messages.join("\n"), /deploy\/azure-container-apps\/id\.txt:1: a private key/);
  assert.ok(nothingPushed(key.remote));
});

test("a trial is refused while the repository's workflows can read secrets that no environment holds back", async (t) => {
  const { d, remote } = pushedProject(t);
  const r = await trialDeploy(d, "azure-container-apps", { gh: fakeGh(remote, { secrets: { repo: 2, org: 1 } }).gh, ...quick });
  assert.equal(r.ok, false);
  assert.match(r.messages.join("\n"), /can read 2 repository secrets and 1 organization secret/);
  assert.ok(nothingPushed(remote));
});

test("a trial rides out a call to GitHub that fails, follows origin's repository, and says when another deploy took its place", async (t) => {
  const flaky = pushedProject(t);
  const a = await trialDeploy(flaky.d, "azure-container-apps", { gh: fakeGh(flaky.remote, { failing: 2 }).gh, ...quick });
  assert.deepEqual(a.messages, []);

  const elsewhere = pushedProject(t, { settings: "GITHUB_REPO=example/other\n" });
  const b = await trialDeploy(elsewhere.d, "azure-container-apps", { gh: fakeGh(elsewhere.remote).gh, ...quick });
  assert.match(b.messages.join("\n"), /the setup named example\/other, but origin is example\/service/);
  assert.ok(nothingPushed(elsewhere.remote));

  const replaced = pushedProject(t);
  const c = await trialDeploy(replaced.d, "azure-container-apps", { gh: fakeGh(replaced.remote, { conclusion: "cancelled" }).gh, ...quick });
  assert.match(c.messages.join("\n"), /ended cancelled.*another deploy of development took its place; run the stage again/s);
});

test("the pipeline's own records on main, a setup's run record among them, do not stop a trial", async (t) => {
  const { d, remote } = pushedProject(t);
  mkdirSync(join(d, ".sdlc", "runs"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "runs", "2026-10-19.md"), "# Run record 2026-10-19\n\n- run deploy: set up azure-container-apps\n");
  git(["add", ".sdlc/runs"], d); git([...ID, "commit", "-q", "-m", "run(deploy): set up azure-container-apps"], d);
  const head = git(["rev-parse", "HEAD"], d);
  const r = await trialDeploy(d, "azure-container-apps", { gh: fakeGh(remote).gh, ...quick });
  assert.deepEqual(r.messages, []);
  assert.equal(git(["rev-parse", `refs/heads/${TRIAL_BRANCH}^`], remote), head);
});

test("a trial that GitHub could not deploy, or that prints no address, or whose address does not answer, does not pass", async (t) => {
  const failed = pushedProject(t);
  const a = await trialDeploy(failed.d, "azure-container-apps", { gh: fakeGh(failed.remote, { conclusion: "failure" }).gh, ...quick });
  assert.equal(a.ok, false);
  assert.match(a.messages.join("\n"), /ended failure: https:\/\/github\.example\/run\/7/);
  assert.match(a.messages.join("\n"), /the registry refused the push/);

  const silent = pushedProject(t);
  const b = await trialDeploy(silent.d, "azure-container-apps", { gh: fakeGh(silent.remote, { log: "deploy\tDeploy\tdone\n" }).gh, ...quick });
  assert.match(b.messages.join("\n"), /no DEPLOYED_URL/);

  const down = pushedProject(t);
  const c = await trialDeploy(down.d, "azure-container-apps", { gh: fakeGh(down.remote).gh, sleep: quick.sleep, fetchFn: async () => ({ status: 503 }) });
  assert.equal(c.ok, false);
  assert.match(c.messages.join("\n"), /answered 503/);
});

test("a trial GitHub never starts a run for, or whose run never finishes, gives up and says which", async (t) => {
  const never = pushedProject(t);
  const silent = (args) => (args[0] === "api" ? "0" : "[]");
  const a = await trialDeploy(never.d, "azure-container-apps", { gh: silent, ...quick, appearPolls: 2 });
  assert.match(a.messages.join("\n"), /GitHub started no run of deploy-azure-container-apps\.yml for the trial commit [0-9a-f]{12} on development/);

  const stuck = pushedProject(t);
  const running = (args) => {
    if (args[0] === "api") return "0";
    const headSha = git(["rev-parse", `refs/heads/${TRIAL_BRANCH}`], stuck.remote);
    return JSON.stringify([{ databaseId: 9, headSha, status: "in_progress", conclusion: "", url: "https://github.example/run/9", workflowName: "deploy" }]);
  };
  const b = await trialDeploy(stuck.d, "azure-container-apps", { gh: running, ...quick, finishPolls: 2 });
  assert.match(b.messages.join("\n"), /did not finish in time: https:\/\/github\.example\/run\/9/);
});

test("the proposal page carries what the trial saw, with the run that deployed it", (t) => {
  const d = project(t);
  const ctx = { platform: "openshift", projectDir: d, deployRun: { ok: true, url: "https://app.example.test", status: 200, runUrl: "https://github.example/run/7", messages: [] } };
  const page = deploy.proposalEvidence(ctx);
  assert.match(page, /## Trial deploy/);
  assert.match(page, /development environment/);
  assert.match(page, /https:\/\/app\.example\.test answered 200/);
  assert.match(page, /https:\/\/github\.example\/run\/7/);
});

// ---- setup, a run of its own ----

test("a deploy runs once the run records say its platform's last setup completed, on whichever machine ran it", (t) => {
  const d = project(t);
  mkdirSync(join(d, "app"));
  mkdirSync(join(d, ".sdlc", "runs"), { recursive: true });
  const { config } = parseConfig(`${BASE}deploy: [azure-container-apps, openshift]\n`);
  const said = (platform, ctx = {}) => deploy.preChecks(d, { platform, config, ...ctx }).filter((r) => !r.ok).flatMap((r) => r.messages).join("\n");
  const record = (day, lines) => writeFileSync(join(d, ".sdlc", "runs", `${day}.md`), `# Run record ${day}\n\n${lines.map((l) => `- 10:00:00 ${l}`).join("\n")}\n`);
  assert.match(said("azure-container-apps"), /azure-container-apps has not been set up.*sdlc run deploy --platform azure-container-apps --setup/s);
  record("2026-10-18", ["run deploy: setup of azure-container-apps failed"]);
  assert.match(said("azure-container-apps"), /last setup of azure-container-apps did not complete/);
  record("2026-10-19", ["run deploy: set up openshift", "run deploy: set up azure-container-apps"]);
  assert.equal(said("azure-container-apps"), "");
  // The latest outcome is the one that counts.
  record("2026-10-20", ["run deploy: setup of azure-container-apps failed"]);
  assert.match(said("azure-container-apps"), /did not complete/);
  // A profile with no setup of its own has nothing to complete, and the setup run is not refused
  // for the setup it is about to do; a setup of a platform with none is.
  assert.equal(said("openshift"), "");
  assert.equal(said("azure-container-apps", { setup: true }), "");
  assert.match(said("openshift", { setup: true }), /openshift has no setup/);
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

test("what the setup chose is kept, and named without its values", (t) => {
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

// A project the pipeline made, with an application built and committed and Azure in its deploy
// setting, where no agent turn can run: the mock backend has no reply to give.
async function builtProject(t) {
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
  git([...ID, "commit", "-q", "-m", "built"], dir);
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = join(tmp, "no-replies");
  mkdirSync(process.env.SDLC_MOCK_DIR);
  return { tmp, dir };
}

test("a setup whose preflight fails is recorded, and no agent turn starts", async (t) => {
  const { tmp, dir } = await builtProject(t);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "az"), "#!/bin/sh\n[ \"$1 $2\" = 'account show' ] && exit 1\nexit 0\n");
  chmodSync(join(bin, "az"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const r = await runStage(dir, "deploy", { platform: "azure-container-apps", setup: true });
  assert.equal(r.ok, false);
  assert.match(r.messages.join("\n"), /preflight/);
  assert.match(git(["log", "-1", "--format=%s"], dir), /^run\(deploy\): setup of azure-container-apps failed$/);
  assert.equal(existsSync(join(dir, ".sdlc", "run-state.json")), false);
});

test("a setup runs where the stage's agent turn would be refused, since it starts none", async (t) => {
  const { dir } = await builtProject(t);
  const real = deploy.bootstrap;
  const backend = process.env.SDLC_AGENT_BACKEND;
  t.after(() => { deploy.bootstrap = real; if (backend === undefined) delete process.env.SDLC_AGENT_BACKEND; else process.env.SDLC_AGENT_BACKEND = backend; });
  deploy.bootstrap = () => ({ ok: true, ran: true, messages: [] });
  // On Codex outside a container, a deploy session could reach past its workspace, so its turn
  // is refused; the setup has no turn to refuse.
  process.env.SDLC_AGENT_BACKEND = "codex";
  const r = await runStage(dir, "deploy", { platform: "azure-container-apps", setup: true });
  assert.equal(r.ok, true, (r.messages ?? []).join("\n"));
});

test("a setup that completes is recorded and stops there, with no agent turn", async (t) => {
  const { dir } = await builtProject(t);
  const real = deploy.bootstrap;
  t.after(() => { deploy.bootstrap = real; });
  let ran = 0;
  deploy.bootstrap = () => { ran += 1; return { ok: true, ran: true, messages: ["azure-container-apps is set up"] }; };
  const r = await runStage(dir, "deploy", { platform: "azure-container-apps", setup: true });
  assert.equal(r.ok, true, (r.messages ?? []).join("\n"));
  assert.equal(r.setup, true);
  assert.equal(ran, 1);
  assert.match(git(["log", "-1", "--format=%s"], dir), /^run\(deploy\): set up azure-container-apps$/);
  const record = git(["show", "--name-only", "--format=", "HEAD"], dir);
  assert.match(record, /^\.sdlc\/runs\/[\d-]+\.md$/);
  assert.match(readFileSync(join(dir, record), "utf8"), /run deploy: set up azure-container-apps/);
  assert.equal(existsSync(join(dir, ".sdlc", "run-state.json")), false);
});

test("a deploy on a machine that was never set up is refused before any agent turn, and never sets itself up", async (t) => {
  const { dir } = await builtProject(t);
  const real = deploy.bootstrap;
  t.after(() => { deploy.bootstrap = real; });
  deploy.bootstrap = () => { throw new Error("a deploy run started the setup"); };
  const r = await runStage(dir, "deploy", { platform: "azure-container-apps" });
  assert.equal(r.ok, false);
  assert.match(r.messages.join("\n"), /sdlc run deploy --platform azure-container-apps --setup/);
  assert.match(git(["log", "-1", "--format=%s"], dir), /^run\(deploy\): pre-checks failed$/);
});

// A built project whose Azure setup completed (as its run records say), with `main` pushed to an
// `origin` on GitHub that git reaches through a bare repository here, an application at a local
// address, and `gh` answering for one finished run of the workflow on whatever the trial pushed,
// whose log names that address. The session's reply writes `files`.
async function readyToDeploy(t, files) {
  const { tmp, dir } = await builtProject(t);
  const real = deploy.bootstrap;
  deploy.bootstrap = () => ({ ok: true, ran: true, messages: [] });
  try { await runStage(dir, "deploy", { platform: "azure-container-apps", setup: true }); } finally { deploy.bootstrap = real; }
  const remote = join(tmp, "origin.git");
  git(["init", "-q", "--bare", "-b", "main", remote], tmp);
  originOnGitHub(dir, remote);
  git(["push", "-q", "origin", "main"], dir);
  const app = http.createServer((req, res) => res.end("ok"));
  const port = await new Promise((resolve) => app.listen(0, "127.0.0.1", () => resolve(app.address().port)));
  t.after(() => app.close());
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), [
    "#!/bin/bash",
    'case "$1 $2" in',
    '  "api repos/example/service/actions/secrets"|"api repos/example/service/actions/organization-secrets") echo 0;;',
    `  "run list") sha="$(git --git-dir "${remote}" rev-parse refs/heads/${TRIAL_BRANCH})"; printf '[{"databaseId":7,"headSha":"%s","status":"completed","conclusion":"success","url":"https://github.example/run/7","workflowName":"Deploy to Azure Container Apps"}]' "$sha";;`,
    `  "run view") printf 'deploy\\tDeploy\\tDEPLOYED_URL=http://127.0.0.1:${port}\\n';;`,
    "  *) exit 1;;",
    "esac",
    "",
  ].join("\n"));
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  writeFileSync(join(process.env.SDLC_MOCK_DIR, "deploy.json"), JSON.stringify({
    text: "The application deploys to Container Apps from one definition.\n\nRecommendation: approve.", files,
  }));
  return { dir, remote, port };
}

const DEPLOY_FILES = {
  "deploy/azure-container-apps/main.bicep": "targetScope = 'resourceGroup'\n",
  "deploy/azure-container-apps/deploy.sh": "#!/usr/bin/env bash\nset -euo pipefail\n",
  ".github/workflows/deploy-azure-container-apps.yml": readFileSync(join(PIPELINE_ROOT, "deploys", "azure-container-apps", "templates", ".github", "workflows", "deploy-azure-container-apps.yml"), "utf8"),
};

test("a deploy run takes the session's files out of its workspace, has GitHub try them, and proposes them with what the trial saw", async (t) => {
  const { dir, remote, port } = await readyToDeploy(t, DEPLOY_FILES);
  const r = await runStage(dir, "deploy", { platform: "azure-container-apps" });
  assert.equal(r.ok, true, (r.messages ?? []).join("\n"));
  const branch = "proposal/deploy-azure-container-apps";
  const changed = git(["diff", "--name-only", `main...${branch}`], dir).split("\n");
  assert.ok(changed.includes(".github/workflows/deploy-azure-container-apps.yml"), changed.join("\n"));
  assert.ok(changed.includes("deploy/azure-container-apps/main.bicep"));
  const page = changed.find((p) => /^\.sdlc\/proposals\/.*deploy-azure-container-apps.*\.md$/.test(p));
  assert.ok(page, changed.join("\n"));
  const said = git(["show", `${branch}:${page}`], dir);
  assert.match(said, /## Trial deploy/);
  assert.match(said, new RegExp(`http://127\\.0\\.0\\.1:${port} answered 200`));
  assert.match(said, /https:\/\/github\.example\/run\/7/);
  // The trial GitHub ran is the session's work on top of what main held when the run began.
  assert.match(git(["show", `refs/heads/${TRIAL_BRANCH}:.github/workflows/deploy-azure-container-apps.yml`], remote), /deploy\.sh development/);
});

test("a person's deploy files are handed in from a branch, tried on GitHub and proposed as a session's would be", async (t) => {
  const { dir, port } = await readyToDeploy(t, {});
  git(["checkout", "-q", "-b", "hand-built"], dir);
  for (const [rel, content] of Object.entries(DEPLOY_FILES)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  git(["add", "-A"], dir); git([...ID, "commit", "-q", "-m", "deploy files written by hand"], dir);
  git(["checkout", "-q", "main"], dir);
  const r = await runStage(dir, "deploy", { platform: "azure-container-apps", handIn: "hand-built" });
  assert.equal(r.ok, true, (r.messages ?? []).join("\n"));
  const branch = "proposal/deploy-azure-container-apps";
  const page = git(["diff", "--name-only", `main...${branch}`], dir).split("\n").find((p) => /^\.sdlc\/proposals\/.*\.md$/.test(p));
  const said = git(["show", `${branch}:${page}`], dir);
  assert.match(said, /Handed in by a person from `hand-built`/);
  assert.match(said, new RegExp(`http://127\\.0\\.0\\.1:${port} answered 200`));
});

test("a deploy session that changes the application is refused, and nothing is tried or proposed", async (t) => {
  const { dir, remote } = await readyToDeploy(t, { ...DEPLOY_FILES, "app/index.js": "export const changed = true;\n" });
  const r = await runStage(dir, "deploy", { platform: "azure-container-apps" });
  assert.equal(r.ok, false);
  assert.match(r.messages.join("\n"), /app\/index\.js/);
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "-q", "refs/heads/proposal/deploy-azure-container-apps"], { cwd: dir }).status, 1);
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${TRIAL_BRANCH}`], { cwd: remote }).status, 1, "no trial was pushed");
});

test("only a stage with something to set up takes --setup", async (t) => {
  const { dir } = await builtProject(t);
  await assert.rejects(() => runStage(dir, "intent", { setup: true }), /intent has nothing to set up/);
  await assert.rejects(() => runStage(dir, "deploy", { platform: "azure-container-apps", setup: true, handIn: "main" }), /--setup.*--hand-in/);
});

// `az` and `gh` as a subscription and a repository would answer the setup, each call logged. A
// group named in FAKE_GROUPS exists already; a role named in FAKE_DENY_ROLE is one this account
// cannot assign; FAKE_GH_NOT_ADMIN makes the account one that cannot create environments.
function fakeCloud(t) {
  const tmp = project(t);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const azLog = join(tmp, "az.log");
  const ghLog = join(tmp, "gh.log");
  writeFileSync(join(bin, "az"), [
    "#!/bin/bash",
    `echo "$*" >> "${azLog}"`,
    'opt() { local want="$1"; shift; local prev=""; for a in "$@"; do [ "$prev" = "$want" ] && { echo "$a"; return; }; prev="$a"; done; }',
    'case "$*" in',
    '  "account show --query id -o tsv") echo sub-id;;',
    '  "account show --query tenantId -o tsv") echo tenant-id;;',
    '  "provider show --namespace Microsoft.App --query"*) echo region-a;;',
    '  "provider show"*) echo Registered;;',
    '  "group show --name "*) g="$(opt --name "$@")"; [[ " ${FAKE_GROUPS:-} " == *" $g "* ]] && { echo region-a; exit 0; }; exit 3;;',
    '  "acr show --name"*"--query id"*|"identity show --resource-group"*|"identity federated-credential show"*) exit 3;;',
    '  "acr check-name"*) echo true;;',
    '  "acr create"*) echo /subscriptions/sub-id/resourceGroups/rg-svc-shared/providers/Microsoft.ContainerRegistry/registries/svcacr;;',
    '  "acr show"*loginServer*) echo svcacr.azurecr.io;;',
    '  "identity create"*) echo "/subscriptions/sub-id/resourceGroups/rg-svc-shared/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$(opt --name "$@")";;',
    '  "identity show --ids"*"--query principalId"*) id="$(opt --ids "$@")"; echo "principal-${id##*/}";;',
    '  "identity show --ids"*"--query clientId"*) id="$(opt --ids "$@")"; echo "client-${id##*/}";;',
    '  "role assignment create"*) [ -n "${FAKE_DENY_ROLE:-}" ] && [ "$(opt --role "$@")" = "$FAKE_DENY_ROLE" ] && { echo "AuthorizationFailed" >&2; exit 1; }; exit 0;;',
    // The SRE agent: its identity, the agent as the API returns it, and its provisioning state.
    '  "resource show --ids"*knowledgeGraphConfiguration.identity*) echo /subscriptions/sub-id/resourceGroups/rg-agents/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-agent;;',
    '  "rest --method get --url "*"--query"*) echo Succeeded;;',
    `  "rest --method get --url "*) echo '{"properties":{"knowledgeGraphConfiguration":{"identity":"/subscriptions/sub-id/resourceGroups/rg-agents/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-agent","managedResources":["/subscriptions/sub-id/resourceGroups/rg-other"]}}}';;`,
    "esac",
    "",
  ].join("\n"));
  writeFileSync(join(bin, "gh"), [
    "#!/bin/bash",
    `echo "$*" >> "${ghLog}"`,
    'case "$1 $2 $3" in',
    '  "auth status"*) exit 0;;',
    '  "api --method PUT") [ -n "${FAKE_GH_NOT_ADMIN:-}" ] && { echo "HTTP 403" >&2; exit 1; }; ' + `echo "body $(cat)" >> "${ghLog}"; exit 0;;`,
    '  "api --method POST"|"api --method DELETE") exit 0;;',
    '  "api repos/"*"/deployment-branch-policies --jq") printf "%b" "${FAKE_POLICIES:-}";;',
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(join(bin, "az"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  const settings = join(tmp, deploySettingsFile("azure-container-apps"));
  const setup = (env = {}) => spawnSync("bash", [join(AZ, "bootstrap.sh")], {
    cwd: tmp, encoding: "utf8", input: "",
    env: { PATH: `${bin}:${process.env.PATH}`, SDLC_PROJECT_DIR: tmp, SDLC_SETTINGS_FILE: settings,
      NAME_PREFIX: "svc", LOCATION: "region-a", GITHUB_REPO: "example/service", PRODUCTION_REVIEWERS: "", ...env },
  });
  const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
  return { tmp, setup, az: () => lines(azLog), gh: () => lines(ghLog) };
}

const nameAfter = (flag, line) => new RegExp(`${flag} (\\S+)`).exec(line)?.[1];

test("the Azure setup creates the shared, development and production groups, and an identity for each environment's deploys that reaches only its own group", (t) => {
  const cloud = fakeCloud(t);
  const r = cloud.setup();
  assert.equal(r.status, 0, r.stderr);
  const az = cloud.az();
  assert.deepEqual(az.filter((l) => l.startsWith("group create")).map((l) => nameAfter("--name", l)), ["rg-svc-shared", "rg-svc-development", "rg-svc-production"]);
  assert.deepEqual(az.filter((l) => l.startsWith("identity create")).map((l) => nameAfter("--name", l)), ["id-svc-pull", "id-svc-github-development", "id-svc-github-production"]);
  for (const env of ["development", "production"]) {
    const cred = az.find((l) => l.startsWith("identity federated-credential create") && l.includes(`--identity-name id-svc-github-${env} `));
    assert.match(cred, new RegExp(`--subject repo:example/service:environment:${env} `));
    const contributor = az.filter((l) => l.startsWith("role assignment create") && l.includes(`--assignee-object-id principal-id-svc-github-${env} `) && l.includes("--role Contributor"));
    assert.deepEqual(contributor.map((l) => nameAfter("--scope", l)), [`/subscriptions/sub-id/resourceGroups/rg-svc-${env}`]);
  }
  assert.equal(az.some((l) => l.startsWith("acr login")), false, "nothing here signs Docker in; images are built on GitHub");
  const gh = cloud.gh();
  assert.ok(gh.some((l) => l.includes("custom_branch_policies\":true")), gh.join("\n"));
  const policies = (env) => gh.filter((l) => l.startsWith(`api --method POST repos/example/service/environments/${env}/deployment-branch-policies`)).map((l) => nameAfter("name=", l) ?? /name=(\S+)/.exec(l)[1]);
  assert.deepEqual(policies("development"), ["main", "development"]);
  assert.deepEqual(policies("production"), ["main"]);
  assert.ok(gh.includes("variable set AZURE_CLIENT_ID --env development --repo example/service --body client-id-svc-github-development"), gh.join("\n"));
  assert.ok(gh.includes("variable set AZURE_CLIENT_ID --env production --repo example/service --body client-id-svc-github-production"), gh.join("\n"));
  const saved = readDeploySettings(cloud.tmp, "azure-container-apps");
  assert.equal(saved.SETUP, "complete");
  assert.equal(saved.RESOURCE_GROUP, "rg-svc-development");
  assert.equal(saved.RESOURCE_GROUP_PRODUCTION, "rg-svc-production");
  assert.equal(saved.AZURE_CLIENT_ID_DEVELOPMENT, "client-id-svc-github-development");
  assert.equal(saved.AZURE_CLIENT_ID_PRODUCTION, "client-id-svc-github-production");
});

test("a setup into a development group that already runs the application, with no production, creates neither", (t) => {
  const cloud = fakeCloud(t);
  const r = cloud.setup({ RESOURCE_GROUP: "rg-live", RESOURCE_GROUP_PRODUCTION: "", FAKE_GROUPS: "rg-live" });
  assert.equal(r.status, 0, r.stderr);
  const az = cloud.az();
  assert.deepEqual(az.filter((l) => l.startsWith("group create")).map((l) => nameAfter("--name", l)), ["rg-svc-shared"]);
  assert.deepEqual(az.filter((l) => l.startsWith("identity create")).map((l) => nameAfter("--name", l)), ["id-svc-pull", "id-svc-github-development"]);
  assert.ok(az.some((l) => l.startsWith("role assignment create") && l.includes("--scope /subscriptions/sub-id/resourceGroups/rg-live")));
  assert.equal(cloud.gh().some((l) => l.includes("environments/production")), false);
  const saved = readDeploySettings(cloud.tmp, "azure-container-apps");
  assert.equal(saved.RESOURCE_GROUP, "rg-live");
  assert.equal(saved.RESOURCE_GROUP_PRODUCTION, "");
  assert.equal(saved.SETUP, "complete");
});

test("a setup that cannot create the repository's environments, or assign a role the deploys need, is not complete and says what someone else does", (t) => {
  const github = fakeCloud(t);
  const a = github.setup({ FAKE_GH_NOT_ADMIN: "1" });
  assert.notEqual(a.status, 0);
  assert.match(a.stderr, /administers example\/service/);
  assert.equal(readDeploySettings(github.tmp, "azure-container-apps").SETUP, "incomplete");

  const roles = fakeCloud(t);
  const b = roles.setup({ FAKE_DENY_ROLE: "Contributor" });
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /az role assignment create --assignee-object-id principal-id-svc-github-development .*--role "Contributor" --scope \/subscriptions\/sub-id\/resourceGroups\/rg-svc-development/);
  assert.equal(readDeploySettings(roles.tmp, "azure-container-apps").SETUP, "incomplete");
});

test("a setup refuses environments that share a group with each other, with the registry and identities, or with the SRE agent", (t) => {
  for (const [env, why] of [
    [{ RESOURCE_GROUP: "rg-svc-shared" }, /rg-svc-shared is both the development environment's group and the shared group/],
    [{ RESOURCE_GROUP_PRODUCTION: "rg-svc-development" }, /rg-svc-development is both the development environment's group and the production environment's/],
    [{ SRE_AGENT_ID: "/subscriptions/sub-id/resourceGroups/rg-svc-development/providers/Microsoft.App/agents/agent-1" }, /the SRE agent is in rg-svc-development, an environment's own group/],
  ]) {
    const cloud = fakeCloud(t);
    const r = cloud.setup(env);
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.match(r.stderr, why);
    assert.equal(cloud.az().some((l) => /^(group|identity|acr) create/.test(l)), false, "nothing was created");
  }
});

test("a setup sets the SRE agent to watch each environment and gives its identity read access, and no deploy identity any right on the agent", (t) => {
  const cloud = fakeCloud(t);
  const agent = "/subscriptions/sub-id/resourceGroups/rg-agents/providers/Microsoft.App/agents/agent-1";
  const r = cloud.setup({ SRE_AGENT_ID: agent });
  assert.equal(r.status, 0, r.stderr);
  const az = cloud.az();
  for (const env of ["development", "production"]) {
    const scope = `/subscriptions/sub-id/resourceGroups/rg-svc-${env}`;
    for (const role of ["Reader", "Monitoring Reader", "Log Analytics Reader"]) {
      assert.ok(az.some((l) => l.startsWith("role assignment create --assignee-object-id principal-id-agent ") && l.includes(`--role ${role} --scope ${scope}`)), `${role} on ${env}`);
    }
    const patch = az.find((l) => l.startsWith("rest --method patch") && l.includes(`${scope}"`));
    assert.ok(patch, `the agent is set to watch ${env}`);
    assert.match(patch, /"identity":"\/subscriptions\/sub-id\/resourceGroups\/rg-agents\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/id-agent"/);
    assert.match(patch, /rg-other/, "what the agent already watched is kept");
  }
  assert.equal(az.some((l) => l.startsWith("role assignment create --assignee-object-id principal-id-svc-github-") && l.includes(agent)), false);
});

test("a setup takes away a branch an environment admitted deploys from that it should not", (t) => {
  const cloud = fakeCloud(t);
  const r = cloud.setup({ FAKE_POLICIES: "11 release\\n12 main\\n" });
  assert.equal(r.status, 0, r.stderr);
  const gh = cloud.gh();
  for (const env of ["development", "production"]) {
    assert.ok(gh.includes(`api --method DELETE repos/example/service/environments/${env}/deployment-branch-policies/11`), gh.join("\n"));
    assert.equal(gh.some((l) => l.startsWith(`api --method POST repos/example/service/environments/${env}/deployment-branch-policies`) && l.includes("name=main")), false, "main is kept, not added twice");
  }
  assert.ok(gh.some((l) => l.startsWith("api --method POST repos/example/service/environments/development/deployment-branch-policies") && l.includes("name=development")));
});

test("the Azure preflight stops when the GitHub CLI is not signed in, since every deploy runs there", (t) => {
  const bin = project(t);
  writeFileSync(join(bin, "az"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\n[ \"$1 $2\" = 'auth status' ] && exit 1\nexit 0\n");
  chmodSync(join(bin, "az"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  const r = spawnSync("bash", [join(AZ, "preflight.sh")], { encoding: "utf8", input: "", env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /GitHub CLI/);
});

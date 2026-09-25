import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { copyHome, keepRefreshed } from "./config-home.mjs";

// An agent session in a throwaway container (`docs/decisions/0061-an-agent-session-in-a-container.md`).
//
// The session runs in a container built from a pipeline-owned image (Node 24 and one agent CLI
// at a pinned version), on a Docker network with no route out, beside a forward proxy that is
// the network's one way out and lets through only the hosts the turn's allowlist names. The
// container is given two mounts: the stage's materialised workspace, read-write at
// `/workspace` (read-only for a turn that only reads), and a copy of the pipeline's CLI home
// holding the sign-in. No repository, no host home, no Docker socket. It runs as the invoking
// user, never root, with every capability dropped, no privilege escalation and a read-only
// root filesystem.
//
// Every mount source is relative to a private staging directory the docker CLI runs in, so no
// local path is ever on a command line; a stage's environment crosses by name, so no value is.

// The agent CLIs an image can carry, at the versions the pipeline pins. A version is changed
// here, deliberately, and the image tag changes with it, so the next isolated turn builds it.
export const AGENT_CLIS = {
  codex: { package: "@openai/codex", version: "0.157.0", command: "codex" },
  claude: { package: "@anthropic-ai/claude-code", version: "2.1.282", command: "claude" },
};

export const WORKSPACE_MOUNT = "/workspace";
export const HOME_MOUNT = "/sdlc/home";
export const SESSION_MOUNT = "/sdlc/session";
export const PROXY_ALIAS = "egress-proxy";
export const PROXY_PORT = 3128;
export const SESSION_LABEL = "agentic-sdlc.session";

const CONTAINERS = fileURLToPath(new URL("../../containers/", import.meta.url));
const AGENT_CONTEXT = join(CONTAINERS, "agent");
const PROXY_CONTEXT = join(CONTAINERS, "egress-proxy");

// Overridable for the reason `SDLC_CODEX_BIN` is: so what the pipeline asks Docker for can be
// exercised against a stand-in that records it.
export function dockerBin() {
  return process.env.SDLC_DOCKER_BIN || "docker";
}

function docker(args, opts = {}) {
  return execFileSync(dockerBin(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, ...opts });
}

function quietly(args) {
  try { docker(args); } catch { /* already gone */ }
}

function digestOf(...files) {
  const h = createHash("sha256");
  for (const f of files) h.update(readFileSync(f));
  return h.digest("hex").slice(0, 12);
}

// The tag names the backend, the CLI version and the image definition, so a changed pin or a
// changed Dockerfile is a different image, built on first use.
export function agentImageTag(backend) {
  const cli = AGENT_CLIS[backend];
  if (!cli) throw new Error(`no agent image is defined for backend ${backend}`);
  return `agentic-sdlc-agent:${backend}-${cli.version}-${digestOf(join(AGENT_CONTEXT, "Dockerfile"))}`;
}

export function proxyImageTag() {
  return `agentic-sdlc-egress-proxy:${digestOf(join(PROXY_CONTEXT, "Dockerfile"), join(PROXY_CONTEXT, "proxy.mjs"))}`;
}

// Whether Docker answers, and its server version. What `doctor` reports and what a run
// checks before it spends anything on an isolated stage.
export function dockerStatus() {
  try {
    return { ok: true, version: docker(["version", "--format", "{{.Server.Version}}"], { timeout: 15_000 }).trim() };
  } catch {
    return { ok: false, said: "Docker is not reachable: an isolated session needs a running Docker daemon this account can use" };
  }
}

// The image's id (`sha256:…`), or "" when it is not built.
export function imageId(tag) {
  try { return docker(["image", "inspect", "--format", "{{.Id}}", tag]).trim(); } catch { return ""; }
}

export function shortId(id) {
  return String(id).replace(/^sha256:/, "").slice(0, 12);
}

// Builds an image, streaming the build to stderr so a person watching sees it happen. Nothing
// is passed but the pinned package and version: the image has no credential and no project.
export function buildAgentImage(backend) {
  const cli = AGENT_CLIS[backend];
  const tag = agentImageTag(backend);
  execFileSync(dockerBin(), ["build", "-t", tag, "--label", `${SESSION_LABEL}.image=agent`,
    "--build-arg", `CLI_PACKAGE=${cli.package}`, "--build-arg", `CLI_VERSION=${cli.version}`, "."],
  { cwd: AGENT_CONTEXT, stdio: ["ignore", process.stderr, process.stderr] });
  return tag;
}

export function buildProxyImage() {
  const tag = proxyImageTag();
  execFileSync(dockerBin(), ["build", "-t", tag, "--label", `${SESSION_LABEL}.image=egress-proxy`, "."],
    { cwd: PROXY_CONTEXT, stdio: ["ignore", process.stderr, process.stderr] });
  return tag;
}

// Both images a session needs, built when missing. Built once and kept: a later session finds
// them by tag.
export function ensureImages(backend) {
  const agentTag = agentImageTag(backend);
  let agent = imageId(agentTag);
  if (!agent) {
    console.warn(`building the ${backend} agent image (${agentTag}); this happens once per pinned version`);
    buildAgentImage(backend);
    agent = imageId(agentTag);
  }
  const proxyTag = proxyImageTag();
  let proxy = imageId(proxyTag);
  if (!proxy) {
    console.warn(`building the egress proxy image (${proxyTag})`);
    buildProxyImage();
    proxy = imageId(proxyTag);
  }
  if (!agent || !proxy) throw new Error(`the isolation images could not be built: run \`sdlc isolation build\` to see why`);
  return { agentTag, agent, proxyTag, proxy };
}

// The CLI's version line as the image reports it, asked once per image per process: the CLI
// that ran is the one in the image, not whatever the host has installed.
const versions = new Map();
function imageVersion(tag, command) {
  if (!versions.has(tag)) {
    let v = "";
    try { v = docker(["run", "--rm", "--network", "none", "--cap-drop", "ALL", tag, command, "--version"], { timeout: 60_000 }).split("\n")[0].trim().slice(0, 100); } catch { v = ""; }
    versions.set(tag, v);
  }
  return versions.get(tag);
}

// The account the session runs as: the invoking user, so what it writes in the workspace is
// the operator's, and never root.
export function containerUser(uid, gid) {
  if (uid === 0) throw new Error("an isolated session runs as the invoking user and never as root; run the pipeline as an ordinary account");
  return `${uid}:${gid}`;
}

export function sessionNames(id = randomBytes(6).toString("hex")) {
  return { session: id, agent: `sdlc-agent-${id}`, proxy: `sdlc-egress-${id}`, network: `sdlc-net-${id}` };
}

// An internal network: Docker gives it no route out. `inhibit_ipv4` keeps the host itself off
// it as well: without it the host has an address on the bridge, and any service listening on
// all of the host's interfaces answers there.
export function networkCreateArgs(names) {
  return ["network", "create", "--internal", "-o", "com.docker.network.bridge.inhibit_ipv4=true",
    "--label", `${SESSION_LABEL}=${names.session}`, names.network];
}

// The proxy starts on the session's network under the alias the agent is pointed at, and is
// connected to Docker's default network afterwards, which is its one way out.
export function proxyRunArgs(names, image, allow) {
  return ["run", "-d", "--name", names.proxy, "--label", `${SESSION_LABEL}=${names.session}`,
    "--network", names.network, "--network-alias", PROXY_ALIAS,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--pids-limit", "256",
    "-e", `SDLC_EGRESS_ALLOW=${allow.join(",")}`, "-e", `SDLC_EGRESS_PORT=${PROXY_PORT}`,
    image];
}

export function agentRunArgs({ names, image, user, readOnly, homeEnv, readOnlyHomeFiles = [], session = false, stage = "", passEnv = [], command }) {
  const proxy = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
  const args = ["run", "--rm", "-i", "--name", names.agent, "--label", `${SESSION_LABEL}=${names.session}`,
    "--network", names.network, "--user", user,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--pids-limit", "4096",
    "--tmpfs", "/tmp:rw,exec,nosuid,size=4g",
    "-v", `./workspace:${WORKSPACE_MOUNT}${readOnly ? ":ro" : ""}`,
    "-v", `./home:${HOME_MOUNT}`];
  // A file the pipeline wrote into the home for the session to obey — the hook that carries
  // the implement guard — is mounted over the copy read-only, so the session cannot rewrite it.
  for (const f of readOnlyHomeFiles) args.push("-v", `./home/${f}:${HOME_MOUNT}/${f}:ro`);
  if (session) args.push("-v", `./session:${SESSION_MOUNT}:ro`);
  args.push("-w", WORKSPACE_MOUNT,
    "-e", "HOME=/tmp", "-e", `${homeEnv}=${HOME_MOUNT}`, "-e", `SDLC_STAGE=${stage}`,
    "-e", `HTTPS_PROXY=${proxy}`, "-e", `HTTP_PROXY=${proxy}`, "-e", `https_proxy=${proxy}`, "-e", `http_proxy=${proxy}`,
    "-e", "NO_PROXY=", "-e", "no_proxy=", "-e", "NODE_USE_ENV_PROXY=1");
  for (const name of passEnv) args.push("-e", name);
  args.push(image, ...command);
  return args;
}

// Variables through which a CLI would sign in with a key rather than the operator's own
// sign-in. They never cross into a container, whoever set them.
const KEY_VARS = ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY"];

async function proxyReady(name, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let out = "";
    try { out = docker(["logs", name]); } catch { out = ""; }
    if (/listening/.test(out)) return;
    if (Date.now() > until) throw new Error("the egress proxy did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
}

// One turn in a container. `backend` is the executor's backend entry; `agent` carries the
// allowlist. Returns what the CLI printed, whether the runner stopped it, the CLI's version and
// the image that ran it; `runAgent` reads the output exactly as it reads a turn on the host.
export async function runInContainer(backend, opts, agent, { recorded = true, limitMs } = {}) {
  if (opts.addDirs?.length) {
    throw new Error("an isolated session is given its workspace and nothing else: materialise what the stage needs into the workspace rather than naming an extra directory");
  }
  const cli = AGENT_CLIS[backend.name];
  const user = containerUser(process.getuid(), process.getgid());
  const images = ensureImages(backend.name);
  const version = recorded ? imageVersion(images.agentTag, cli.command) : "";
  const names = sessionNames();
  const staging = mkdtempSync(join(tmpdir(), "sdlc-session-"));
  const pipelineHome = backend.ensureHome();
  const homeCopy = join(staging, "home");
  let staged = null;
  try {
    if (opts.cwd) symlinkSync(opts.cwd, join(staging, "workspace"));
    else mkdirSync(join(staging, "workspace"));
    staged = copyHome(pipelineHome, backend.credential, backend.homeFiles ?? [], homeCopy);
    // A CLI that is handed its skill and its MCP servers as files reads them inside the
    // container, so they are staged beside the home and named by their container path.
    const inside = { ...opts, isolated: true };
    let session = false;
    if (backend.filesInSession && (opts.systemPromptFile || opts.mcpConfig)) {
      mkdirSync(join(staging, "session"), { mode: 0o700 });
      session = true;
      if (opts.systemPromptFile) { copyFileSync(opts.systemPromptFile, join(staging, "session", "SKILL.md")); inside.systemPromptFile = `${SESSION_MOUNT}/SKILL.md`; }
      if (opts.mcpConfig) { copyFileSync(opts.mcpConfig, join(staging, "session", "mcp.json")); inside.mcpConfig = `${SESSION_MOUNT}/mcp.json`; }
    }
    const { args, input } = backend.buildArgs(inside, HOME_MOUNT);
    const stageEnv = opts.env ?? {};
    const runArgs = agentRunArgs({
      names, image: images.agentTag, user, readOnly: !backend.writes(opts.allowedTools ?? []), homeEnv: backend.homeEnv,
      readOnlyHomeFiles: backend.homeFiles ?? [], session, stage: opts.stage ?? "", passEnv: Object.keys(stageEnv), command: [cli.command, ...args],
    });
    docker(networkCreateArgs(names));
    docker(proxyRunArgs(names, images.proxyTag, agent.allow ?? []));
    docker(["network", "connect", "bridge", names.proxy]);
    await proxyReady(names.proxy);
    const env = { ...process.env, ...stageEnv };
    for (const k of KEY_VARS) delete env[k];
    const { stdout, stopped, stderr } = await new Promise((resolve, reject) => {
      const child = execFile(dockerBin(), runArgs, { cwd: staging, env, maxBuffer: backend.maxBuffer, ...(limitMs ? { timeout: limitMs, killSignal: "SIGTERM" } : {}) }, (err, out, errOut) => {
        if (limitMs && err?.killed) return resolve({ stdout: out ?? "", stopped: true, stderr: errOut });
        if (err && !out) return reject(Object.assign(new Error(`${backend.name} failed in its container: ${errOut || err.message}`), { stderr: errOut }));
        resolve({ stdout: out, stopped: false, stderr: errOut });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
    return { stdout, stopped, stderr, version, image: shortId(images.agent) };
  } finally {
    quietly(["rm", "-f", names.agent, names.proxy]);
    quietly(["network", "rm", names.network]);
    keepRefreshed(homeCopy, pipelineHome, backend.credential, staged);
    rmSync(staging, { recursive: true, force: true });
  }
}

// The session containers and networks a run left behind: one stopped before its `finally`
// ran — killed, or the machine went down. Found by the label every session carries.
export function leftoverSessions() {
  const list = (args) => { try { return docker(args).split("\n").map((l) => l.trim()).filter(Boolean); } catch { return []; } };
  return {
    containers: list(["ps", "-a", "-q", "--filter", `label=${SESSION_LABEL}`]),
    networks: list(["network", "ls", "-q", "--filter", `label=${SESSION_LABEL}`]),
  };
}

export function cleanSessions() {
  const left = leftoverSessions();
  if (left.containers.length) quietly(["rm", "-f", ...left.containers]);
  if (left.networks.length) quietly(["network", "rm", ...left.networks]);
  return left;
}

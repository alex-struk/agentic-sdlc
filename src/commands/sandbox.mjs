// `sdlc sandbox up|down|reset|status [--target new]` — a rebuilt target's local lifecycle,
// the counterpart of `sdlc oracle` for the application the pipeline builds. `up` is the
// deploy for this phase (docs/decisions/0011-build-verify-review.md): the project's own
// compose file, built from the working tree, waited on, then seeded.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadConfig } from "../config/load.mjs";
import { targetSettings, composeArgs } from "../sandbox/local.mjs";
import { COMMANDS } from "../cli.mjs";

function defaultExec(cmd, args, { cwd, env = {} } = {}) {
  const res = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr || (res.error ? res.error.message : "") };
}

async function defaultHealth(url) {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* not up yet */ }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  return false;
}

// The identity provider's test users sign in with this password, and compose reads it from
// the environment. It is passed only that way, so it never appears in an argument list, a
// log line or a file.
function composeEnv() {
  return process.env.SDLC_SANDBOX_PASSWORD ? { SDLC_SANDBOX_PASSWORD: process.env.SDLC_SANDBOX_PASSWORD } : {};
}

const tail = (r) => `${r.stderr || r.stdout}`.trim().split("\n").slice(-15).join("\n");

export async function sandboxUp(projectDir, config, target, { exec = defaultExec, health = defaultHealth } = {}) {
  const s = targetSettings(config, target);
  if (!existsSync(join(projectDir, s.compose)))
    return { ok: false, messages: [`${s.compose} is missing; the stack profile has the application declare its local services there`] };
  const up = exec("docker", [...composeArgs(projectDir, s), "up", "-d", "--build", "--wait"], { cwd: projectDir, env: composeEnv() });
  if (up.status !== 0) return { ok: false, messages: [`docker compose up failed:\n${tail(up)}`] };
  if (!(await health(s.baseUrl))) return { ok: false, messages: [`the application did not answer at ${s.baseUrl}`] };
  const seeded = sandboxReset(projectDir, config, target, { exec });
  return seeded.ok ? { ok: true, baseUrl: s.baseUrl, messages: [] } : seeded;
}

export function sandboxReset(projectDir, config, target, { exec = defaultExec } = {}) {
  const s = targetSettings(config, target);
  const r = exec("docker", [...composeArgs(projectDir, s), "run", "--rm", s.seedService], { cwd: projectDir, env: composeEnv() });
  return r.status === 0 ? { ok: true, messages: [] } : { ok: false, messages: [`the ${s.seedService} service failed:\n${tail(r)}`] };
}

export function sandboxDown(projectDir, config, target, { exec = defaultExec } = {}) {
  const s = targetSettings(config, target);
  const r = exec("docker", [...composeArgs(projectDir, s), "down", "-v"], { cwd: projectDir, env: composeEnv() });
  return { ok: r.status === 0 };
}

COMMANDS.sandbox = async ({ pos, flags }) => {
  const projectDir = process.cwd();
  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) { console.error(`config invalid:\n  ${errors.join("\n  ")}`); return 1; }
  const target = flags.target ?? "new";
  const action = pos[0];
  if (action === "up") {
    const r = await sandboxUp(projectDir, config, target);
    console.log(r.ok ? `sandbox ${target} up at ${r.baseUrl}` : r.messages.join("\n"));
    return r.ok ? 0 : 1;
  }
  if (action === "reset") { const r = sandboxReset(projectDir, config, target); console.log(r.ok ? `sandbox ${target} reseeded` : r.messages.join("\n")); return r.ok ? 0 : 1; }
  if (action === "down") { sandboxDown(projectDir, config, target); console.log(`sandbox ${target} down`); return 0; }
  if (action === "status") {
    const s = targetSettings(config, target);
    const r = defaultExec("docker", [...composeArgs(projectDir, s), "ps"], { cwd: projectDir });
    console.log(r.stdout.trim() || `sandbox ${target}: nothing running`);
    return 0;
  }
  console.error("usage: sdlc sandbox up|down|reset|status [--target <t>]");
  return 1;
};

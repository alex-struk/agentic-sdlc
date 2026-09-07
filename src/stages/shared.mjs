// Helpers more than one stage needs, kept out of any single stage's own module so a stage
// never has to import a sibling stage to reach them.
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitOk } from "../lib/git.mjs";

export const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "skills");

export function skillPath(name) {
  return join(SKILLS_DIR, `${name}.md`);
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A follow-up proposal already open — its branch exists with no gate file on it yet — is
// the question the stage is waiting on, so no second one is opened alongside it. `prefix`
// is the proposal family's name without its number (`ratify-<domain>`,
// `calibrate-<target>`), which is the only thing that differs between the loops that use
// this. Returns the highest number seen on a branch or a gate file either way, so the next
// proposal continues the sequence rather than reusing a number a ruled one already holds.
export function followUpState(projectDir, prefix) {
  const pattern = `refs/heads/proposal/${prefix}-*`;
  const refs = gitOk(["for-each-ref", "--format=%(refname:short)", pattern], projectDir)
    ? git(["for-each-ref", "--format=%(refname:short)", pattern], projectDir).split("\n").filter(Boolean)
    : [];
  const re = new RegExp(`^proposal/${escapeRe(prefix)}-(\\d+)$`);
  let highest = 0;
  let open = null;
  for (const branch of refs) {
    const m = re.exec(branch);
    if (!m) continue;
    highest = Math.max(highest, Number(m[1]));
    const name = branch.slice("proposal/".length);
    const ruledOnBranch = gitOk(["cat-file", "-e", `${branch}:.sdlc/gates/${name}.yaml`], projectDir);
    const ruledOnMain = existsSync(join(projectDir, ".sdlc", "gates", `${name}.yaml`));
    if (!ruledOnBranch && !ruledOnMain) open = name;
  }
  const dir = join(projectDir, ".sdlc", "gates");
  if (existsSync(dir)) {
    const gre = new RegExp(`^${escapeRe(prefix)}-(\\d+)\\.yaml$`);
    for (const f of readdirSync(dir)) {
      const m = gre.exec(f);
      if (m) highest = Math.max(highest, Number(m[1]));
    }
  }
  return { open, highest };
}

// `--target old` is the oracle this project's own config started (`sdlc oracle up`); any
// other name has to be one `config.targets` actually configures — there is no third way
// to name a running application a stage could point at. Shared by `bind-adapter` and
// `calibrate`, which ask the same question and differ only in the check id, in whether
// the target may be defaulted, and in whether a base URL has to be configured for it
// (`bind-adapter` probes the URL itself and reports a missing one that way).
export function checkTargetOption(stageName, ctx, { target = ctx.target, requireBaseUrl = false, missing } = {}) {
  const id = `${stageName}-target-option`;
  if (!target) return { id, ok: false, messages: [missing ?? `${stageName} needs --target <t>`] };
  if (target === "old") {
    if (ctx.config?.oracle?.target !== "old")
      return { id, ok: false, messages: [`${stageName}: target "old" needs config.oracle (with oracle.target: old)`] };
    return { id, ok: true, messages: [] };
  }
  const targets = ctx.config?.targets ?? {};
  if (!(target in targets))
    return { id, ok: false, messages: [`target "${target}" is not "old" and not in config.targets: ${Object.keys(targets).join(", ") || "(none configured)"}`] };
  if (requireBaseUrl && !targets[target].base_url)
    return { id, ok: false, messages: [`${stageName}: target "${target}" has no base_url configured`] };
  return { id, ok: true, messages: [] };
}

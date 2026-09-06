import { existsSync, copyFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../lib/git.mjs";
import { copyTree, ensureDir, readText, writeText } from "../lib/fsx.mjs";
import { parseConfig } from "../config/load.mjs";
import { init } from "./init.mjs";
import { COMMANDS } from "../cli.mjs";

export const PIPELINE_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

export async function newProject({ dir, from, interactive = false, answers = null }) {
  dir = resolve(dir);
  if (existsSync(join(dir, ".sdlc"))) throw new Error(`${dir} already has a .sdlc folder`);
  let text;
  if (from) text = readText(from);
  else if (interactive || answers) text = await onboardingInterview(dir, { answers });
  else throw new Error("sdlc new needs --from <config.yaml>, --interactive, or --answers <file>");
  const { config, errors } = parseConfig(text);
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);

  ensureDir(dir);
  git(["init", "-q", "-b", "main"], dir);
  copyTree(join(PIPELINE_ROOT, "templates", "project"), dir);
  writeText(join(dir, ".sdlc", "config.yaml"), text);
  ensureDir(join(dir, ".sdlc", "hooks"));
  copyFileSync(join(PIPELINE_ROOT, "templates", "hooks", "implement-guard.sh"), join(dir, ".sdlc", "hooks", "implement-guard.sh"));
  chmodSync(join(dir, ".sdlc", "hooks", "implement-guard.sh"), 0o755);

  const fill = (p, map) => writeText(p, Object.entries(map).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), readText(p)));
  const date = new Date().toISOString().slice(0, 10);
  fill(join(dir, "constitution.md"), { PROJECT_NAME: config.project.name, DATE: date });
  fill(join(dir, "spec", "spec.md"), { PROJECT_NAME: config.project.name,
    DOMAIN_SECTIONS: config.project.domains.map((d) => `## ${d}\n\n_No criteria yet._\n`).join("\n") });
  fill(join(dir, "spec", "contract", "openapi.yaml"), { PROJECT_NAME: config.project.name });
  fill(join(dir, "plan", "tasks.md"), { PROJECT_NAME: config.project.name });

  git(["add", "-A"], dir);
  git(["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost", "commit", "-q", "-m", `chore: create ${config.project.name} from agentic-sdlc templates`], dir);
  await init(dir);
  return { dir };
}

async function onboardingInterview(dir, { answers = null } = {}) {
  // Runs the onboarding skill in a Claude Code session and expects it to write <dir>.config.yaml next to dir.
  // With `answers`, a second party answers instead of a person: the file is a written stakeholder brief,
  // and the session is told to interview it and never invent a value the brief does not contain.
  const { execFileSync } = await import("node:child_process");
  const out = `${dir}.config.yaml`;
  const skill = readText(join(PIPELINE_ROOT, "skills", "onboarding", "SKILL.md"));
  const schema = readText(join(PIPELINE_ROOT, "schema", "config.schema.json"));
  let prompt = `${skill}\n\nThe configuration schema is:\n${schema}\n\nWrite the finished configuration to ${out} and nothing else.`;
  if (answers) prompt += `\n\nThere is no person to ask. Answer every question only from this stakeholder brief; where the brief is silent, leave the field out if optional or write a schema-valid placeholder and list it under a top-of-file comment "# open:".\n\n${readText(answers)}`;
  // "--" before the prompt tells claude's own argument parser to stop looking for flags: the
  // prompt is the onboarding skill's Markdown, which starts with a "---" front-matter fence,
  // and without "--" that gets misread as an unrecognized CLI option rather than positional text.
  const args = ["-p", "--allowedTools", "Write", "--", prompt];
  execFileSync("claude", args, { stdio: answers ? "pipe" : "inherit" });
  if (!existsSync(out)) throw new Error("onboarding did not produce a config file");
  return readText(out);
}

COMMANDS.new = async ({ pos, flags }) => {
  const r = await newProject({ dir: pos[0], from: flags.from, interactive: !!flags.interactive, answers: flags.answers ?? null });
  console.log(`created ${r.dir}`);
  return 0;
};

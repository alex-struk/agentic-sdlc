import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readText } from "./fsx.mjs";
import { PIPELINE_ROOT } from "./root.mjs";

// What a stack profile declares about its own toolchain, read from the YAML front matter
// of `stacks/<stack>/SKILL.md`. The stack is what knows where its tools write and which
// of the files they write are committed; the pipeline holds no list of directory or file
// names of its own, so a project on a stack that declares nothing gets no guesses.
function frontMatter(stack) {
  if (!stack) return null;
  const src = join(PIPELINE_ROOT, "stacks", stack, "SKILL.md");
  if (!existsSync(src)) return null;
  const m = readText(src).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  try { return parseYaml(m[1]); } catch { return null; }
}

function stackList(stack, key) {
  const v = frontMatter(stack)?.[key];
  return Array.isArray(v) ? v.map(String) : [];
}

// `ignore:` — what the toolchain writes and nobody commits. `init` adds these to the
// project's `.gitignore`, so compiled output never reaches a proposal at all.
export function stackIgnores(config) {
  return stackList(config?.stack, "ignore");
}

// `bulk:` — what the toolchain writes and everybody commits: a resolved dependency tree,
// a generated client, a migration baseline. These are evidence about the tool that wrote
// them and never about the change being ruled on, and one of them can be larger than the
// whole prompt budget, so they are kept out of the diff a persona is shown. Each entry is
// a git pathspec relative to the project root.
export function stackBulk(config) {
  return stackList(config?.stack, "bulk");
}

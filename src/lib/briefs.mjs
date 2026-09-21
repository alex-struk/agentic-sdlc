import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readText, writeText } from "./fsx.mjs";
import { PIPELINE_ROOT } from "./root.mjs";

// A persona brief is the pipeline's text living in a project's repository, and the two
// drift apart in one direction only: the pipeline gains a paragraph — a new condition
// form, a ruling a persona may now make — and every project scaffolded before it keeps a
// brief that still reads as a complete one. Nothing in the project is wrong, nothing
// fails, and the persona simply never uses the capability. A pipeline whose projects can
// only receive a capability by being created again is not reusable.
//
// So the brief a project holds is compared against the template it came from, and the
// three states that comparison can be in are told apart by a digest of the text `init`
// last wrote, recorded in `.sdlc/lock.json`:
//
//   current — the same text as the template.
//   behind  — different from the template, and identical to what init last wrote. Nobody
//             in the project has touched it, so the template is safe to take.
//   local   — different from the template and different from what init last wrote. Some-
//             body here changed it on purpose, or it predates the record. Either way the
//             pipeline does not know what would be lost, so it takes nothing and says so.
//
// A project that has never recorded a digest reads as `local`, which is the safe way to
// be wrong: it asks rather than overwrites.

export const BRIEF_DIR = join(".sdlc", "personas");
export const TEMPLATE_BRIEF_DIR = join(PIPELINE_ROOT, "templates", "project", BRIEF_DIR);

// The briefs the pipeline ships, read from the template directory rather than listed in
// code, so a persona added to the templates is carried by everything below without a
// second list to keep in step.
export function templateBriefs() {
  return readdirSync(TEMPLATE_BRIEF_DIR).filter((f) => f.endsWith(".md")).sort();
}

export function briefDigest(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// One entry per brief the pipeline ships: its state against the template, and the text
// the template holds. `recorded` is the `briefs` map from the project's lockfile.
export function briefStates(projectDir, recorded = {}) {
  return templateBriefs().map((file) => {
    const template = readText(join(TEMPLATE_BRIEF_DIR, file));
    const path = join(projectDir, BRIEF_DIR, file);
    if (!existsSync(path)) return { file, state: "missing", template };
    const text = readText(path);
    if (text === template) return { file, state: "current", template };
    if (recorded[file] && recorded[file] === briefDigest(text)) return { file, state: "behind", template };
    return { file, state: "local", template };
  });
}

// What an operator is told about a brief that is not current, in terms they can act on:
// which file, which way it differs, and what closes it.
export function briefWarning({ file, state }) {
  const rel = join(BRIEF_DIR, file);
  if (state === "missing") return `${rel} is missing; \`sdlc init\` installs it`;
  if (state === "behind") return `${rel} is behind its template and has no local edits; \`sdlc init\` brings it current`;
  return `${rel} differs from its template and carries local edits, so it is left as it is; \`sdlc init --adopt-briefs\` replaces it with the template`;
}

// Writes the briefs a project may take and leaves the rest alone, returning what it did
// by name. `adopt` is the operator saying, in so many words, replace my edits with the
// template: it is never the default, because a brief a project deliberately changed is
// the one thing here that cannot be recovered from the pipeline.
export function reconcileBriefs(projectDir, recorded = {}, { adopt = false } = {}) {
  const digests = {};
  const written = [];
  const updated = [];
  const adopted = [];
  const local = [];
  for (const b of briefStates(projectDir, recorded)) {
    const take = b.state === "missing" || b.state === "behind" || (b.state === "local" && adopt);
    if (take) {
      writeText(join(projectDir, BRIEF_DIR, b.file), b.template);
      if (b.state === "missing") written.push(b.file);
      else if (b.state === "behind") updated.push(b.file);
      else adopted.push(b.file);
    } else if (b.state === "local") {
      local.push(b.file);
      // The record stays as it was: a brief nobody here edited would have matched it, so
      // carrying it forward is what keeps this brief reading as local next time rather
      // than as one the pipeline may quietly take.
      if (recorded[b.file]) digests[b.file] = recorded[b.file];
      continue;
    }
    digests[b.file] = briefDigest(b.template);
  }
  return { digests, written, updated, adopted, local, changed: written.length + updated.length + adopted.length > 0 };
}

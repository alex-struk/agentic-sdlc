// The site's binary assets: the BC Sans faces the stylesheet declares. They live in the
// pipeline and are copied into the project, the same way template files are, so the
// generated site depends on nothing outside the project repository — no CDN, no network
// at read time, and no external request from a government page.
//
// The font is copied only when it is missing or its bytes differ, so a rebuild of an
// unchanged project writes nothing and leaves the working tree clean. That property is
// what lets every stage and every ruling rebuild the site without producing a diff.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FONT_FACES } from "./theme.mjs";

// Resolved here rather than imported from `new.mjs`, which sits in an existing import
// cycle with `init.mjs`: the site build must not join that cycle, since a module in one
// can observe a `const` from another before it is initialised depending on which entry
// point loaded first.
const PIPELINE_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

// Where a font face is read from in the pipeline, and written to in the project. The
// licence travels with the font because the Open Font License requires it to.
export function fontFiles() {
  return [...FONT_FACES.map(([file]) => `${file}.woff2`), "LICENSE_OFL.txt"];
}

export function installAssets(projectDir) {
  const written = [];
  for (const name of fontFiles()) {
    const src = join(PIPELINE_ROOT, "assets", "bc-sans", name);
    if (!existsSync(src)) continue;
    const dst = join(projectDir, "site", "assets", "fonts", name);
    const bytes = readFileSync(src);
    if (existsSync(dst) && readFileSync(dst).equals(bytes)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, bytes);
    written.push(`site/assets/fonts/${name}`);
  }
  return written;
}

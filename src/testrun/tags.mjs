// Tags on acceptance tests, and how a run selects by them. A test written for a configuration
// the target reads once at start-up carries that configuration's tag (`spec/contract/
// observables.yaml`, `configurations.<name>.tag`), and the tag is how a run picks it out for
// the instance started that way or leaves it out of every other run
// (`docs/decisions/0071-a-configuration-gets-its-own-oracle.md`).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What a tag may be: Playwright requires the leading `@`, and the rest is kept to characters
// that read the same in a regular expression, a YAML scalar and a command line.
export const TAG_RE = /^@[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;

// Characters that may continue a tag. A tag followed by one of them is the start of a longer
// tag, not this one.
const TAG_CONTINUES = "[A-Za-z0-9_.:-]";

// The regular expression Playwright's `--grep` and `--grep-invert` are given for `tags`.
// Playwright matches it anywhere in a test's title and tags, so each tag is anchored at its
// end: `@maintenance` must not select a test tagged `@maintenance_extended`.
export function tagPattern(tags) {
  return `(?:${tags.map(escapeRe).join("|")})(?!${TAG_CONTINUES})`;
}

// Every spec file under `tests/acceptance/`, project-relative, in a stable order.
export function specFiles(projectDir) {
  const root = join(projectDir, "tests", "acceptance");
  if (!existsSync(root)) return [];
  const out = [];
  for (const domain of readdirSync(root).sort()) {
    const abs = join(root, domain);
    if (!statSync(abs).isDirectory()) continue;
    for (const f of readdirSync(abs).sort()) {
      if (f.endsWith(".spec.ts") && statSync(join(abs, f)).isFile()) out.push(`tests/acceptance/${domain}/${f}`);
    }
  }
  return out;
}

// The spec files whose text carries `tag`, read from disk. This is the file-level answer:
// whether any test in the file is tagged. A run's own selection is Playwright's, test by
// test; this is what decides, before any run, whether a configuration has tests to run at
// all, and what stands in for Playwright's selection under the mock runner.
export function taggedSpecFiles(projectDir, tag) {
  const re = new RegExp(tagPattern([tag]));
  return specFiles(projectDir).filter((rel) => re.test(readFileSync(join(projectDir, rel), "utf8")));
}

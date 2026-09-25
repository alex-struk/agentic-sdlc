// `sdlc scrub [dir]` — rewrite every tracked file the egress check flags for a local home
// path, redacted, and commit the result as the pipeline.
//
// Decision 0020 has every writer of agent-produced text call `redactLocalPaths` at the
// point it writes, so a run after that call was added never commits one. It does nothing
// for a file already on `main` from before the call reached it — the egress check finds
// that file, but it only reads; it does not write (`src/checks/egress.mjs`). This closes
// that gap the same way for whichever writer it was: whatever tracked file the check's
// local-home-path pattern names gets the one substitution `redactLocalPaths` already
// applies everywhere else, and the fix is committed under the pipeline's own identity,
// not by a person editing history by hand (`docs/decisions/0059`).
//
// Scoped to the local-home-path pattern alone, not every rule E-2 catches. A name, a
// ticket number or a notes-folder path is a fact about what the text says and fixing it
// changes what the sentence means — that is a judgement call for whoever wrote it. A
// local path is different: it names the machine the text was produced on and nothing
// else, so substituting it for `~` is the same mechanical, idempotent rewrite
// `redactLocalPaths` already performs at every writer, whichever file it reaches late.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readText, writeText } from "../lib/fsx.mjs";
import { assertCleanTree, assertOnMain, git, SDLC_AUTHOR, stagePaths } from "../lib/git.mjs";
import { redactLocalPaths } from "../lib/redact.mjs";
import { checkEgress } from "../checks/egress.mjs";
import { checkConfig } from "../checks/config.mjs";
import { COMMANDS } from "../cli.mjs";

const REASON = "local home path (rule E-2)";

export function scrub(dir) {
  const projectDir = resolve(dir ?? process.cwd());
  assertCleanTree(projectDir, "scrub");
  assertOnMain(projectDir, "scrub");
  const { config } = checkConfig(projectDir);
  const { messages } = checkEgress(projectDir, { config });
  // Each message is `<path>:<line>: <reason>` (`checkEgress`, `src/checks/egress.mjs`); the
  // path is everything before the first colon, since the reason itself never contains one.
  const files = [...new Set(messages.filter((m) => m.endsWith(REASON)).map((m) => m.slice(0, m.indexOf(":"))))];
  const changed = [];
  for (const rel of files) {
    const abs = join(projectDir, rel);
    if (!existsSync(abs)) continue;
    const before = readText(abs);
    const after = redactLocalPaths(before, projectDir);
    if (after === before) continue;
    writeText(abs, after);
    changed.push(rel);
  }
  // Nothing to scrub is not an empty commit: a run with nothing to record leaves no mark,
  // the same restraint every other writer here takes.
  if (changed.length) {
    stagePaths(projectDir, changed);
    git([...SDLC_AUTHOR, "commit", "-q", "-m", `scrub: redact local home path(s) in ${changed.length} file(s) (rule E-2)`], projectDir);
  }
  return { changed };
}

COMMANDS.scrub = async ({ pos }) => {
  const r = scrub(pos[0]);
  console.log(r.changed.length ? r.changed.join("\n") : "nothing to scrub");
  return 0;
};

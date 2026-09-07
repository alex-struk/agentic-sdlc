import { existsSync, rmSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { git } from "../lib/git.mjs";
import { writeText } from "../lib/fsx.mjs";

// Clones the old application into `<projectDir>/sources/old`, checks it out at the
// configured commit, and removes every excluded path from the working tree — a plain
// filesystem removal, not a git operation, so the clone's own history is untouched and
// the exclusion simply does not exist to read. Idempotent: a second call against an
// already-materialised source directory clones nothing, checks out nothing (the commit
// already matches) and rewrites the marker only if its content would actually differ.
export function ensureSources(projectDir, config) {
  const source = config?.sources?.old;
  if (!source) throw new Error("no sources.old in config");
  const { repo, commit, exclude = [] } = source;

  const dir = join(projectDir, "sources", "old");
  // A relative repo path is relative to the project, the same convention every other
  // path in config.yaml uses — not to the process's own cwd, which a caller running
  // from elsewhere would get wrong.
  const repoPath = isAbsolute(repo) || /^[a-z][a-z0-9+.-]*:/i.test(repo) ? repo : resolve(projectDir, repo);

  if (!existsSync(dir)) {
    git(["clone", "-q", repoPath, dir], projectDir);
  }
  if (git(["rev-parse", "HEAD"], dir) !== commit) {
    git(["checkout", "-q", commit], dir);
  }

  for (const entry of exclude) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }

  // The marker records what this clone is, for a human or another command to read —
  // it is not part of the old application's own history, so it is kept out of `git
  // status` for this checkout the same way any other local scratch file would be: a
  // line in `.git/info/exclude`, which lives in the clone itself and is never
  // committed.
  const excludePath = join(dir, ".git", "info", "exclude");
  const excludeText = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (!excludeText.split("\n").some((l) => l.trim() === ".sdlc-sources.json")) {
    writeText(excludePath, `${excludeText}${excludeText && !excludeText.endsWith("\n") ? "\n" : ""}.sdlc-sources.json\n`);
  }

  const markerPath = join(dir, ".sdlc-sources.json");
  const existing = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : null;
  // `at` is only refreshed when something about the source actually changed — otherwise
  // a repeat call with nothing new to say would still touch the marker's mtime, which
  // is exactly the no-op a second `ensureSources` call is supposed to be.
  const prior = existing ? JSON.parse(existing) : null;
  const same = prior && prior.repo === repo && prior.commit === commit
    && JSON.stringify(prior.excluded) === JSON.stringify(exclude);
  if (!same) {
    const marker = { repo, commit, excluded: exclude, at: new Date().toISOString() };
    writeText(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  }

  return { dir, commit };
}

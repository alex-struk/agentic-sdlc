// A record file changed outside a pipeline commit.
//
// The record `sdlc next` reads, and every ruling and run relies on, is changed only by stage
// runs and rulings, and every commit the pipeline makes is authored as `SDLC_AUTHOR`
// (`src/lib/git.mjs`). A commit by any other author that touches a record file changed the
// record without a run or a ruling behind it. The record files are the owed-work ledgers
// (`OWED_FILES`, `src/spec/owed.mjs`), the gate files under `.sdlc/gates/`, and
// `.sdlc/lock.json`.
//
// Whether a finding warns or fails is `policy.checks.hand_edits`. Only commits made on or
// after `HAND_EDITS_SINCE`, the day the check exists from, are read: history written before
// anything flagged it was never held to it. `sdlc init` rewrites `.sdlc/lock.json` and
// leaves the commit to the project's owner, so an upgrade is reported here like any other
// change to that file; the finding names the commit, and the owner can see which it is.
import { git, gitOk, SDLC_AUTHOR_EMAIL } from "../lib/git.mjs";
import { OWED_FILES } from "../spec/owed.mjs";
import { handEditSeverity } from "../config/policy.mjs";

export const HAND_EDITS_SINCE = "2026-09-24T00:00:00Z";

export const RECORD_PATHS = Object.freeze([...OWED_FILES, ".sdlc/gates", ".sdlc/lock.json"]);

export function checkHandEdits(projectDir, ctx = {}) {
  const id = "hand-edits";
  if (!gitOk(["rev-parse", "--verify", "-q", "HEAD"], projectDir)) return { id, ok: true, messages: [] };
  const log = git(["log", "HEAD", `--since=${HAND_EDITS_SINCE}`, "--no-merges", "--format=%x1e%h%x1f%ae%x1f%s", "--name-only", "--", ...RECORD_PATHS], projectDir);
  const findings = [];
  for (const entry of log.split("\x1e").filter((e) => e.trim())) {
    const [head, ...files] = entry.split("\n");
    const [sha, email, subject] = head.split("\x1f");
    if (email === SDLC_AUTHOR_EMAIL) continue;
    const paths = files.map((f) => f.trim()).filter(Boolean);
    if (paths.length) findings.push(`${sha} "${subject}" changes ${paths.join(", ")} outside a pipeline commit`);
  }
  if (handEditSeverity(ctx.config) === "fail") return { id, ok: findings.length === 0, messages: findings };
  return { id, ok: true, messages: [], warnings: findings };
}

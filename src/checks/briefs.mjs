import { existsSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fsx.mjs";
import { briefStates, briefWarning, BRIEF_DIR } from "../lib/briefs.mjs";

// Reports a persona brief that is not the text the pipeline now ships, in the one place
// an operator and a ruling persona both read: the checks.
//
// It warns and never fails. A brief that is behind its template is not a fault in the
// project — the project did nothing — and a brief a team changed on purpose is a choice
// the pipeline has no standing to call wrong. What neither may do is go unsaid: a stale
// brief reads exactly like a current one, so without this the gap is invisible from
// inside the project and from inside the ruling made with it.
export function checkBriefs(projectDir) {
  const id = "briefs";
  if (!existsSync(join(projectDir, BRIEF_DIR))) return { id, ok: true, messages: [], warnings: [] };
  const lockPath = join(projectDir, ".sdlc", "lock.json");
  let recorded = {};
  if (existsSync(lockPath)) {
    try { recorded = JSON.parse(readText(lockPath)).briefs ?? {}; } catch { recorded = {}; }
  }
  // A project need not install every persona the pipeline ships — a gate nobody holds by
  // agent needs no brief — so a brief that was never installed is not reported here.
  const warnings = briefStates(projectDir, recorded).filter((b) => b.state === "behind" || b.state === "local").map(briefWarning);
  return { id, ok: true, messages: [], warnings };
}

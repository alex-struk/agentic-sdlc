import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./fsx.mjs";
import { redactLocalPaths } from "./redact.mjs";

// Lines recorded from inside a stage, waiting for the stage's own. Matched by the
// `.sdlc/*.local.txt` line every project's `.gitignore` carries (`src/lib/git.mjs`), so a
// waiting line is never a change in the working tree.
export const PENDING_RUNS = join(".sdlc", "runs.local.txt");

function dayOf(now) { return now.toISOString().slice(0, 10); }
function timeOf(now) { return now.toTimeString().slice(0, 8); }

// Newlines are folded out for the same reason the record is one line per run: an entry
// that spans lines is no longer an entry a reader can scan.
function clean(projectDir, line) {
  return redactLocalPaths(line, projectDir).replace(/\s*\n\s*/g, " ");
}

// The lines waiting in `PENDING_RUNS`, oldest first, written into the record ahead of
// whatever is appended now and then cleared. A line from an earlier day than the file it
// lands in carries that day, since the file name no longer says it.
function flushPending(projectDir, day, p) {
  const pending = join(projectDir, PENDING_RUNS);
  if (!existsSync(pending)) return;
  const entries = readFileSync(pending, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const e of entries) appendFileSync(p, `- ${e.day === day ? "" : `${e.day} `}${e.time} ${e.line}\n`);
  rmSync(pending, { force: true });
}

// One line per run outcome, committed and published as `site/runs.*`. The line is often
// the first line of a stage's own account of itself, so it carries whatever that account
// quoted — a container log, a test error, a command that failed — and goes through rule
// E-2's redaction (`src/lib/redact.mjs`) on the way in.
export function appendRun(projectDir, line) {
  const now = new Date();
  const day = dayOf(now);
  const dir = join(projectDir, ".sdlc", "runs");
  ensureDir(dir);
  const p = join(dir, `${day}.md`);
  if (!existsSync(p)) appendFileSync(p, `# Run record ${day}\n\n`);
  flushPending(projectDir, day, p);
  appendFileSync(p, `- ${timeOf(now)} ${clean(projectDir, line)}\n`);
  return p;
}

// A run-record line for something done while a stage runs — a pipeline command its
// session invoked, or one the stage called in-process. It is written into the record by
// the next `appendRun`, which is the stage's own outcome line, so it lands in the stage's
// own commit or proposal. Written straight into the record, it would be a change in the
// working tree the stage's scope checks count as the agent's, or a commit on `main` in the
// middle of the stage. The journal is kept out of the stage's way for the same reason: the
// runner writes it after the post-checks, never during the turn.
export function deferRun(projectDir, line, now = new Date()) {
  const pending = join(projectDir, PENDING_RUNS);
  ensureDir(join(projectDir, ".sdlc"));
  appendFileSync(pending, `${JSON.stringify({ day: dayOf(now), time: timeOf(now), line: clean(projectDir, line) })}\n`);
}

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./fsx.mjs";
import { redactLocalPaths } from "./redact.mjs";

// One line per run outcome, committed and published as `site/runs.*`. The line is often
// the first line of a stage's own account of itself, so it carries whatever that account
// quoted — a container log, a test error, a command that failed — and goes through rule
// E-2's redaction (`src/lib/redact.mjs`) on the way in. Newlines are folded out for the
// same reason the record is one line per run: an entry that spans lines is no longer an
// entry a reader can scan.
export function appendRun(projectDir, line) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const hms = now.toTimeString().slice(0, 8);
  const dir = join(projectDir, ".sdlc", "runs");
  ensureDir(dir);
  const p = join(dir, `${day}.md`);
  if (!existsSync(p)) appendFileSync(p, `# Run record ${day}\n\n`);
  appendFileSync(p, `- ${hms} ${redactLocalPaths(line, projectDir).replace(/\s*\n\s*/g, " ")}\n`);
  return p;
}

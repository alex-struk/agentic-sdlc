import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./fsx.mjs";
export function appendRun(projectDir, line) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const hms = now.toTimeString().slice(0, 8);
  const dir = join(projectDir, ".sdlc", "runs");
  ensureDir(dir);
  const p = join(dir, `${day}.md`);
  if (!existsSync(p)) appendFileSync(p, `# Run record ${day}\n\n`);
  appendFileSync(p, `- ${hms} ${line}\n`);
  return p;
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { git } from "../lib/git.mjs";
import { readText } from "../lib/fsx.mjs";

const PATTERNS = [
  [/\b[A-Z]{2,5}-\d{2,5}\b/, "internal ticket number (rule E-2)"],
  [/(^|[\s"'(])![A-Z][A-Za-z]+\//, "private notes folder path (rule E-2)"],
  [/OneDrive/, "private notes location (rule E-2)"],
  [/\bTeams (call|chat|transcript|message|meeting)\b/i, "meeting reference (rule E-2)"],
  [/\.vtt\b/, "transcript file reference (rule E-2)"],
];
const TEXT_EXT = /\.(md|mjs|js|ts|tsx|json|ya?ml|txt|sh|feature|svg|py|html|css)$/i;

export const DEFAULT_NAMES = join(homedir(), ".config", "agentic-sdlc", "egress-names.txt");

function nameList(projectDir) {
  const candidates = [process.env.SDLC_EGRESS_NAMES, join(projectDir, ".sdlc", "egress.local.txt"), DEFAULT_NAMES].filter(Boolean);
  for (const c of candidates) if (existsSync(c))
    return readText(c).split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  return [];
}

export function checkEgress(projectDir, ctx = {}) {
  const id = "egress";
  const names = nameList(projectDir);
  const warnings = names.length ? [] : [`no egress name list found; add colleagues' names, one per line, to ${DEFAULT_NAMES}`];
  const files = git(["ls-files"], projectDir).split("\n").filter((f) => f && TEXT_EXT.test(f) && !f.startsWith(".sdlc/packs/"));
  const scoped = ctx.self ? files.filter((f) => f.startsWith("docs/") || f.startsWith("skills/") || f.startsWith("templates/") || f.startsWith("stacks/")) : files;
  const messages = [];
  for (const f of scoped) {
    const lines = readText(join(projectDir, f)).split("\n");
    lines.forEach((line, i) => {
      for (const [re, why] of PATTERNS) if (re.test(line)) messages.push(`${f}:${i + 1}: ${why}`);
      for (const n of names) if (line.includes(n)) messages.push(`${f}:${i + 1}: listed name (rule E-2)`);
    });
  }
  return { id, ok: messages.length === 0, messages, warnings };
}

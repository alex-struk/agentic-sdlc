import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { git } from "../lib/git.mjs";
import { readText } from "../lib/fsx.mjs";

// The self-check scans this file too, so a pattern whose source would spell out the
// very thing it forbids is assembled from pieces: `new RegExp("One" + "Drive")` matches
// the word without ever containing it. The alternative — carving this file out of the
// scan — is how a real leak would get through.
const PATTERNS = [
  [/\b[A-Z]{2,5}-\d{2,5}\b/, "internal ticket number (rule E-2)"],
  [/(^|[\s"'(])![A-Z][A-Za-z]+\//, "private notes folder path (rule E-2)"],
  [new RegExp("One" + "Drive"), "private notes location (rule E-2)"],
  [/\bTeams (call|chat|transcript|message|meeting)\b/i, "meeting reference (rule E-2)"],
  [new RegExp("\\." + "vtt\\b"), "transcript file reference (rule E-2)"],
  [new RegExp("(/" + "home/|/" + "Users/|[A-Za-z]:\\\\" + "Users\\\\)[A-Za-z0-9._-]+"), "local home path (rule E-2)"],
];
const TEXT_EXT = /\.(md|mjs|js|ts|tsx|json|ya?ml|txt|sh|feature|svg|py|html|css)$/i;

// In self mode every tracked text file is scanned. An allow list of directories is the
// wrong shape for a leak check: a file added to a directory nobody remembered to list
// is silently unscanned. These are the only exclusions, and each is either not ours
// (dependencies) or a working note that never ships.
const SELF_EXCLUDE = ["node_modules/", "package-lock.json", ".superpowers/", "docs/superpowers/"];

// Resolved on every call rather than at import, so a session (or a test) that sets
// SDLC_EGRESS_NAMES or XDG_CONFIG_HOME is honoured by the check, by `doctor`, and by
// the file `init` seeds.
export function defaultNamesPath() {
  return process.env.SDLC_EGRESS_NAMES
    ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agentic-sdlc", "egress-names.txt");
}

function nameList(projectDir) {
  const candidates = [process.env.SDLC_EGRESS_NAMES, join(projectDir, ".sdlc", "egress.local.txt"), defaultNamesPath()].filter(Boolean);
  for (const c of candidates) if (existsSync(c))
    return readText(c).split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  return [];
}

export function checkEgress(projectDir, ctx = {}) {
  const id = "egress";
  const names = nameList(projectDir);
  const warnings = names.length ? [] : [`no egress name list found; add colleagues' names, one per line, to ${defaultNamesPath()}`];
  const files = git(["ls-files"], projectDir).split("\n").filter((f) => f && TEXT_EXT.test(f) && !f.startsWith(".sdlc/packs/"));
  const scoped = ctx.self ? files.filter((f) => !SELF_EXCLUDE.some((x) => f === x || f.startsWith(x))) : files;
  const messages = [];
  for (const f of scoped) {
    // A path git still tracks but that is gone from disk (deleted, not yet committed)
    // has no content to scan.
    if (!existsSync(join(projectDir, f))) continue;
    const lines = readText(join(projectDir, f)).split("\n");
    lines.forEach((line, i) => {
      for (const [re, why] of PATTERNS) if (re.test(line)) messages.push(`${f}:${i + 1}: ${why}`);
      for (const n of names) if (line.includes(n)) messages.push(`${f}:${i + 1}: listed name (rule E-2)`);
    });
  }
  return { id, ok: messages.length === 0, messages, warnings };
}

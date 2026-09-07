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
const TEXT_EXT = /\.(md|mjs|js|ts|tsx|json|ya?ml|txt|sh|sql|feature|svg|py|html|css)$/i;

// Patterns that apply only when this repository checks itself, each with the paths it
// does not apply to. The pipeline is generic and its documentation, code, tests and
// fixtures must not name the one application it was first built against; the two places
// that legitimately do are the design spec that records that engagement and the poster
// drawn from it. Assembled from pieces for the same reason as the patterns above: this
// file is scanned too.
const SELF_PATTERNS = [
  [new RegExp("market" + "place", "i"), "names the application this pipeline was first built against (rule E-2)",
    ["docs/specs/", "docs/poster/"]],
];

// In self mode every text file the scan lists is read. An allow list of directories is
// the wrong shape for a leak check: a file added to a directory nobody remembered to
// list is silently unscanned. These are the only exclusions, and each is either not ours
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

// Every text file the check reads: what git tracks, plus what it does not track and does
// not ignore. The untracked half is the point — a stage's own output is uncommitted at
// the moment its post-checks run, so a leak in a seed file the `contract` stage just
// wrote would be invisible to a tracked-only scan and reach the commit unexamined.
// Ignored files stay out (that is what `--exclude-standard` means), so `node_modules`,
// `sources/` and the acceptance harness's own results never enter the list.
function scannedFiles(projectDir) {
  const lines = [
    ...git(["ls-files"], projectDir).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard"], projectDir).split("\n"),
  ];
  const seen = new Set();
  return lines.filter((f) => f && TEXT_EXT.test(f) && !f.startsWith(".sdlc/packs/")
    && !seen.has(f) && seen.add(f));
}

export function checkEgress(projectDir, ctx = {}) {
  const id = "egress";
  const names = nameList(projectDir);
  const warnings = names.length ? [] : [`no egress name list found; add colleagues' names, one per line, to ${defaultNamesPath()}`];
  const files = scannedFiles(projectDir);
  const scoped = ctx.self ? files.filter((f) => !SELF_EXCLUDE.some((x) => f === x || f.startsWith(x))) : files;
  const messages = [];
  for (const f of scoped) {
    // A path git still tracks but that is gone from disk (deleted, not yet committed)
    // has no content to scan.
    if (!existsSync(join(projectDir, f))) continue;
    const extra = ctx.self ? SELF_PATTERNS.filter(([, , exempt]) => !exempt.some((x) => f.startsWith(x))) : [];
    const lines = readText(join(projectDir, f)).split("\n");
    lines.forEach((line, i) => {
      for (const [re, why] of PATTERNS) if (re.test(line)) messages.push(`${f}:${i + 1}: ${why}`);
      for (const [re, why] of extra) if (re.test(line)) messages.push(`${f}:${i + 1}: ${why}`);
      for (const n of names) if (line.includes(n)) messages.push(`${f}:${i + 1}: listed name (rule E-2)`);
    });
  }
  return { id, ok: messages.length === 0, messages, warnings };
}

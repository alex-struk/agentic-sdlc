// The rule that makes "tests never see code" real: an adapter drives the running
// application and never asserts, a test asserts against `surface`/`persona`/`seed` and
// never touches a locator, a URL or the page object directly. Both halves are scanned by
// line-based regexes over the file text rather than parsed as TypeScript — the pipeline
// has no TS parser dependency, and a regex is enough to catch the patterns that defeat
// blindness (an `expect(` in an adapter, a `page.` in a test) without one.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { readText } from "../lib/fsx.mjs";

function listTsFiles(root) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) out.push(p);
    }
  };
  walk(root);
  return out;
}

// Path-shaped, forward-slash relative path for a message — `relative` returns `\`-joined
// segments on Windows, which would make a rule name look like a Windows path rather than
// the project-relative one every other check message uses.
function relPath(projectDir, absPath) {
  return relative(projectDir, absPath).split(sep).join("/");
}

// Finds an `import ... from "path"` or `require("path")` clause on a line and returns the
// path, or null. Only the first match on a line is used — a line legitimately carries at
// most one import.
function importPath(line) {
  const m = /\bimport\b[^;]*\bfrom\s+["'`]([^"'`]+)["'`]/.exec(line) || /\brequire\(\s*["'`]([^"'`]+)["'`]/.exec(line);
  return m ? m[1] : null;
}

// A quoted string literal (single, double or backtick), captured without its quotes.
// Escaped quotes inside the literal are tolerated so an ordinary escaped-apostrophe
// string does not truncate the match early.
const STRING_LITERAL_RE = /(['"`])((?:\\.|(?!\1).)*)\1/g;

// True for a string that reads as a route: an absolute URL, or a path that starts with
// `/` followed by a letter. A lone `"/"` is allowed — it is as likely to be division or a
// default value as a route, and flagging it produces nothing but noise.
function isRouteLiteral(value) {
  if (value === "/") return false;
  return /^https?:\/\//.test(value) || /^\/[A-Za-z]/.test(value);
}

function findRouteLiteral(line) {
  STRING_LITERAL_RE.lastIndex = 0;
  let m;
  while ((m = STRING_LITERAL_RE.exec(line))) {
    if (isRouteLiteral(m[2])) return m[2];
  }
  return null;
}

// An adapter drives the running application and reports back through `Surface`; it must
// never assert (that is the test's job), never reach into the acceptance suite or the
// application source it is meant to isolate the test from, and never define its own
// `test(...)` block, which would make it a second, unblind copy of the suite.
const ADAPTER_RULES = [
  {
    test: (l) => (l.includes("expect(") ? "expect(" : null),
    message: () => "adapters must not assert: contains expect(",
  },
  {
    test: (l) => {
      const p = importPath(l);
      if (!p) return null;
      return p.includes("../acceptance") || p.includes("app/") ? p : null;
    },
    message: (p) => `adapters must not import from tests/acceptance or app/: ${p}`,
  },
  {
    test: (l) => (/\btest\(/.test(l) ? "test(" : null),
    message: () => "adapters must not define a test(): contains test(",
  },
];

// A test asserts against the generated `Surface` and never reaches past it: not into the
// adapter or application source, not into the page object Playwright hands the adapter,
// not into a locator, a testid or a hand-rolled query, and not into a hardcoded route —
// all of those are exactly what an adapter exists to hide. `skipComments` rules are the
// two most likely to false-positive on this codebase's own dense prose comments and the
// provenance header every spec file carries: a comment explaining what a route or a
// locator is must not itself trip the rule that forbids using one.
const ACCEPTANCE_RULES = [
  {
    test: (l) => {
      const p = importPath(l);
      if (!p) return null;
      return p.includes("/adapters/") || p.includes("app/") || p.includes("../../app") ? p : null;
    },
    message: (p) => `tests must not import from tests/adapters or app/: ${p}`,
  },
  {
    skipComments: true,
    test: (l) => (/\bpage\./.test(l) ? "page." : null),
    message: () => "a test must not touch the page object: contains page.",
  },
  {
    skipComments: true,
    test: (l) => (/\blocator\(/.test(l) ? "locator(" : null),
    message: () => "a test must not call a locator directly: contains locator(",
  },
  {
    skipComments: true,
    test: (l) => (/\bgetBy[A-Za-z]*/.test(l) ? "getBy" : null),
    message: () => "a test must not call a locator directly: contains getBy",
  },
  {
    skipComments: true,
    test: (l) => (l.includes("data-testid") ? "data-testid" : null),
    message: () => "a test must not select by data-testid: contains data-testid",
  },
  {
    skipComments: true,
    test: (l) => (/\bquerySelector\b/.test(l) ? "querySelector" : null),
    message: () => "a test must not call querySelector: contains querySelector",
  },
  {
    skipComments: true,
    test: (l) => findRouteLiteral(l),
    message: (v) => `a test must not hardcode a route: ${JSON.stringify(v)}`,
  },
  {
    test: (l) => (/\bgoto\(/.test(l) ? "goto(" : null),
    message: () => "a test must not navigate directly: contains goto(",
  },
];

function scanFile(absPath, projectDir, rules) {
  const rel = relPath(projectDir, absPath);
  const lines = readText(absPath).split("\n");
  const messages = [];
  lines.forEach((line, i) => {
    const isComment = line.trim().startsWith("//");
    for (const rule of rules) {
      if (rule.skipComments && isComment) continue;
      const hit = rule.test(line);
      if (hit) messages.push(`${rel}:${i + 1}: ${rule.message(hit)}`);
    }
  });
  return messages;
}

export function checkSeparation(projectDir) {
  const id = "separation";
  const messages = [];
  for (const abs of listTsFiles(join(projectDir, "tests", "adapters"))) messages.push(...scanFile(abs, projectDir, ADAPTER_RULES));
  for (const abs of listTsFiles(join(projectDir, "tests", "acceptance"))) messages.push(...scanFile(abs, projectDir, ACCEPTANCE_RULES));
  return { id, ok: messages.length === 0, messages };
}

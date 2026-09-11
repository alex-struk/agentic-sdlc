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

// Finds a module specifier on a line and returns it, or null. All four ways a file can
// name another one are matched, because all four defeat the separation rules equally: a
// static `import ... from "path"`, a re-export (`export { x } from "path"`, `export *
// from "path"`), a dynamic `import("path")`, and `require("path")`. Only the first match
// on a line is used — a line legitimately carries at most one of them.
function importPath(line) {
  const m = /\b(?:import|export)\b[^;]*\bfrom\s+["'`]([^"'`]+)["'`]/.exec(line)
    || /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/.exec(line)
    || /\brequire\(\s*["'`]([^"'`]+)["'`]/.exec(line);
  return m ? m[1] : null;
}

// True when "app" is a path segment of its own — whether the path continues past it
// (`app/x`, `./app/x`, `../../app/x`) or ends there (`app`, `../../app`, an index import
// of the application's own directory). Never a fragment of a longer segment such as
// `webapp/utils`, which is a real project directory that has nothing to do with the
// application source the separation rules exist to keep out of adapters and tests.
function isAppSegment(path) {
  return /(^|\/)app(\/|$)/.test(path);
}

// `importPath` only ever matches a single physical line, so a multi-line import or
// re-export — `import {\n  x,\n} from "../../adapters/old/x";` — is invisible to it:
// "import" and `from "..."` never share a line. This walks the file once, and for any
// line starting an `import` or `export` statement, joins forward (skipping the lines it
// consumes for the per-line scan below) until `importPath` resolves against the joined
// text or the statement plainly ends (a trailing `;` or a trailing quoted path with no
// semicolon). A dynamic `import(...)` and a `require(...)` call are always single-line in
// practice and need no joining. Reported against the statement's first line, 1-based,
// matching every other message in this file.
function collectImports(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*(?:import|export)\b/.test(line)) {
      const p = importPath(line);
      if (p) found.push({ line: i + 1, path: p });
      continue;
    }
    let end = i;
    let joined = line;
    while (
      importPath(joined) === null &&
      !/;\s*$/.test(lines[end].trimEnd()) &&
      !/["'`]\s*$/.test(lines[end].trimEnd()) &&
      end + 1 < lines.length
    ) {
      end++;
      joined += " " + lines[end];
    }
    const p = importPath(joined);
    if (p) found.push({ line: i + 1, path: p });
    i = end;
  }
  return found;
}

// A quoted string literal (single, double or backtick), captured without its quotes.
// Escaped quotes inside the literal are tolerated so an ordinary escaped-apostrophe
// string does not truncate the match early.
const STRING_LITERAL_RE = /(['"`])((?:\\.|(?!\1).)*)\1/g;

// True for a string that reads as a route: an absolute URL, or a path that starts with
// `/` followed by a path character — a letter, digit, or one of `_:.` so a versioned
// route (`/1.0/x`), a framework-prefixed one (`/_admin`) and a param placeholder
// (`/:id`) are all caught, not just plain word paths. A lone `"/"` is allowed — it is as
// likely to be division or a default value as a route, and flagging it produces nothing
// but noise.
function isRouteLiteral(value) {
  if (value === "/") return false;
  return /^https?:\/\//.test(value) || /^\/[A-Za-z0-9_:.]/.test(value);
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
// Both call rules below exclude a preceding `.`, `?.` or identifier character, so they
// match a bare call and not a method on something else. `\b` is not enough and was not:
// it matches between the dot and the name, so `LOOKS_LIKE_A_VALUE.test(line)` — an
// ordinary regular-expression test, which any adapter that reads text will contain — read
// as a test definition. A 2,635-line adapter that had bound 658 of 680 members was
// refused over nine of those, after ninety minutes of driving a real browser.
const BARE_CALL = (name) => new RegExp(String.raw`(?<![.?\w$])${name}\s*\(`);
const EXPECT_CALL = BARE_CALL("expect");
const TEST_CALL = BARE_CALL("test");

const ADAPTER_RULES = [
  {
    test: (l) => (EXPECT_CALL.test(l) ? "expect(" : null),
    message: () => "adapters must not assert: contains expect(",
  },
  {
    isImportRule: true,
    test: (p) => (p.includes("../acceptance") || isAppSegment(p) ? p : null),
    message: (p) => `adapters must not import from tests/acceptance or app/: ${p}`,
  },
  {
    test: (l) => (TEST_CALL.test(l) ? "test(" : null),
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
    isImportRule: true,
    test: (p) => (p.includes("/adapters/") || isAppSegment(p) ? p : null),
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
  // Import rules are checked once per logical import statement (joined across lines when
  // it spans more than one), keyed by the statement's first line; every other rule stays
  // line-based, scanning the file exactly as it is written.
  const importsByLine = new Map(collectImports(lines).map((im) => [im.line, im.path]));
  const messages = [];
  lines.forEach((line, i) => {
    const isComment = line.trim().startsWith("//");
    for (const rule of rules) {
      if (rule.skipComments && isComment) continue;
      if (rule.isImportRule) {
        const p = importsByLine.get(i + 1);
        if (p === undefined) continue;
        const hit = rule.test(p);
        if (hit) messages.push(`${rel}:${i + 1}: ${rule.message(hit)}`);
        continue;
      }
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

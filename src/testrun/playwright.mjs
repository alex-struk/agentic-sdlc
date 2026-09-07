// Runs the project's acceptance suite (the Playwright harness under `templates/project/tests/`,
// Task 2) and maps its JSON report onto one row per criterion — pass, fail, unbound,
// stale, or not-testable. `calibrate` (the next task) is the only caller that turns those
// rows into ratify items; this module only runs the suite and does the mapping.
//
// Docker and Playwright are not available in the environment this code is tested in, so
// every subprocess goes through the injectable `exec` option, and `SDLC_TEST_RUNNER=mock`
// short-circuits the whole run (modelled on `SDLC_ORACLE=mock` in `src/oracle/compose.mjs`
// and `SDLC_EXECUTOR=mock` in `src/runner/executor.mjs`) for a caller that needs a result
// with no suite, no browser and no npm registry in reach at all.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readText } from "../lib/fsx.mjs";
import { checkTests, loadIndex, readHeader, readNotTestable } from "../checks/tests.mjs";

// A failing test's error message is how an unbound adapter member is told apart from a
// real defect: `bind-adapter` throws `Error("unbound: <page>.<member> — <reason>")` from
// the member itself (`src/stages/registry.mjs`), so that string opens the first line of
// the failure. `m` (multiline) because Playwright's own error message sometimes carries a
// stack trace after the thrown message's first line.
const UNBOUND_RE = /^unbound: /m;

// The default `exec`: a real subprocess, run synchronously and never throwing — a
// non-zero exit is exactly as valid a result as zero for every step here (a `npm ci`
// failure surfaces through the missing `node_modules` it was supposed to produce; a
// `playwright test` failure surfaces through the report it wrote either way).
function defaultExec(cmd, args, { cwd, env = {} } = {}) {
  const res = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// `npm ci --prefix tests` when the harness's own `node_modules` is missing or stale
// against its lockfile; `npm install --prefix tests` the first time, when there is no
// lockfile yet to `ci` against (the caller commits the lockfile that produces). Mirrors
// how `npm ci` itself decides staleness: comparing the lockfile's mtime against the
// `.package-lock.json` snapshot `npm ci` leaves in `node_modules` on a clean install.
function ensureDeps(projectDir, exec) {
  const testsDir = join(projectDir, "tests");
  const lockfile = join(testsDir, "package-lock.json");
  if (!existsSync(lockfile)) {
    exec("npm", ["install", "--prefix", "tests"], { cwd: projectDir, env: {} });
    return;
  }
  const nodeModules = join(testsDir, "node_modules");
  const lockSnapshot = join(nodeModules, ".package-lock.json");
  const snapshotMtime = existsSync(lockSnapshot) ? statSync(lockSnapshot).mtimeMs : -Infinity;
  const stale = !existsSync(nodeModules) || statSync(lockfile).mtimeMs > snapshotMtime;
  if (stale) exec("npm", ["ci", "--prefix", "tests"], { cwd: projectDir, env: {} });
}

// Whether a chromium build is already unpacked somewhere Playwright would find it, so a
// run against a machine that already has it never re-downloads a browser on every call.
function chromiumInstalled() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(base)) return false;
  return readdirSync(base).some((name) => name.startsWith("chromium") && statSync(join(base, name)).isDirectory());
}

function ensureBrowsers(projectDir, exec) {
  if (chromiumInstalled()) return;
  exec("npx", ["--prefix", "tests", "playwright", "install", "chromium"], { cwd: projectDir, env: {} });
}

// Every spec in the report tree, regardless of how deep the describe blocks that hold it
// nest — a spec's own `file` field (not the enclosing suite's) is what groups it back to
// the criterion file it belongs to.
function collectSpecs(suites, acc = []) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) acc.push(spec);
    collectSpecs(suite.suites, acc);
  }
  return acc;
}

// A spec's outcome is its last result — the only one that matters when retries are
// disabled (`playwright.config.ts` sets `retries: 0`) is also the only one there is, and
// this reads the same either way if that ever changes.
function specOutcomes(spec) {
  return (spec.tests ?? []).map((t) => {
    const results = t.results ?? [];
    const last = results[results.length - 1] ?? {};
    return { title: spec.title, status: last.status ?? "skipped", error: last.error?.message };
  });
}

// Groups a Playwright JSON report's specs by file and turns each group into one row: the
// criterion id and version come from the spec file's own header (`readHeader`, shared with
// `checkTests`), not the filename, so a mismatched filename is still reported the same way
// `checkTests` would flag it, only here as a row nothing can silently drop. `staleIds` is
// `checkTests(projectDir).stale` — the same set the tests check already computes.
function buildRows(report, projectDir, staleIds) {
  const byFile = new Map();
  for (const spec of collectSpecs(report.suites)) {
    if (!byFile.has(spec.file)) byFile.set(spec.file, []);
    byFile.get(spec.file).push(spec);
  }

  const rows = [];
  for (const [file, specsForFile] of byFile) {
    const domain = basename(dirname(file));
    const filename = basename(file);
    const relFile = `tests/acceptance/${domain}/${filename}`;
    const absFile = join(projectDir, "tests", "acceptance", domain, filename);
    const tests = specsForFile.flatMap(specOutcomes);

    if (!existsSync(absFile)) {
      rows.push({ id: null, version: null, domain, file: relFile, result: "fail", tests, error: `${relFile}: spec file not found on disk` });
      continue;
    }
    const header = readHeader(absFile, relFile);
    if (header.error) {
      rows.push({ id: null, version: null, domain, file: relFile, result: "fail", tests, error: header.error });
      continue;
    }

    const failing = tests.filter((t) => t.status === "failed" || t.status === "timedOut");
    let result;
    if (failing.length === 0) result = "pass";
    else if (failing.every((t) => t.error && UNBOUND_RE.test(t.error))) result = "unbound";
    else result = "fail";
    if (staleIds.has(header.id)) result = "stale";

    rows.push({ id: header.id, version: header.version, domain, file: relFile, result, tests });
  }
  return rows;
}

// One row per `not-testable.yaml` entry, with no file and no tests — it stands in for a
// spec file the same way it stands in for one in `checkTests`'s coverage report. Domain
// comes from the criteria index, since a not-testable entry names only the id.
function notTestableRows(projectDir) {
  const byId = new Map((loadIndex(projectDir)?.criteria ?? []).map((c) => [c.id, c]));
  return readNotTestable(projectDir).map((entry) => ({
    id: entry.id,
    version: entry.version,
    domain: byId.get(entry.id)?.domain ?? null,
    file: null,
    result: "not-testable",
    tests: [],
  }));
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const da = a.domain ?? "", db = b.domain ?? "";
    if (da !== db) return da < db ? -1 : 1;
    const ia = a.id ?? "", ib = b.id ?? "";
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

function readMockRows(mockDir) {
  const p = join(mockDir, "calibrate.json");
  if (!existsSync(p)) throw new Error(`mock test runner: no canned response at ${p}`);
  const data = JSON.parse(readText(p));
  return Array.isArray(data.rows) ? data.rows : [];
}

// Runs the acceptance suite against `target` at `baseUrl` and maps the report to one row
// per criterion. `opts.exec` defaults to a real synchronous subprocess (`defaultExec`);
// a test passes a recording stand-in instead, so nothing here ever needs a real `npm`,
// `npx` or browser to be exercised. `runSuite` is itself synchronous, since `exec` is.
export function runSuite(opts) {
  const { projectDir, target, baseUrl, mailApi, env = {}, exec = defaultExec } = opts;

  // The stale set and the not-testable rows both come from the project's real files
  // regardless of whether the suite itself actually ran — under mock there is no run to
  // read them out of, so the mock only has to list what a real run would have produced.
  const staleIds = new Set(checkTests(projectDir).stale);

  if (process.env.SDLC_TEST_RUNNER === "mock") {
    const mockRows = readMockRows(process.env.SDLC_MOCK_DIR ?? "").map((r) =>
      staleIds.has(r.id) ? { ...r, result: "stale" } : r);
    return { rows: sortRows([...mockRows, ...notTestableRows(projectDir)]), raw: null, ok: true };
  }

  ensureDeps(projectDir, exec);
  ensureBrowsers(projectDir, exec);

  const testsDir = join(projectDir, "tests");
  const runEnv = {
    SDLC_TARGET: target,
    SDLC_TARGET_URL: baseUrl,
    SDLC_MAIL_API: mailApi,
    ...env,
    // Resolved by Playwright relative to `cwd` below, landing the report at
    // `tests/test-results/results.json` under `projectDir` either way.
    PLAYWRIGHT_JSON_OUTPUT_NAME: "test-results/results.json",
  };
  const run = exec("npx", ["--prefix", "tests", "playwright", "test", "--reporter=json"], { cwd: testsDir, env: runEnv });

  const reportPath = join(testsDir, "test-results", "results.json");
  if (!existsSync(reportPath)) {
    throw new Error(`playwright produced no report at tests/test-results/results.json:\n${run.stderr}`);
  }
  const raw = JSON.parse(readText(reportPath));
  const rows = sortRows([...buildRows(raw, projectDir, staleIds), ...notTestableRows(projectDir)]);
  return { rows, raw, ok: true };
}

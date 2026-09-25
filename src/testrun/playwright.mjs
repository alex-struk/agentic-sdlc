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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readText } from "../lib/fsx.mjs";
import { checkTests, loadIndex, readHeader, readWholeNotTestable } from "../checks/tests.mjs";
import { compareIds } from "../spec/criteria.mjs";
import { testFingerprint } from "./results.mjs";

// A failing test's error message is how an unbound adapter member is told apart from a
// real defect: `bind-adapter` throws `Error("unbound: <page>.<member> — <reason>")` from
// the member itself (`src/stages/registry.mjs`). `m` (multiline) because Playwright's own
// error message sometimes carries a stack trace after the thrown message's first line.
//
// The `Error: ` prefix is not optional decoration: Playwright reports a thrown Error with
// its class name in front, so the thrown text never starts the line. Anchored without it,
// this matched nothing at all, and every unbound member was recorded as a failed criterion
// and put in front of the product owner as though the application were at fault — 76 of
// them in one run. Both spellings are accepted, since a member may also reject with a bare
// string.
const UNBOUND_RE = /^(?:Error: )?unbound: /m;

// The default `exec`: a real subprocess, run synchronously and never throwing — a
// non-zero exit is exactly as valid a result as zero for every step here (a `npm ci`
// failure surfaces through the missing `node_modules` it was supposed to produce; a
// `playwright test` failure surfaces through the report it wrote either way).
function defaultExec(cmd, args, { cwd, env = {} } = {}) {
  const res = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  // `spawnSync` never throws, but a command it couldn't even launch (no `npm` on PATH)
  // reports that through `res.error` instead of `res.stderr` — folded in here so a
  // missing-report failure downstream still names the real reason.
  const stderr = res.stderr || (res.error ? res.error.message : "");
  return { status: res.status, stdout: res.stdout ?? "", stderr };
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
    // The lockfile this produces is committed by the calling stage (`calibrate`), as part
    // of its own changed-paths commit — nothing here stages or commits it.
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
    const status = last.status ?? "skipped";
    // An `interrupted` result (the run was aborted mid-test — a worker crash, `Ctrl-C`)
    // carries no assertion error of its own, so a failing interrupted test would otherwise
    // report a blank `error`.
    const error = last.error?.message ?? (status === "interrupted" ? "interrupted" : undefined);
    return { title: spec.title, status, error };
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

    // A spec whose every result is `skipped` (or that recorded no result at all) never ran
    // the criterion's assertions, so it has not passed — reported as a failure rather than
    // silently defaulting to `pass` for lack of any failing entry to point at.
    const neverRan = tests.length === 0 || tests.every((t) => t.status === "skipped");
    const failing = tests.filter((t) => t.status === "failed" || t.status === "timedOut" || t.status === "interrupted");
    let result, rowError;
    if (neverRan) {
      result = "fail";
      rowError = "no result recorded";
    } else if (failing.length === 0) {
      result = "pass";
    } else if (failing.every((t) => t.error && UNBOUND_RE.test(t.error))) {
      result = "unbound";
    } else {
      result = "fail";
    }
    if (staleIds.has(header.id)) result = "stale";

    const row = { id: header.id, version: header.version, domain, file: relFile, result, tests };
    if (rowError) row.error = rowError;
    rows.push(row);
  }
  return rows;
}

// One row per `not-testable.yaml` entry, with no file and no tests — it stands in for a
// spec file the same way it stands in for one in `checkTests`'s coverage report. Domain
// comes from the criteria index, since a not-testable entry names only the id.
// The domain a spec belongs to is the folder above it, which is how `buildRows` reads it
// off a report and how `checkTests` requires them to be laid out.
function domainOfSpec(relFile) {
  return basename(dirname(relFile));
}

// Every spec on disk, as project-relative paths, optionally narrowed to one domain. Used
// only where there is no run to read a file list out of.
function listSpecFiles(projectDir, domain) {
  const acceptanceDir = join(projectDir, "tests", "acceptance");
  if (!existsSync(acceptanceDir)) return [];
  const out = [];
  for (const entry of readdirSync(acceptanceDir)) {
    if (domain !== undefined && entry !== domain) continue;
    const abs = join(acceptanceDir, entry);
    if (!statSync(abs).isDirectory()) continue;
    for (const filename of readdirSync(abs)) {
      if (statSync(join(abs, filename)).isDirectory()) continue;
      out.push(`tests/acceptance/${entry}/${filename}`);
    }
  }
  return out;
}

function notTestableRows(projectDir, domain) {
  const byId = new Map((loadIndex(projectDir)?.criteria ?? []).map((c) => [c.id, c]));
  const wanted = (entry) => domain === undefined || byId.get(entry.id)?.domain === domain;
  return readWholeNotTestable(projectDir).filter(wanted).map((entry) => ({
    id: entry.id,
    version: entry.version,
    domain: byId.get(entry.id)?.domain ?? null,
    file: null,
    result: "not-testable",
    // The entry's own reason, carried onto the row. `not-testable.yaml` is the only place
    // it is written down, and a reader of the result file — a verdict, a terminal line, a
    // ruling prompt — has no other way to know why the application was never asked.
    ...(entry.reason ? { reason: String(entry.reason).trim() } : {}),
    tests: [],
  }));
}

// Sorted by domain, then numerically within it via the criteria module's own id compare
// (`R-1.10` after `R-1.2`, not before it as a lexical sort would place it).
export function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const da = a.domain ?? "", db = b.domain ?? "";
    if (da !== db) return da < db ? -1 : 1;
    return compareIds(a.id ?? "", b.id ?? "");
  });
}

// The canned answer a mock run gives, from `SDLC_MOCK_DIR/calibrate.json`: `rows` is the
// row list a real run would have produced. `throw` is the other thing a real run can do —
// no browser, no npm registry, the target gone mid-suite — expressed as
// `{ "throw": "<message>" }`, so a caller can be tested for what it leaves behind when
// the suite produces no rows at all.
function readMockRows(mockDir) {
  const p = join(mockDir, "calibrate.json");
  if (!existsSync(p)) throw new Error(`mock test runner: no canned response at ${p}`);
  const data = JSON.parse(readText(p));
  if (typeof data.throw === "string") throw new Error(data.throw);
  return Array.isArray(data.rows) ? data.rows : [];
}

// Each row that names a spec file carries the fingerprint of that file as it was when the suite
// ran (`file_sha`), so a result read later is known to be a result of that file and not of
// whatever the criterion's test has become since (`docs/decisions/0046`). A row whose file is
// gone has nothing to fingerprint.
function withFingerprint(projectDir, row) {
  if (!row?.file) return row;
  const abs = join(projectDir, row.file);
  return existsSync(abs) ? { ...row, file_sha: testFingerprint(readFileSync(abs)) } : row;
}

// Runs the acceptance suite against `target` at `baseUrl` and maps the report to one row
// per criterion. `opts.exec` defaults to a real synchronous subprocess (`defaultExec`);
// a test passes a recording stand-in instead, so nothing here ever needs a real `npm`,
// `npx` or browser to be exercised. `runSuite` is itself synchronous, since `exec` is.
export function runSuite(opts) {
  const out = suiteRows(opts);
  return { ...out, rows: out.rows.map((r) => withFingerprint(opts.projectDir, r)) };
}

function suiteRows(opts) {
  // `domain` narrows the run to one domain's specs. The whole suite takes hours on a real
  // project, which makes checking one fix a whole afternoon; scoped, it is minutes. The
  // caller is responsible for merging the rows it gets back over the rows it already had —
  // a scoped run reports on its domain and says nothing about any other.
  // `resetCommand` is what the harness runs before each test to put the target's data back
  // to the seed. Passed as an environment variable rather than written into the harness,
  // because how a target is reset is the runner's business and a suite run by hand against
  // a developer's own sandbox has no reset at all.
  // `instances` are the independent copies of the target the suite may spread across: each
  // has its own address, its own mail catcher and its own reset, so two tests running at
  // once never share data. One copy is the ordinary case and behaves exactly as before.
  const { projectDir, target, baseUrl, mailApi, domain, files, resetCommand, instances, env = {}, exec = defaultExec } = opts;
  const copies = instances?.length ? instances : [{ baseUrl, mailApi, resetCommand }];

  // The stale set and the not-testable rows both come from the project's real files
  // regardless of whether the suite itself actually ran — under mock there is no run to
  // read them out of, so the mock only has to list what a real run would have produced.
  const staleIds = new Set(checkTests(projectDir).stale);

  if (process.env.SDLC_TEST_RUNNER === "mock") {
    const mockRows = readMockRows(process.env.SDLC_MOCK_DIR ?? "").map((r) =>
      staleIds.has(r.id) ? { ...r, result: "stale" } : r);
    const wanted = files === undefined ? null : new Set(files);
    const byFile = wanted ? mockRows.filter((r) => wanted.has(r.file)) : mockRows;
    const scoped = domain === undefined ? byFile : byFile.filter((r) => r.domain === domain);
    return { rows: sortRows([...scoped, ...notTestableRows(projectDir, domain)]), raw: null, ok: true };
  }

  // An empty `files` is not the same as no `files` at all. `undefined` is "no filter":
  // run the whole suite, or the one domain `domain` names. `[]` is a caller that looked
  // for the specs it wanted and found none — a slice whose criteria are all not-testable,
  // or whose tests have not been derived yet. Handing that to Playwright as an empty
  // argument list would run the ENTIRE acceptance suite to answer a question about none
  // of it: the verdict still comes out right, because the rows it wanted are absent
  // either way, but it costs a full suite run and reports on work nobody asked about. So
  // nothing is run, and the only rows are the ones that never come from a run at all.
  if (files !== undefined && files.length === 0) {
    return { rows: sortRows(notTestableRows(projectDir, domain)), raw: null, ok: true };
  }

  // A target with no adapter at all is the unbound case at its largest, and the run
  // cannot say so for itself: every spec imports the adapter through the fixtures, so
  // with the module absent each one dies at import with a resolution error, which reads
  // to `classify` as an ordinary failure. Verify then returns the slice to the builder
  // with a condition per criterion, blaming it for a test harness that was never written
  // — and each such return counts toward the ceiling that escalates the slice.
  //
  // Checked here rather than matched in the error text, which would turn a message format
  // into a contract, and answered without a run: a browser started to discover that
  // nothing can be driven is a browser started for nothing.
  const adapterEntry = join(projectDir, "tests", "adapters", target, "index.ts");
  if (!existsSync(adapterEntry)) {
    const reason = `unbound: tests/adapters/${target}/index.ts does not exist, so nothing on ${target} can be driven yet`;
    const specs = (files ?? listSpecFiles(projectDir, domain)).map((relFile) => {
      const header = readHeader(join(projectDir, relFile), relFile);
      return {
        id: header.id, version: header.version,
        domain: domainOfSpec(relFile), file: relFile,
        result: header.error ? "fail" : "unbound",
        tests: [{ title: header.error ?? reason, status: "failed", error: header.error ?? `Error: ${reason}` }],
        ...(header.error ? { error: header.error } : {}),
      };
    });
    return { rows: sortRows([...specs, ...notTestableRows(projectDir, domain)]), raw: null, ok: true };
  }

  ensureDeps(projectDir, exec);
  ensureBrowsers(projectDir, exec);

  const testsDir = join(projectDir, "tests");
  const runEnv = {
    SDLC_TARGET: target,
    // The first copy's values keep the names everything already reads, so an adapter, a
    // fixture or a person running one test by hand needs to know nothing about copies.
    SDLC_TARGET_URL: copies[0].baseUrl ?? baseUrl,
    SDLC_MAIL_API: copies[0].mailApi ?? mailApi,
    ...(copies[0].resetCommand ? { SDLC_RESET_COMMAND: copies[0].resetCommand } : {}),
    // One numbered set per copy, which the harness picks from by worker index.
    ...Object.fromEntries(copies.flatMap((c, i) => [
      [`SDLC_TARGET_URL_${i}`, c.baseUrl ?? ""],
      [`SDLC_MAIL_API_${i}`, c.mailApi ?? ""],
      ...(c.resetCommand ? [[`SDLC_RESET_COMMAND_${i}`, c.resetCommand]] : []),
    ])),
    SDLC_WORKERS: String(copies.length),
    ...env,
    // An absolute path, so where the report lands never depends on which directory
    // Playwright resolves a relative name against — and it is the same path
    // `reportPath` below reads back, named once here and derived from `projectDir` in
    // both places.
    PLAYWRIGHT_JSON_OUTPUT_FILE: join(testsDir, "test-results", "results.json"),
  };
  // `cwd: projectDir` matches `ensureDeps`/`ensureBrowsers` above, so `--prefix tests`
  // means the same thing in all three calls (npm/npx resolve a relative `--prefix`
  // against `cwd`; pairing it with `cwd: testsDir` here would have pointed it at a
  // nonexistent `tests/tests`). Because the process itself then starts in `projectDir`,
  // not `tests/`, Playwright would otherwise fail to find `tests/playwright.config.ts` (it
  // only looks in its own `cwd`, never a parent) and silently fall back to an unconfigured
  // default run — `--config` points it at the real config explicitly.
  // `files` names the exact specs to run — the criteria one slice claims — and wins over
  // `domain`: a slice's criteria cross domains, and running a whole domain to verify three
  // of its criteria would report on work nobody claimed.
  const filter = files !== undefined ? files.map((f) => f.replace(/^tests\//, ""))
    : domain === undefined ? [] : [`acceptance/${domain}/`];
  const run = exec(
    "npx",
    ["--prefix", "tests", "playwright", "test", "--reporter=json", "--config=tests/playwright.config.ts", ...filter],
    { cwd: projectDir, env: runEnv },
  );

  const reportPath = join(testsDir, "test-results", "results.json");
  if (!existsSync(reportPath)) {
    throw new Error(`playwright produced no report at tests/test-results/results.json:\n${run.stderr}`);
  }
  const raw = JSON.parse(readText(reportPath));
  const rows = sortRows([...buildRows(raw, projectDir, staleIds), ...notTestableRows(projectDir, domain)]);
  return { rows, raw, ok: true };
}

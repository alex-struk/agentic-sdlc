import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { writeText } from "../src/lib/fsx.mjs";
import { runSuite } from "../src/testrun/playwright.mjs";

// Every target these tests run against has an adapter on disk. A target with none is a
// case of its own, exercised below: `runSuite` answers it without a run, because with the
// module absent every spec dies at import and the run can say nothing useful.
function project(targets = ["old", "new"]) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-testrun-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  for (const t of targets) {
    mkdirSync(join(d, "tests", "adapters", t), { recursive: true });
    writeFileSync(join(d, "tests", "adapters", t, "index.ts"), "export const surface = {};\n");
  }
  return d;
}

function write(dir, relPath, text) {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
}

function writeIndex(dir, criteria) {
  write(dir, "spec/criteria-index.json", `${JSON.stringify({ generated_from: "0000000", criteria }, null, 2)}\n`);
}

function specHeader(id, version, provenance = "blind", sha = "a1b2c3d", date = "2026-09-07") {
  return `// criterion: @${id} v${version}\n// provenance: ${provenance}, spec@${sha}, derived ${date}\n`;
}

function accepted(id, domain = "opportunities", version = 1) {
  return { id, version, confidence: "confirmed", origin: "authored", statement: "x",
    state: "accepted", tier: "STANDARD", domain, file: `spec/domains/${domain}.md` };
}

// One suite per spec file, each holding one spec whose last result is `status`. `file`
// carries only the domain and filename segments a real report's path would end in —
// `runSuite` reads the rest (which domain folder, which spec file) off those, the same
// way it would from a path relative to any of `playwright.config.ts`'s possible roots.
function fileSuite(domain, filename, specTitle, status, errorMessage) {
  const file = `${domain}/${filename}`;
  const result = errorMessage ? { status, error: { message: errorMessage } } : { status };
  return { title: filename, file, specs: [{ title: specTitle, file, line: 5, tests: [{ results: [result] }] }] };
}

// A no-op recording `exec`: every call is appended to `calls` and answered with a clean
// exit, so a test can assert on exactly which commands `runSuite` would have run without
// any of them actually running.
function recordingExec(calls, overrides = {}) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
    const key = args.join(" ");
    return overrides[key] ?? { status: 0, stdout: "", stderr: "" };
  };
}

function writeReport(dir, suites) {
  write(dir, "tests/test-results/results.json", JSON.stringify({ suites }));
}

// Points PLAYWRIGHT_BROWSERS_PATH at an empty (or chromium-holding) temp directory for
// the duration of one test, so `runSuite`'s browser-install step never depends on
// whatever the host machine happens to have cached.
function withBrowsersPath(hasChromium, fn) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-testrun-browsers-"));
  if (hasChromium) mkdirSync(join(dir, "chromium-1084"), { recursive: true });
  const prev = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = prev;
  }
}

// ---- mapping a hand-built report ----

test("runSuite: maps a pass, a fail and an unbound spec file to rows", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.1"), accepted("R-1.2"), accepted("R-1.3")]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1));
  write(d, "tests/acceptance/opportunities/R-1.2.spec.ts", specHeader("R-1.2", 1));
  write(d, "tests/acceptance/opportunities/R-1.3.spec.ts", specHeader("R-1.3", 1));
  writeReport(d, [
    fileSuite("opportunities", "R-1.1.spec.ts", "views a listing", "passed"),
    fileSuite("opportunities", "R-1.2.spec.ts", "submits a form", "failed", "expected true to be false"),
    fileSuite("opportunities", "R-1.3.spec.ts", "applies as a vendor", "failed", "unbound: opportunity.apply — no control found for this action"),
  ]);

  const calls = [];
  const result = withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail", exec: recordingExec(calls) }));

  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 3);
  const byId = Object.fromEntries(result.rows.map((r) => [r.id, r]));
  assert.equal(byId["R-1.1"].result, "pass");
  assert.equal(byId["R-1.1"].domain, "opportunities");
  assert.equal(byId["R-1.1"].version, 1);
  assert.equal(byId["R-1.2"].result, "fail");
  assert.equal(byId["R-1.2"].tests[0].error, "expected true to be false");
  assert.equal(byId["R-1.3"].result, "unbound");
  // sorted by domain then id
  assert.deepEqual(result.rows.map((r) => r.id), ["R-1.1", "R-1.2", "R-1.3"]);
});

// Playwright reports a thrown Error with its class name in front, so the adapter's own
// text never starts the line. Anchored without that prefix, the match failed for every real
// run: 76 unbound members in one calibration were recorded as failed criteria and put in
// front of the product owner as though the application were at fault.
test("runSuite: an unbound member is recognised through Playwright's Error prefix", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.4")]);
  write(d, "tests/acceptance/opportunities/R-1.4.spec.ts", specHeader("R-1.4", 1));
  writeReport(d, [
    fileSuite("opportunities", "R-1.4.spec.ts", "opens the panel", "failed",
      'Error: unbound: evaluation-panel-swu.add_panel_member — no control labelled "Add"'),
  ]);
  const result = withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "", exec: recordingExec([]) }));
  assert.equal(result.rows.find((r) => r.id === "R-1.4").result, "unbound");
});

test("runSuite: the playwright test call runs from projectDir with --prefix tests exactly once and the target env", () => {
  const d = project();
  writeIndex(d, []);
  writeReport(d, []);

  const calls = [];
  withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail", env: { EXTRA: "1" }, exec: recordingExec(calls) }));

  const run = calls.find((c) => c.cmd === "npx" && c.args.includes("test"));
  assert.ok(run, `expected a playwright test call, got ${JSON.stringify(calls)}`);
  // cwd matches ensureDeps/ensureBrowsers, so a relative --prefix means the same thing in
  // every npm/npx call this module makes — pairing it with a `tests/` cwd instead would
  // resolve to a nonexistent `tests/tests`.
  assert.equal(run.cwd, d);
  const prefixIdx = run.args.indexOf("--prefix");
  assert.equal(run.args.filter((a) => a === "--prefix").length, 1);
  assert.equal(run.args[prefixIdx + 1], "tests");
  assert.equal(run.env.SDLC_TARGET, "old");
  assert.equal(run.env.SDLC_TARGET_URL, "http://x");
  assert.equal(run.env.SDLC_MAIL_API, "http://mail");
  assert.equal(run.env.EXTRA, "1");
  // The report path is absolute, so where it lands never depends on which directory
  // Playwright resolves a relative name against — and it is the path `runSuite` reads the
  // report back from.
  assert.equal(run.env.PLAYWRIGHT_JSON_OUTPUT_FILE, join(d, "tests", "test-results", "results.json"));
  assert.equal(run.env.PLAYWRIGHT_JSON_OUTPUT_NAME, undefined);
  assert.ok(run.args.includes("--config=tests/playwright.config.ts"));
});

test("runSuite: a file with one real failure alongside an unbound one is fail, not unbound", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.1")]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1));
  write(d, "tests/test-results/results.json", JSON.stringify({
    suites: [{
      title: "R-1.1.spec.ts", file: "opportunities/R-1.1.spec.ts",
      specs: [
        { title: "a", file: "opportunities/R-1.1.spec.ts", line: 1, tests: [{ results: [{ status: "failed", error: { message: "unbound: page.thing — missing" } }] }] },
        { title: "b", file: "opportunities/R-1.1.spec.ts", line: 2, tests: [{ results: [{ status: "failed", error: { message: "expected 200 got 500" } }] }] },
      ],
    }],
  }));

  const result = withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail", exec: recordingExec([]) }));
  assert.equal(result.rows[0].result, "fail");
});

test("runSuite: a spec whose last result is interrupted is fail, not pass", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.1")]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1));
  writeReport(d, [fileSuite("opportunities", "R-1.1.spec.ts", "applies as a vendor", "interrupted")]);

  const result = withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail", exec: recordingExec([]) }));
  assert.equal(result.rows[0].result, "fail");
  assert.equal(result.rows[0].tests[0].error, "interrupted", "an interrupted result with no error message of its own gets a fallback error text");
});

test("runSuite: a spec whose only result is skipped is fail with 'no result recorded', not pass", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.1")]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1));
  writeReport(d, [fileSuite("opportunities", "R-1.1.spec.ts", "views a listing", "skipped")]);

  const result = withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail", exec: recordingExec([]) }));
  assert.equal(result.rows[0].result, "fail");
  assert.equal(result.rows[0].error, "no result recorded");
});

test("runSuite: a spec with no recorded test entries at all is fail with 'no result recorded'", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.1")]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1));
  write(d, "tests/test-results/results.json", JSON.stringify({
    suites: [{
      title: "R-1.1.spec.ts", file: "opportunities/R-1.1.spec.ts",
      specs: [{ title: "a", file: "opportunities/R-1.1.spec.ts", line: 1, tests: [] }],
    }],
  }));

  const result = withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail", exec: recordingExec([]) }));
  assert.equal(result.rows[0].result, "fail");
  assert.equal(result.rows[0].error, "no result recorded");
});

test("runSuite: a spec file whose header does not parse is reported with id null and result fail, not dropped", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.1")]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", "import {} from \"x\";\n"); // no header at all
  writeReport(d, [fileSuite("opportunities", "R-1.1.spec.ts", "views a listing", "passed")]);

  const result = withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail", exec: recordingExec([]) }));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].id, null);
  assert.equal(result.rows[0].result, "fail");
  assert.match(result.rows[0].error, /expected "\/\/ criterion:/);
});

// ---- row order ----

test("runSuite: rows are sorted numerically within a domain, not lexically (R-1.2 before R-1.10)", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.10"), accepted("R-1.2")]);
  write(d, "tests/acceptance/opportunities/R-1.10.spec.ts", specHeader("R-1.10", 1));
  write(d, "tests/acceptance/opportunities/R-1.2.spec.ts", specHeader("R-1.2", 1));
  writeReport(d, [
    fileSuite("opportunities", "R-1.10.spec.ts", "views a listing", "passed"),
    fileSuite("opportunities", "R-1.2.spec.ts", "views a listing", "passed"),
  ]);

  const result = withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail", exec: recordingExec([]) }));
  assert.deepEqual(result.rows.map((r) => r.id), ["R-1.2", "R-1.10"]);
});

// ---- stale detection ----

test("runSuite: a spec file whose header version trails the index is reported stale, overriding a passing result", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.1", "opportunities", 2)]); // index bumped to v2
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1)); // header still v1
  writeReport(d, [fileSuite("opportunities", "R-1.1.spec.ts", "views a listing", "passed")]);

  const result = withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail", exec: recordingExec([]) }));
  assert.equal(result.rows[0].result, "stale");
  assert.equal(result.rows[0].version, 1, "version reported is the header's, not the index's");
});

// ---- not-testable ----

test("runSuite: not-testable.yaml entries are added as rows with no file and no tests", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.1"), accepted("R-1.2")]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1));
  write(d, "tests/acceptance/not-testable.yaml", 'criteria:\n  - { id: R-1.2, version: 1, reason: "no path through the surface" }\n');
  writeReport(d, [fileSuite("opportunities", "R-1.1.spec.ts", "views a listing", "passed")]);

  const result = withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail", exec: recordingExec([]) }));
  const byId = Object.fromEntries(result.rows.map((r) => [r.id, r]));
  assert.equal(byId["R-1.2"].result, "not-testable");
  assert.equal(byId["R-1.2"].file, null);
  assert.deepEqual(byId["R-1.2"].tests, []);
  assert.equal(byId["R-1.2"].domain, "opportunities");
});

// ---- dependency install decision ----

test("runSuite: npm ci is skipped when node_modules is present and at least as new as the lockfile", () => {
  const d = project();
  writeIndex(d, []);
  writeReport(d, []);
  write(d, "tests/package-lock.json", "{}");
  mkdirSync(join(d, "tests", "node_modules"), { recursive: true });
  write(d, "tests/node_modules/.package-lock.json", "{}");
  // Make the snapshot newer than the lockfile so staleness is unambiguous either way the
  // filesystem's mtime resolution rounds.
  const now = new Date();
  utimesSync(join(d, "tests/package-lock.json"), now, now);
  utimesSync(join(d, "tests/node_modules/.package-lock.json"), new Date(now.getTime() + 5000), new Date(now.getTime() + 5000));

  const calls = [];
  withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail", exec: recordingExec(calls) }));

  assert.ok(!calls.some((c) => c.cmd === "npm"), `expected no npm call, got ${JSON.stringify(calls)}`);
});

test("runSuite: npm ci runs when the lockfile is newer than node_modules' snapshot", () => {
  const d = project();
  writeIndex(d, []);
  writeReport(d, []);
  write(d, "tests/package-lock.json", "{}");
  mkdirSync(join(d, "tests", "node_modules"), { recursive: true });
  write(d, "tests/node_modules/.package-lock.json", "{}");
  const now = new Date();
  utimesSync(join(d, "tests/node_modules/.package-lock.json"), now, now);
  utimesSync(join(d, "tests/package-lock.json"), new Date(now.getTime() + 5000), new Date(now.getTime() + 5000));

  const calls = [];
  withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail", exec: recordingExec(calls) }));

  const ci = calls.find((c) => c.cmd === "npm" && c.args.includes("ci"));
  assert.ok(ci, `expected an npm ci call, got ${JSON.stringify(calls)}`);
  assert.deepEqual(ci.args, ["ci", "--prefix", "tests"]);
});

test("runSuite: npm install (not ci) runs when there is no lockfile yet", () => {
  const d = project();
  writeIndex(d, []);
  writeReport(d, []);

  const calls = [];
  withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail", exec: recordingExec(calls) }));

  const install = calls.find((c) => c.cmd === "npm");
  assert.ok(install, `expected an npm call, got ${JSON.stringify(calls)}`);
  assert.deepEqual(install.args, ["install", "--prefix", "tests"]);
});

// ---- missing report ----

test("runSuite: a run that produces no report throws, naming the runner's stderr", () => {
  const d = project();
  writeIndex(d, []);
  // No tests/test-results/results.json written at all — simulates a run that crashed
  // before the reporter could flush.
  const overrides = { "--prefix tests playwright test --reporter=json --config=tests/playwright.config.ts": { status: 1, stdout: "", stderr: "browserType.launch: executable doesn't exist" } };

  assert.throws(
    () => withBrowsersPath(true, () =>
      runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail", exec: recordingExec([], overrides) })),
    /browserType\.launch: executable doesn't exist/,
  );
});

// ---- mock runner ----

test("runSuite: SDLC_TEST_RUNNER=mock reads calibrate.json and still applies not-testable and stale rules", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.1", "opportunities", 2), accepted("R-1.2")]); // R-1.1 bumped: the spec header below is stale
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1));
  write(d, "tests/acceptance/not-testable.yaml", 'criteria:\n  - { id: R-1.2, version: 1, reason: "no path through the surface" }\n');

  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-testrun-mock-"));
  writeText(join(mockDir, "calibrate.json"), JSON.stringify({
    rows: [{ id: "R-1.1", version: 1, domain: "opportunities", file: "tests/acceptance/opportunities/R-1.1.spec.ts", result: "pass", tests: [{ title: "x", status: "passed" }] }],
  }));

  const prevRunner = process.env.SDLC_TEST_RUNNER, prevMockDir = process.env.SDLC_MOCK_DIR;
  process.env.SDLC_TEST_RUNNER = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const result = runSuite({ projectDir: d, target: "old", baseUrl: "http://x", mailApi: "http://mail" });
    assert.equal(result.ok, true);
    assert.equal(result.raw, null);
    const byId = Object.fromEntries(result.rows.map((r) => [r.id, r]));
    assert.equal(byId["R-1.1"].result, "stale", "the mock row's outcome is overridden by the stale rule");
    assert.equal(byId["R-1.2"].result, "not-testable");
  } finally {
    if (prevRunner === undefined) delete process.env.SDLC_TEST_RUNNER; else process.env.SDLC_TEST_RUNNER = prevRunner;
    if (prevMockDir === undefined) delete process.env.SDLC_MOCK_DIR; else process.env.SDLC_MOCK_DIR = prevMockDir;
  }
});

// A test that deactivates an account or grants administrator rights leaves it changed for
// every test after it. The runner tells the harness how to put the data back; how a target
// is reset is the runner's business, and a suite run by hand against a developer's own
// sandbox is given no command and resets nothing.
test("runSuite: the reset command reaches the harness in the environment, and only when there is one", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.1")]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1));
  writeReport(d, [fileSuite("opportunities", "R-1.1.spec.ts", "views a listing", "passed")]);

  const withReset = [];
  withBrowsersPath(true, () => runSuite({
    projectDir: d, target: "old", baseUrl: "http://x", mailApi: "",
    resetCommand: "node sdlc.mjs oracle reseed --target old",
    exec: recordingExec(withReset),
  }));
  const run = withReset.find((c) => c.args.includes("test"));
  assert.equal(run.env.SDLC_RESET_COMMAND, "node sdlc.mjs oracle reseed --target old");

  const without = [];
  withBrowsersPath(true, () => runSuite({
    projectDir: d, target: "old", baseUrl: "http://x", mailApi: "", exec: recordingExec(without),
  }));
  assert.equal(without.find((c) => c.args.includes("test")).env.SDLC_RESET_COMMAND, undefined);
});

// One worker per copy of the target: the numbered variables are what the harness picks from
// by worker index, and the unnumbered ones stay pointing at the first copy so an adapter, a
// fixture or a person running one test by hand needs to know nothing about copies.
test("runSuite: several copies become numbered addresses, numbered resets and a worker count", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.1")]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1));
  writeReport(d, [fileSuite("opportunities", "R-1.1.spec.ts", "views a listing", "passed")]);

  const calls = [];
  withBrowsersPath(true, () => runSuite({
    projectDir: d, target: "old", baseUrl: "http://unused", mailApi: "",
    instances: [
      { baseUrl: "http://localhost:3100", mailApi: "http://localhost:8025", resetCommand: "reseed 0" },
      { baseUrl: "http://localhost:3101", mailApi: "http://localhost:8026", resetCommand: "reseed 1" },
    ],
    exec: recordingExec(calls),
  }));
  const env = calls.find((c) => c.args.includes("test")).env;
  assert.equal(env.SDLC_WORKERS, "2");
  assert.equal(env.SDLC_TARGET_URL, "http://localhost:3100");
  assert.equal(env.SDLC_TARGET_URL_0, "http://localhost:3100");
  assert.equal(env.SDLC_TARGET_URL_1, "http://localhost:3101");
  assert.equal(env.SDLC_MAIL_API_1, "http://localhost:8026");
  assert.equal(env.SDLC_RESET_COMMAND_1, "reseed 1");
  assert.equal(env.SDLC_RESET_COMMAND, "reseed 0");
});

test("runSuite: one copy is one worker, named exactly as it always was", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.1")]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1));
  writeReport(d, [fileSuite("opportunities", "R-1.1.spec.ts", "views a listing", "passed")]);
  const calls = [];
  withBrowsersPath(true, () => runSuite({
    projectDir: d, target: "old", baseUrl: "http://localhost:3100", mailApi: "http://mail", exec: recordingExec(calls),
  }));
  const env = calls.find((c) => c.args.includes("test")).env;
  assert.equal(env.SDLC_WORKERS, "1");
  assert.equal(env.SDLC_TARGET_URL, "http://localhost:3100");
  assert.equal(env.SDLC_TARGET_URL_0, "http://localhost:3100");
});

// ---- an empty file list is not an empty filter ----

// `specFilesFor` (src/stages/slices.mjs) returns the spec files that exist for a slice's
// criteria, and legitimately returns none: a slice claiming only not-testable criteria has
// no spec file to run. Passed on to Playwright as an empty argument list, that would have
// run the whole acceptance suite — the right verdict at the cost of a full suite run
// reporting on work nobody claimed.
test("runSuite: an empty files list runs nothing at all, where no files list runs everything", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.1"), accepted("R-1.2")]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1));
  write(d, "tests/acceptance/not-testable.yaml", 'criteria:\n  - { id: R-1.2, version: 1, reason: "no path through the surface" }\n');
  writeReport(d, [fileSuite("opportunities", "R-1.1.spec.ts", "views a listing", "passed")]);

  const empty = [];
  const result = withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "new", baseUrl: "http://x", files: [], exec: recordingExec(empty) }));
  assert.ok(!empty.some((c) => c.args.includes("playwright")), "no suite run was started");
  // The rows that never come from a run at all are still reported: they are read off the
  // project's own files, and a slice claiming only those is verified by them.
  assert.deepEqual(result.rows.map((r) => r.id), ["R-1.2"]);
  assert.equal(result.rows[0].result, "not-testable");

  const all = [];
  withBrowsersPath(true, () =>
    runSuite({ projectDir: d, target: "new", baseUrl: "http://x", exec: recordingExec(all) }));
  const run = all.find((c) => c.args.includes("playwright"));
  assert.deepEqual(run.args.slice(run.args.indexOf("--config=tests/playwright.config.ts") + 1), [],
    "no files and no domain is the one no-filter case: the whole suite");
});

test("runSuite: the mock runner reads an empty files list the same way", () => {
  const d = project();
  writeIndex(d, [accepted("R-1.1"), accepted("R-1.2")]);
  write(d, "tests/acceptance/opportunities/R-1.1.spec.ts", specHeader("R-1.1", 1));
  write(d, "tests/acceptance/not-testable.yaml", 'criteria:\n  - { id: R-1.2, version: 1, reason: "no path through the surface" }\n');
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-testrun-mock-"));
  writeFileSync(join(mockDir, "calibrate.json"), JSON.stringify({
    rows: [{ id: "R-1.1", version: 1, domain: "opportunities", file: "tests/acceptance/opportunities/R-1.1.spec.ts", result: "pass", tests: [] }],
  }));
  process.env.SDLC_TEST_RUNNER = "mock"; process.env.SDLC_MOCK_DIR = mockDir;
  try {
    const scoped = runSuite({ projectDir: d, target: "new", baseUrl: "http://x", files: [] });
    assert.deepEqual(scoped.rows.map((r) => r.id), ["R-1.2"]);
    const everything = runSuite({ projectDir: d, target: "new", baseUrl: "http://x" });
    assert.deepEqual(everything.rows.map((r) => r.id), ["R-1.1", "R-1.2"]);
  } finally {
    delete process.env.SDLC_TEST_RUNNER; delete process.env.SDLC_MOCK_DIR;
  }
});

// Every acceptance spec reaches its target through the adapter, so a target with no
// adapter at all makes every spec die at import with a module-resolution error — which
// reads like an ordinary failure. Verify then returns the slice to the builder with a
// condition per criterion, blaming it for a harness nobody has written, and each such
// return counts toward the ceiling that escalates the slice.
test("runSuite: a target with no adapter is unbound for every spec, without a run", () => {
  const d = project([]);
  writeIndex(d, [accepted("R-7.1", "content"), accepted("R-7.2", "content")]);
  write(d, "tests/acceptance/content/R-7.1.spec.ts", specHeader("R-7.1", 1));
  write(d, "tests/acceptance/content/R-7.2.spec.ts", specHeader("R-7.2", 1));
  const calls = [];
  const exec = (cmd, args) => { calls.push(args); return { status: 0, stdout: "", stderr: "" }; };

  const { rows } = runSuite({ projectDir: d, target: "new", baseUrl: "http://x", exec });

  assert.deepEqual(rows.map((r) => [r.id, r.result]), [["R-7.1", "unbound"], ["R-7.2", "unbound"]]);
  assert.match(rows[0].tests[0].error, /^Error: unbound: tests\/adapters\/new\/index\.ts does not exist/);
  assert.equal(calls.length, 0, "a browser started to discover nothing can be driven is a browser started for nothing");
});

// The guard is about the adapter being absent, not about any run being unwelcome: a
// target that has one is run exactly as before.
test("runSuite: a target that has an adapter is still run", () => {
  const d = project(["new"]);
  writeIndex(d, [accepted("R-7.1", "content")]);
  write(d, "tests/acceptance/content/R-7.1.spec.ts", specHeader("R-7.1", 1));
  write(d, "tests/test-results/results.json", '{"suites":[]}');
  const calls = [];
  const exec = (cmd, args) => { calls.push(args); return { status: 0, stdout: '{"suites":[]}', stderr: "" }; };
  runSuite({ projectDir: d, target: "new", baseUrl: "http://x", exec });
  assert.ok(calls.some((a) => a.includes("playwright")), "the suite runs when there is something to drive");
});

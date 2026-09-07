import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { writeText } from "../src/lib/fsx.mjs";
import { runSuite } from "../src/testrun/playwright.mjs";

function project() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-testrun-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
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

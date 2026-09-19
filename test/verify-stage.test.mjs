import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSuite } from "../src/testrun/playwright.mjs";

test("a suite run given spec files runs exactly those", (t) => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-files-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  mkdirSync(join(d, "tests", "acceptance", "users"), { recursive: true });
  const calls = [];
  const exec = (cmd, args) => { calls.push(args); return { status: 0, stdout: '{"suites":[]}', stderr: "" }; };
  runSuite({ projectDir: d, target: "new", baseUrl: "http://x", files: ["tests/acceptance/users/R-4.1.spec.ts"], exec });
  const run = calls.find((a) => a.includes("playwright"));
  assert.ok(run.includes("acceptance/users/R-4.1.spec.ts"));
  assert.ok(!run.some((a) => a === "acceptance/users/"));
});

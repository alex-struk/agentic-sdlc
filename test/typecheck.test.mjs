import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptanceTypecheck, formatTypecheckEvidence } from "../src/runner/typecheck.mjs";

const CONTEXT = { name: "derive-tests-applications", gate: "G3", revision: "abc123" };

function fixture(t, { compiler, scripts = { typecheck: "tsc --noEmit" } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-typecheck-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tests = join(dir, "tests");
  mkdirSync(tests);
  writeFileSync(join(tests, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(tests, "tsconfig.json"), "{}");
  if (compiler !== undefined) {
    const bin = join(tests, "node_modules", "typescript", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "tsc"), compiler);
  }
  return dir;
}

test("typecheck evidence is limited to G3 test and adapter proposals", async (t) => {
  const dir = fixture(t);
  assert.equal(await acceptanceTypecheck(dir, { ...CONTEXT, gate: "G1" }), null);
  assert.equal(await acceptanceTypecheck(dir, { ...CONTEXT, name: "policy-v1" }), null);
  assert.equal((await acceptanceTypecheck(dir, { ...CONTEXT, name: "bind-adapter-old" })).status, "unavailable");
});

test("typecheck reports missing dependencies without claiming success or installing", async (t) => {
  const result = await acceptanceTypecheck(fixture(t), CONTEXT);
  assert.equal(result.status, "unavailable");
  assert.equal(result.exitCode, null);
  assert.match(result.output, /Restore the harness dependencies/);
  assert.match(formatTypecheckEvidence(result), /Typecheck: \*\*unavailable\*\*/);
});

test("typecheck does not execute arbitrary scripts or lifecycle hooks", async (t) => {
  for (const scripts of [{ typecheck: "node custom.js" }, { typecheck: "tsc --noEmit", pretypecheck: "node hook.js" }]) {
    const result = await acceptanceTypecheck(fixture(t, { scripts, compiler: "process.exit(99);" }), CONTEXT);
    assert.equal(result.status, "unavailable");
    assert.match(result.output, /supported tsc --noEmit script/);
  }
});

test("typecheck invokes the installed compiler read-only and captures success", async (t) => {
  const dir = fixture(t, { compiler: "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));" });
  const result = await acceptanceTypecheck(dir, CONTEXT);
  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.output), {
    cwd: join(dir, "tests"),
    args: ["--noEmit", "--incremental", "false", "--pretty", "false"],
  });
  assert.match(formatTypecheckEvidence(result), /Proposal revision: `abc123`/);
});

test("typecheck preserves failing compiler diagnostics and exit status", async (t) => {
  const dir = fixture(t, { compiler: "console.log('acceptance/applications/R-1.1.spec.ts: error TS2339'); process.exitCode=2;" });
  const result = await acceptanceTypecheck(dir, CONTEXT);
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /error TS2339/);
  assert.match(formatTypecheckEvidence(result), /Typecheck: \*\*failed\*\*/);
});

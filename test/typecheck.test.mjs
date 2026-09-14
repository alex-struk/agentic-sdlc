import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptanceTypecheck, formatTypecheckEvidence, ownedDirectory, splitDiagnostics } from "../src/runner/typecheck.mjs";

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

test("a proposal owns one directory, whatever revision suffix its name carries", () => {
  assert.equal(ownedDirectory("bind-adapter-old"), "adapters/old/");
  assert.equal(ownedDirectory("bind-adapter-old-3"), "adapters/old/");
  assert.equal(ownedDirectory("derive-tests-evaluation"), "acceptance/evaluation/");
  assert.equal(ownedDirectory("derive-tests-evaluation-6"), "acceptance/evaluation/");
  assert.equal(ownedDirectory("derive-tests-users-stale-2"), "acceptance/users/");
  assert.equal(ownedDirectory("policy-v1"), null);
});

test("diagnostics outside the proposal's own directory are counted, not listed", () => {
  const output = [
    "adapters/old/index.ts(2867,52): error TS2551: Property 'programme' does not exist.",
    "acceptance/users/R-4.8.spec.ts(17,42): error TS2353: unknown property.",
    "acceptance/users/R-4.9.spec.ts(17,42): error TS2353: unknown property.",
    "acceptance/files/R-8.1.spec.ts(17,42): error TS2353: unknown property.",
  ].join("\n");
  const { mine, elsewhere } = splitDiagnostics(output, "adapters/old/");
  assert.deepEqual(mine, ["adapters/old/index.ts(2867,52): error TS2551: Property 'programme' does not exist."]);
  assert.deepEqual([...elsewhere.entries()], [["acceptance/users/", 2], ["acceptance/files/", 1]]);
});

// The defect this guards: 231 diagnostics, of which the two belonging to the adapter
// being ruled fell past an 18,000-character cut, so the reviewer could not confirm
// whether the adapter compiled at all.
test("a proposal's own diagnostics survive a suite whose other directories are enormous", () => {
  const noise = Array.from({ length: 400 },
    (_, i) => `acceptance/users/R-4.${i}.spec.ts(1,1): error TS2353: ${"x".repeat(200)}`);
  const result = {
    revision: "abc123", status: "failed", exitCode: 2, command: "tsc", directory: "tests",
    owned: "adapters/old/",
    output: [...noise, "adapters/old/index.ts(2868,62): error TS2339: Property 'id' does not exist."].join("\n"),
  };
  const evidence = formatTypecheckEvidence(result);
  assert.match(evidence, /adapters\/old\/index\.ts\(2868,62\)/);
  assert.doesNotMatch(evidence, /\[diagnostics truncated\]/);
  assert.match(evidence, /acceptance\/users\/: 400 diagnostics/);
});

test("a proposal that owns no directory keeps the whole diagnostic list", () => {
  const output = "acceptance/users/R-4.8.spec.ts(1,1): error TS2353: unknown property.";
  const { mine, elsewhere } = splitDiagnostics(output, null);
  assert.deepEqual(mine, [output]);
  assert.equal(elsewhere.size, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatChecks } from "../src/commands/checks.mjs";
import { toolReport } from "../src/commands/doctor.mjs";
import { COMMANDS } from "../src/cli.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Captures everything `sdlc doctor` prints for one run in `dir`.
async function doctorLines(dir) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try { await COMMANDS.doctor({ pos: [dir], flags: {} }); }
  finally { console.log = orig; }
  return lines;
}

test("formatChecks renders ok and failures", () => {
  const out = formatChecks([{ id: "config", ok: true, messages: [] }, { id: "egress", ok: false, messages: ["a.md:3: listed name"] }]);
  assert.match(out, /^ok\s+config$/m);
  assert.match(out, /^FAIL\s+egress$/m);
  assert.match(out, /^\s+a\.md:3: listed name$/m);
});

test("toolReport finds node and git and tolerates a missing tool", () => {
  const r = toolReport(["node", "git", "definitely-not-a-tool"]);
  assert.equal(r.find((t) => t.name === "node").found, true);
  assert.equal(r.find((t) => t.name === "definitely-not-a-tool").found, false);
});

test("doctor reports whether the sandbox sign-in password is set, and never what it is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-doctor-"));
  const prev = process.env.SDLC_SANDBOX_PASSWORD;
  try {
    delete process.env.SDLC_SANDBOX_PASSWORD;
    const without = await doctorLines(dir);
    assert.ok(without.some((l) => l === "warn SDLC_SANDBOX_PASSWORD not set (needed only for a sandbox-idp target)"), without.join("\n"));

    process.env.SDLC_SANDBOX_PASSWORD = "a-value-doctor-must-not-print";
    const withIt = await doctorLines(dir);
    assert.ok(withIt.some((l) => l === "ok   SDLC_SANDBOX_PASSWORD set"), withIt.join("\n"));
    assert.ok(!withIt.join("\n").includes("a-value-doctor-must-not-print"), "the value itself is never printed");
  } finally {
    if (prev === undefined) delete process.env.SDLC_SANDBOX_PASSWORD;
    else process.env.SDLC_SANDBOX_PASSWORD = prev;
  }
});

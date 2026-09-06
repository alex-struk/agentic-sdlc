import { test } from "node:test";
import assert from "node:assert/strict";
import { formatChecks } from "../src/commands/checks.mjs";
import { toolReport } from "../src/commands/doctor.mjs";

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

const assert = require("node:assert");
const { test } = require("node:test");
const router = require("../src/routes");

// A private test of the old application's own internals. Archaeology must never read
// this file: exercising it here is what proves the exclusion actually removed it from
// sources/old before an agent turn ever starts.
test("router is exported", () => {
  assert.ok(router);
});

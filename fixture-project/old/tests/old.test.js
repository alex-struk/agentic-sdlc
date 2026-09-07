const assert = require("node:assert");
const { test } = require("node:test");
const router = require("../src/routes");

// A private test of the old application's own internals, present only so archaeology's
// own tests can assert it is gone from sources/old (excluded by config) before an agent
// turn ever starts. It is not run as part of this pipeline's own suite.
test("router is exported", () => {
  assert.ok(router);
});

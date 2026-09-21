import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/lib/args.mjs";

test("positionals and flags", () => {
  const r = parseArgs(["new", "../proj", "--from", "c.yaml", "--quiet"]);
  assert.deepEqual(r.pos, ["new", "../proj"]);
  assert.deepEqual(r.flags, { from: "c.yaml", quiet: true });
});

test("flag followed by flag is boolean", () => {
  const r = parseArgs(["checks", "--self", "--json"]);
  assert.deepEqual(r.flags, { self: true, json: true });
});

// A flag repeated is a list, which is what lets one invocation carry several conditions
// without a separator a condition's own text could contain.
test("a flag given more than once keeps every value, in order", () => {
  const r = parseArgs(["rule", "build-slice-1", "return", "--by", "tech-lead",
    "--condition", "test-overreaches R-1.2: it reads a log the criterion never mentions",
    "--condition", "R-1.3 still fails against the application"]);
  assert.deepEqual(r.pos, ["rule", "build-slice-1", "return"]);
  assert.equal(r.flags.by, "tech-lead");
  assert.deepEqual(r.flags.condition, [
    "test-overreaches R-1.2: it reads a log the criterion never mentions",
    "R-1.3 still fails against the application",
  ]);
});

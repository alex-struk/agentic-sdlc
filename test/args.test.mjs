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

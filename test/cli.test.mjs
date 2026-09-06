import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.mjs";

test("unknown command returns 2", async () => {
  const code = await main(["nope"]);
  assert.equal(code, 2);
});

test("help returns 0", async () => {
  assert.equal(await main(["help"]), 0);
  assert.equal(await main([]), 0);
});

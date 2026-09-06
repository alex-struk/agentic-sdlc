import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, COMMANDS } from "../src/cli.mjs";

test("unknown command returns 2", async () => {
  const code = await main(["nope"]);
  assert.equal(code, 2);
});

test("help returns 0", async () => {
  assert.equal(await main(["help"]), 0);
  assert.equal(await main([]), 0);
});

test("init on a directory with no .sdlc returns 1 rather than throwing", async () => {
  // Exercises CLI dispatch through main() rather than calling init() directly, so a
  // regression in command registration (e.g. the TDZ circular-import bug the deviation
  // fixed) shows up here instead of only in tests that import the command module directly.
  const dir = mkdtempSync(join(tmpdir(), "sdlc-cli-init-"));
  const code = await main(["init", dir]);
  assert.equal(code, 1);
});

test("after main(['help']), new and init are registered as functions", async () => {
  await main(["help"]);
  assert.equal(typeof COMMANDS.new, "function");
  assert.equal(typeof COMMANDS.init, "function");
});

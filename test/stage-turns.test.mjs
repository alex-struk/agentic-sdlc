import { test } from "node:test";
import assert from "node:assert/strict";
import { stageFor } from "../src/stages/registry.mjs";
import { turnsFor, DEFAULT_MAX_TURNS } from "../src/runner/executor.mjs";

// A design run of a fourteen-page domain took 97 turns; one of seventeen pages stopped at
// the default ceiling of 40 having written nothing it could hand over.
test("design and plan carry their own turn ceilings, above the session default", () => {
  for (const name of ["design", "plan"]) {
    const turns = stageFor(name).defaultTurns;
    assert.ok(turns > DEFAULT_MAX_TURNS, `${name} has ${turns}`);
    assert.equal(turnsFor({ policy: { budgets: {} } }, name, turns), turns);
  }
});

test("a project's own budget for the stage still wins over the stage's default", () => {
  assert.equal(turnsFor({ policy: { budgets: { design: 90 } } }, "design", stageFor("design").defaultTurns), 90);
});

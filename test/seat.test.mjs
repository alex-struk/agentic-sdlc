import { test } from "node:test";
import assert from "node:assert/strict";
import { SEAT_AGENT, SEAT_HUMAN, SEAT_RUNNER, SEAT_UNKNOWN, heldByFor, seatKind, seatLabel } from "../src/lib/seat.mjs";

test("the three seats a gate file can record map to themselves", () => {
  assert.equal(seatKind("agent"), SEAT_AGENT);
  assert.equal(seatKind("runner"), SEAT_RUNNER);
  assert.equal(seatKind("human"), SEAT_HUMAN);
});

// The defect this module exists for: every reader asked `held_by === "agent"` and read the
// false branch as a person, so anything the mapping did not know became a human sign-off.
test("a seat value the mapping does not know is unknown, never a person", () => {
  for (const value of ["runner:verify", "Agent", "AGENT", "bot", "tech-lead", "agent ", " human", "true", ""]) {
    assert.equal(seatKind(value), SEAT_UNKNOWN, `${JSON.stringify(value)} should not place as a known seat`);
    assert.notEqual(seatLabel(value), "a person", `${JSON.stringify(value)} should not be labelled as a person`);
  }
});

// A gate file missing the field entirely, and one holding something that is not a string
// at all, are both cases the site reads off disk and neither is a person.
test("a missing or non-string seat is unknown and says the file records none", () => {
  for (const value of [undefined, null, {}, [], 0, false]) {
    assert.equal(seatKind(value), SEAT_UNKNOWN);
  }
  assert.equal(seatLabel(undefined), "unknown seat (the gate file records none)");
  assert.equal(seatLabel(""), "unknown seat (the gate file records none)");
});

test("each seat has its own label and the runner's says nothing was held", () => {
  assert.equal(seatLabel("agent"), "persona agent");
  assert.equal(seatLabel("human"), "a person");
  assert.equal(seatLabel("runner"), "the runner, automatically");
});

// The label goes into a Markdown table cell, which ends at the first `|`, and into inline
// HTML. An unrecognised value comes off a file that can hold anything, so it is quoted
// back without the delimiters that would break the row it sits in.
test("an unknown seat is quoted back without breaking the cell it is rendered into", () => {
  const label = seatLabel("weird | value `with` *markup*");
  assert.match(label, /^unknown seat \(/);
  assert.ok(!label.includes("|"), "a Markdown cell ends at a pipe");
  assert.ok(!label.includes("`") && !label.includes("*"), "inline markup should not reopen");
  assert.ok(seatLabel("x".repeat(200)).length < 80, "a long value is cut rather than reproduced");
  assert.equal(seatLabel("one\ntwo"), "unknown seat (one two)");
});

// The write side of the same mapping. A person rules by naming the role they sit in; the
// two prefixes name what produced the ruling instead.
test("a seat is derived from who ruled, and only a bare role is a person", () => {
  assert.equal(heldByFor("agent:reviewer"), SEAT_AGENT);
  assert.equal(heldByFor("runner:verify"), SEAT_RUNNER);
  assert.equal(heldByFor("tech-lead"), SEAT_HUMAN);
});

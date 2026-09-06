import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJournal, readJournal } from "../src/runner/journal.mjs";

test("writeJournal numbers entries 001, 002 and writes front matter", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-journal-"));
  const p1 = writeJournal(d, {
    stage: "probe",
    title: "first run",
    body: "did the thing.",
    metrics: { cost: 0.12, turns: 3, session: "abc" },
  });
  assert.equal(p1, join(d, ".sdlc", "journal", "001-probe.md"));
  const text1 = readFileSync(p1, "utf8");
  assert.match(text1, /^---\n/);
  assert.match(text1, /stage: "probe"/);
  assert.match(text1, /title: "first run"/);
  assert.match(text1, /at: "20\d{2}-\d{2}-\d{2}T/);
  assert.match(text1, /cost: 0.12/);
  assert.match(text1, /turns: 3/);
  assert.match(text1, /session: "abc"/);
  assert.match(text1, /---\n\ndid the thing\.$/);

  const p2 = writeJournal(d, { stage: "probe", title: "second run", body: "did it again." });
  assert.equal(p2, join(d, ".sdlc", "journal", "002-probe.md"));
  const text2 = readFileSync(p2, "utf8");
  assert.match(text2, /cost: 0\n/);
  assert.match(text2, /turns: 0\n/);
  assert.match(text2, /session: ""/);
});

test("writeJournal numbers a different stage after an existing one", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-journal-"));
  writeJournal(d, { stage: "probe", title: "one", body: "x." });
  const p2 = writeJournal(d, { stage: "build", title: "two", body: "y." });
  assert.equal(p2, join(d, ".sdlc", "journal", "002-build.md"));
});

test("readJournal returns entries in file order with parsed fields", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-journal-"));
  writeJournal(d, { stage: "probe", title: "first", body: "one.", metrics: { cost: 0.5, turns: 2, session: "s1" } });
  writeJournal(d, { stage: "probe", title: "second", body: "two." });
  const entries = readJournal(d);
  assert.equal(entries.length, 2);

  assert.equal(entries[0].file, "001-probe.md");
  assert.equal(entries[0].stage, "probe");
  assert.equal(entries[0].title, "first");
  assert.equal(entries[0].cost, 0.5);
  assert.equal(entries[0].turns, 2);
  assert.equal(entries[0].session, "s1");
  assert.equal(entries[0].body, "one.");
  assert.match(entries[0].at, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(entries[1].file, "002-probe.md");
  assert.equal(entries[1].title, "second");
  assert.equal(entries[1].cost, 0);
  assert.equal(entries[1].turns, 0);
  assert.equal(entries[1].session, "");
  assert.equal(entries[1].body, "two.");
});

test("readJournal on a project with no journal yet returns an empty array", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-journal-"));
  assert.deepEqual(readJournal(d), []);
});

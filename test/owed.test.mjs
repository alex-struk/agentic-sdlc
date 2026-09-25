// Owed work is one mechanism: every kind is read into one entry shape, listed for the stage
// that owes it or the line of work it belongs to, closed on evidence or withdrawn with a
// reason, and counted by how many times it has been sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  OWED_PATH, owedPath, read, readAt, open, close, settle, isOpen, openFor, openForFamily, sends, entriesIn, withdrawRetired,
} from "../src/spec/owed.mjs";

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-owed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(dir, rel, doc) {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), stringifyYaml(doc));
}

const LEGACY = {
  ".sdlc/conditions.yaml": { conditions: [{ ref: "build-slice-1#1", text: "say what the session showed", from: "build-slice-1", family: "build-slice-1", gate: "G3", stage: "build", by: "agent:reviewer", at: "2026-01-01T00:00:00.000Z" }] },
  ".sdlc/revision-requests.yaml": { requests: [{ stage: "plan", why: "move R-1.2 to slice 5", from: "build-slice-1-2", gate: "G3", by: "agent:reviewer", at: "2026-01-02T00:00:00.000Z", taken: "2026-01-03T00:00:00.000Z" }] },
  "tests/acceptance/redo.yaml": { redo: [{ id: "R-1.1", version: 2, why: "the test polls the wrong list" }] },
  "tests/adapters/rebind.yaml": { rebind: [{ id: "R-1.3", target: "old", why: "reads the footer" }] },
  "spec/recovery.yaml": { recovery: [{ id: "R-2.1", domain: "content", version: 1, why: "the old app sorts by date", answered: { version: 2 } }] },
};

test("every kind already on disk reads into one shape, with its own fields beside it", (t) => {
  const dir = project(t);
  for (const [rel, doc] of Object.entries(LEGACY)) put(dir, rel, doc);

  const [condition] = read(dir, "condition");
  assert.equal(condition.kind, "condition");
  assert.equal(condition.item, "build-slice-1#1");
  assert.equal(condition.stage, "build");
  assert.equal(condition.why, "say what the session showed");
  assert.equal(condition.ref, "build-slice-1#1");
  assert.ok(isOpen(condition));

  const [request] = read(dir, "request");
  assert.equal(request.stage, "plan");
  assert.equal(request.why, "move R-1.2 to slice 5");
  assert.equal(request.closed.outcome, "met");
  assert.equal(request.closed.at, "2026-01-03T00:00:00.000Z");
  assert.ok(!isOpen(request), "a request marked taken is closed");

  const [redo] = read(dir, "redo");
  assert.deepEqual([redo.kind, redo.item, redo.stage, redo.why, redo.version], ["redo", "R-1.1", "derive-tests", "the test polls the wrong list", 2]);

  const [rebind] = read(dir, "rebind");
  assert.deepEqual([rebind.kind, rebind.stage, rebind.target, rebind.id], ["rebind", "bind-adapter", "old", "R-1.3"]);

  const [recovery] = read(dir, "recovery");
  assert.deepEqual([recovery.kind, recovery.item, recovery.stage], ["recovery", "R-2.1", "archaeology"]);
  assert.equal(recovery.closed.outcome, "met");
  assert.deepEqual(recovery.answered, { version: 2 });
});

test("each kind keeps the file it has always had, and a kind without one shares .sdlc/owed.yaml", () => {
  assert.equal(owedPath("condition"), ".sdlc/conditions.yaml");
  assert.equal(owedPath("request"), ".sdlc/revision-requests.yaml");
  assert.equal(owedPath("redo"), "tests/acceptance/redo.yaml");
  assert.equal(owedPath("rebind"), "tests/adapters/rebind.yaml");
  assert.equal(owedPath("recovery"), "spec/recovery.yaml");
  assert.equal(owedPath("missing-test"), OWED_PATH);
});

test("a file that is missing or does not parse reads as nothing owed", (t) => {
  const dir = project(t);
  assert.deepEqual(read(dir, "redo"), []);
  mkdirSync(join(dir, ".sdlc"), { recursive: true });
  writeFileSync(join(dir, ".sdlc", "conditions.yaml"), "conditions: [unclosed\n");
  assert.deepEqual(read(dir, "condition"), []);
  assert.deepEqual(entriesIn("request", "requests: 7\n"), []);
});

test("writing one entry leaves the others exactly as they were stored, with nothing derived written back", (t) => {
  const dir = project(t);
  for (const [rel, doc] of Object.entries(LEGACY)) put(dir, rel, doc);
  open(dir, "redo", [{ id: "R-1.9", version: 1, why: "asks for a capability the criterion never names" }]);
  const redo = parseYaml(readFileSync(join(dir, "tests/acceptance/redo.yaml"), "utf8")).redo;
  assert.deepEqual(redo[0], LEGACY["tests/acceptance/redo.yaml"].redo[0]);
  assert.deepEqual(Object.keys(redo[1]), ["id", "version", "why"]);

  open(dir, "condition", [{ ref: "build-slice-1-2#1", why: "keep the unit test", from: "build-slice-1-2", family: "build-slice-1", gate: "G3", stage: "build", by: "tech-lead", at: "2026-01-04T00:00:00.000Z" }]);
  const conditions = parseYaml(readFileSync(join(dir, ".sdlc/conditions.yaml"), "utf8")).conditions;
  assert.deepEqual(conditions[0], LEGACY[".sdlc/conditions.yaml"].conditions[0]);
  assert.deepEqual(Object.keys(conditions[1]), ["ref", "text", "from", "family", "gate", "stage", "by", "at"]);
  assert.equal(conditions[1].text, "keep the unit test");
});

test("opening reports what it added and files nothing it already holds", (t) => {
  const dir = project(t);
  const first = open(dir, "rebind", [{ id: "R-1.1", target: "old", why: "first" }]);
  assert.equal(first.path, "tests/adapters/rebind.yaml");
  assert.deepEqual(first.added.map((e) => e.why), ["first"]);
  const again = open(dir, "rebind", [{ id: "R-1.1", target: "old", why: "second" }, { id: "R-1.1", target: "new", why: "other adapter" }]);
  assert.deepEqual(again.added.map((e) => e.target), ["new"], "the first reason for an open pair is the one kept");
  assert.deepEqual(open(dir, "rebind", []), { path: null, added: [] });
  assert.deepEqual(open(dir, "rebind", [{ id: "R-1.1", target: "new", why: "x" }]), { path: null, added: [] });
});

test("an item closed and then sent again is a second entry, and both count as sends", (t) => {
  const dir = project(t);
  open(dir, "redo", [{ id: "R-1.1", version: 1, why: "asserts the wrong list" }]);
  assert.equal(close(dir, "redo", (e) => e.id === "R-1.1", { outcome: "met", why: "derived again by derive-tests-content-stale-2", by: "runner:derive-tests" }), "tests/acceptance/redo.yaml");
  assert.equal(read(dir, "redo").filter(isOpen).length, 0);
  assert.equal(read(dir, "redo").length, 1, "a closed entry stays on file with its closure");
  const reopened = open(dir, "redo", [{ id: "R-1.1", version: 1, why: "still asserts the wrong list" }]);
  assert.equal(reopened.added.length, 1, "only an open entry stops the same item being filed again");
  assert.equal(sends(read(dir, "redo"), "R-1.1"), 2);
  assert.equal(sends(read(dir, "redo"), "R-9.9"), 0);
});

test("a recovery is the same entry only when both the criterion and the reason match, answered or not", (t) => {
  const dir = project(t);
  put(dir, "spec/recovery.yaml", LEGACY["spec/recovery.yaml"]);
  assert.equal(open(dir, "recovery", [{ id: "R-2.1", domain: "content", version: 2, why: "the old app sorts by date" }]).added.length, 0);
  assert.equal(open(dir, "recovery", [{ id: "R-2.1", domain: "content", version: 2, why: "it also filters drafts" }]).added.length, 1);
  assert.equal(sends(read(dir, "recovery"), "R-2.1"), 2);
});

test("a round of requests one ruling filed together counts as one send", (t) => {
  const dir = project(t);
  const ask = (from, why) => ({ stage: "plan", why, from, family: "build-slice-1", gate: "G3", by: "agent:reviewer", at: `2026-01-0${from.length % 9}T00:00:00.000Z` });
  open(dir, "request", [ask("build-slice-1-4", "move R-1.2"), ask("build-slice-1-4", "split R-1.7")]);
  const [one] = read(dir, "request");
  assert.equal(sends(read(dir, "request"), one.item), 1);
  open(dir, "request", [ask("build-slice-1-5", "move R-1.2 again")]);
  assert.equal(sends(read(dir, "request"), one.item), 2);
});

test("a request's item is the stage asked and the line of work asking, however the family is named", (t) => {
  const dir = project(t);
  open(dir, "request", [
    { stage: "plan", why: "a", from: "build-slice-1-3", gate: "G3", by: "r", at: "1" },
    { stage: "plan", why: "b", from: "build-slice-1-4", gate: "G3", by: "r", at: "2" },
  ]);
  const familyOf = (name) => name.replace(/-\d+$/, "");
  const [a, b] = read(dir, "request", { familyOf });
  assert.equal(a.item, b.item);
  assert.equal(sends(read(dir, "request", { familyOf }), a.item), 2);
});

test("close needs evidence or a reason, and only the outcomes a kind allows", (t) => {
  const dir = project(t);
  open(dir, "condition", [{ ref: "p#1", why: "do x", from: "p", family: "p", gate: "G2", stage: "plan", by: "architect", at: "1" }]);
  assert.throws(() => close(dir, "condition", (e) => e.ref === "p#1", { outcome: "met", why: "" }), /evidence/);
  assert.throws(() => close(dir, "condition", (e) => e.ref === "p#1", { outcome: "done", why: "x" }), /met or withdrawn/);
  assert.equal(close(dir, "condition", (e) => e.ref === "p#1", { outcome: "withdrawn", why: "no longer asked for", by: "architect", at: "2" }), ".sdlc/conditions.yaml");
  const [c] = read(dir, "condition");
  assert.deepEqual(c.closed, { outcome: "withdrawn", why: "no longer asked for", by: "architect", at: "2" });
  assert.equal(close(dir, "condition", (e) => e.ref === "p#1", { outcome: "met", why: "x" }), null, "nothing open matches");

  open(dir, "request", [{ stage: "plan", why: "a", from: "q", gate: "G3", by: "r", at: "1" }]);
  assert.throws(() => close(dir, "request", () => true, { outcome: "withdrawn", why: "x" }), /request/);
});

test("a round settles whole or not at all", (t) => {
  const dir = project(t);
  open(dir, "request", [
    { stage: "plan", why: "a", from: "q", gate: "G3", by: "r", at: "1" },
    { stage: "plan", why: "b", from: "q", gate: "G3", by: "r", at: "1" },
  ]);
  const [a, b] = read(dir, "request");
  const ghost = { ...b, why: "never filed" };
  assert.equal(settle(dir, "request", { close: [a], defer: [{ entry: ghost, why: "x", proposal: "plan-2" }] }, "9"), null);
  assert.ok(read(dir, "request").every(isOpen));
  assert.equal(settle(dir, "request", { close: [a], defer: [{ entry: b, why: "needs the contract first", proposal: "plan-2" }] }, "9"), ".sdlc/revision-requests.yaml");
  const stored = parseYaml(readFileSync(join(dir, ".sdlc/revision-requests.yaml"), "utf8")).requests;
  assert.equal(stored[0].taken, "9");
  assert.equal(stored[1].taken, undefined);
  assert.deepEqual(stored[1].deferred, { at: "9", why: "needs the contract first", proposal: "plan-2" });
});

test("what a stage owes and what a line of work owes are read across kinds", (t) => {
  const dir = project(t);
  for (const [rel, doc] of Object.entries(LEGACY)) put(dir, rel, doc);
  open(dir, "request", [{ stage: "build", why: "rename the route", from: "build-slice-1-2", family: "build-slice-1", gate: "G3", by: "r", at: "5" }]);
  assert.deepEqual(openFor(dir, "build").map((e) => e.kind).sort(), ["condition", "request"]);
  assert.deepEqual(openFor(dir, "build", { kinds: ["condition"] }).map((e) => e.item), ["build-slice-1#1"]);
  assert.deepEqual(openFor(dir, "derive-tests").map((e) => e.item), ["R-1.1"]);
  assert.deepEqual(openFor(dir, "plan"), [], "a taken request is not owed");
  assert.deepEqual(openForFamily(dir, "build-slice-1", { kinds: ["condition"] }).map((e) => e.ref), ["build-slice-1#1"]);
});

test("main's list is read while another branch is checked out", (t) => {
  const dir = project(t);
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("commit", "-q", "--allow-empty", "-m", "root");
  g("checkout", "-q", "-b", "proposal/x");
  g("checkout", "-q", "main");
  open(dir, "condition", [{ ref: "x#1", why: "do y", from: "x", family: "x", gate: "G2", stage: "plan", by: "architect", at: "1" }]);
  g("add", "-A");
  g("commit", "-q", "-m", "owe");
  g("checkout", "-q", "proposal/x");
  assert.deepEqual(read(dir, "condition"), []);
  assert.deepEqual(readAt(dir, "condition").map((e) => e.ref), ["x#1"]);
  assert.deepEqual(readAt(dir, "redo"), [], "a kind main has no file for owes nothing");
});

test("a kind the engine has never seen needs no machinery of its own", (t) => {
  const dir = project(t);
  const r = open(dir, "missing-test", [{ item: "R-4.2", stage: "contract", why: "the mail observation exposes no body", from: "derive-tests-mail", gate: "G3", by: "agent:reviewer", at: "1" }]);
  assert.equal(r.path, OWED_PATH);
  assert.ok(existsSync(join(dir, OWED_PATH)));
  const [e] = openFor(dir, "contract");
  assert.deepEqual([e.kind, e.item, e.stage], ["missing-test", "R-4.2", "contract"]);
  assert.equal(open(dir, "missing-test", [{ item: "R-4.2", stage: "contract", why: "again" }]).added.length, 0);
  close(dir, "missing-test", (x) => x.item === "R-4.2", { outcome: "met", why: "tests/acceptance/mail/R-4.2.spec.ts runs", by: "agent:reviewer", at: "2" });
  assert.equal(openFor(dir, "contract").length, 0);
  assert.equal(sends(read(dir, "missing-test"), "R-4.2"), 1);
  const stored = parseYaml(readFileSync(join(dir, OWED_PATH), "utf8")).owed;
  assert.equal(stored[0].kind, "missing-test");
  open(dir, "other-kind", [{ item: "z", stage: "plan", why: "w" }]);
  assert.deepEqual(read(dir, "missing-test").map((x) => x.item), ["R-4.2"], "kinds sharing the file are read apart");
});

// A redo entry (or any other owed kind bound to a criterion) for one another criterion has
// superseded, or one made obsolete, asks for work that will never be done: `derive-tests`
// derives no test for such a criterion, so nothing would ever close the entry
// (`docs/decisions/0048`, `0052`). What counts as retired is the caller's to say — this
// module only knows entries and kinds.
test("withdrawRetired closes every open entry whose item the caller says is retired, and leaves the rest", (t) => {
  const dir = project(t);
  put(dir, "tests/acceptance/redo.yaml", { redo: [
    { id: "R-1.1", version: 1, why: "asserted the wrong thing" },
    { id: "R-1.2", version: 3, why: "the oracle changed" },
  ] });

  const isRetired = (id) => id === "R-1.1";
  const why = (id) => `${id} is superseded by R-1.9, which carries what it asked; no test is derived for it`;
  const r = withdrawRetired(dir, "redo", isRetired, why);
  assert.deepEqual(r.withdrawn, ["R-1.1"]);

  const [a, b] = read(dir, "redo");
  assert.equal(a.closed.outcome, "withdrawn");
  assert.equal(a.closed.by, "runner");
  assert.match(a.closed.why, /R-1\.1 is superseded by R-1\.9/);
  assert.ok(!b.closed, "an entry retired says nothing about is left open");

  assert.equal(withdrawRetired(dir, "redo", isRetired, why).path, null, "nothing left to withdraw a second time");
});

// A kind whose item names something other than a criterion — a rebind's adapter member — never
// matches, so the same call is safe for every kind without a caller having to filter by kind
// first.
test("withdrawRetired leaves a kind whose items are never criteria untouched", (t) => {
  const dir = project(t);
  put(dir, "tests/adapters/rebind.yaml", { rebind: [{ id: "R-1.1", target: "old", why: "reads the footer" }] });
  const r = withdrawRetired(dir, "rebind", () => false, () => "unreachable");
  assert.deepEqual(r, { path: null, withdrawn: [] });
  assert.ok(isOpen(read(dir, "rebind")[0]));
});

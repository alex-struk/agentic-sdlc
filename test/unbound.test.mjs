// A calibration row whose every failing test ended in the adapter's own `unbound:` error is
// owed to `bind-adapter` for its target, as a rebind entry the adapter's own reason explains,
// and bounded by `policy.loops.rebind` (`docs/decisions/0067`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isOpen, read, sends } from "../src/spec/owed.mjs";
import { UNBOUND, openUnboundRows, unboundHanded, unboundOwed, unboundWhy, syncUnbound, legacyAdapter } from "../src/spec/unbound.mjs";
import { stageFor } from "../src/stages/registry.mjs";

const row = (id, result, more = {}) => ({
  id, version: 1, domain: "alpha", file: `tests/acceptance/alpha/${id}.spec.ts`, result,
  tests: result === "unbound"
    ? [
      { title: "one", status: "failed", error: `Error: unbound: a-page.go — no button labelled "Go" on /a\n    at stack` },
      { title: "two", status: "failed", error: `Error: unbound: a-page.go — no button labelled "Go" on /a` },
      { title: "three", status: "passed" },
    ]
    : [{ title: "one", status: result === "pass" ? "passed" : "failed" }],
  ...more,
});

test("an unbound row's reason is the adapter's own words, each said once", () => {
  assert.equal(unboundWhy(row("R-1.1", "unbound")), 'unbound: a-page.go — no button labelled "Go" on /a');
  const two = row("R-1.2", "unbound", { tests: [
    { title: "a", status: "failed", error: "unbound: a-page.go — missing" },
    { title: "b", status: "timedOut", error: "Error: unbound: b-page.shown — not drawn" },
  ] });
  assert.equal(unboundWhy(two), "unbound: a-page.go — missing; unbound: b-page.shown — not drawn");
  const whole = { id: "R-1.3", result: "unbound", tests: [], error: "unbound: tests/adapters/old/index.ts does not exist" };
  assert.equal(unboundWhy(whole), "unbound: tests/adapters/old/index.ts does not exist");
});

test("an open unbound row is one with an id and no ruling", () => {
  const results = { rows: [row("R-1.1", "unbound"), row("R-1.2", "unbound", { ruled: "defect-in-old" }), row("R-1.3", "pass"), { id: null, result: "unbound", tests: [] }] };
  assert.deepEqual(openUnboundRows(results).map((r) => r.id), ["R-1.1"]);
});

// ── what is owed, read without writing ──────────────────────────────────────────────────

test("an unbound row nothing has filed is owed to bind-adapter, carrying the adapter's reason", () => {
  const rows = [row("R-1.1", "unbound", { adapter: "A" }), row("R-1.2", "pass", { adapter: "A" })];
  const { pending, spent } = unboundOwed({ target: "old", rows, adapter: "A", entries: [], limit: 2 });
  assert.deepEqual(spent, []);
  assert.equal(pending.length, 1);
  const [e] = pending;
  assert.deepEqual([e.kind, e.stage, e.item, e.id, e.target, e.found, e.adapter], ["rebind", "bind-adapter", "old:R-1.1", "R-1.1", "old", UNBOUND, "A"]);
  assert.match(e.why, /^unbound: a-page\.go/);
  assert.equal(e.closed, null);
});

test("an unbound row with an open entry is owed as that entry, not twice", () => {
  const entries = [{ kind: "rebind", item: "old:R-1.1", id: "R-1.1", target: "old", why: "x", found: UNBOUND, adapter: "A", closed: null }];
  const r = unboundOwed({ target: "old", rows: [row("R-1.1", "unbound", { adapter: "A" })], adapter: "A", entries, limit: 2 });
  assert.deepEqual(r, { pending: [], spent: [] });
});

test("once policy.loops.rebind sends are spent, an unbound row is no longer owed to bind-adapter", () => {
  const sent = (adapter) => ({ kind: "rebind", item: "old:R-1.1", id: "R-1.1", target: "old", why: "x", found: UNBOUND, adapter, closed: { outcome: "met", why: "changed" } });
  const rows = [row("R-1.1", "unbound", { adapter: "C" })];
  const once = unboundOwed({ target: "old", rows, adapter: "C", entries: [sent("A")], limit: 2 });
  assert.equal(once.pending.length, 1, "one send of two: owed again");
  const twice = unboundOwed({ target: "old", rows, adapter: "C", entries: [sent("A"), sent("B")], limit: 2 });
  assert.deepEqual(twice.pending, []);
  assert.deepEqual(twice.spent.map((s) => [s.id, s.sends, s.limit]), [["R-1.1", 2, 2]]);
  assert.match(twice.spent[0].why, /^unbound: a-page\.go/);
});

test("a row found under an adapter that has since changed is owed a calibration, whatever its count", () => {
  const sent = (adapter) => ({ kind: "rebind", item: "old:R-1.1", id: "R-1.1", target: "old", why: "x", found: UNBOUND, adapter, closed: { outcome: "met", why: "changed" } });
  const rows = [row("R-1.1", "unbound", { adapter: "B" })];
  const r = unboundOwed({ target: "old", rows, adapter: "C", entries: [sent("A"), sent("B")], limit: 2 });
  assert.deepEqual(r.spent, []);
  assert.deepEqual(r.pending.map((e) => [e.id, e.adapter]), [["R-1.1", "B"]], "carries the adapter it was found under, which is not the current one");
});

test("a row that records no adapter was found under the one given for the file", () => {
  const r = unboundOwed({ target: "old", rows: [row("R-1.1", "unbound")], fallback: "A", adapter: "A", entries: [], limit: 2 });
  assert.deepEqual(r.pending.map((e) => e.adapter), ["A"]);
});

// ── what calibrate writes ─────────────────────────────────────────────────────────────────

function project(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-unbound-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const put = (rel, text) => { mkdirSync(dirname(join(d, rel)), { recursive: true }); writeFileSync(join(d, rel), text); };
  const git = (args) => execFileSync("git", args, { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q", "-b", "main"]);
  const commit = (files, m = "record") => {
    for (const [rel, text] of Object.entries(files)) put(rel, text);
    git(["add", "-A"]);
    git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "--allow-empty", "-m", m]);
    return git(["rev-parse", "HEAD"]);
  };
  const tree = () => git(["rev-parse", "HEAD:tests/adapters/old"]);
  return { d, put, git, commit, tree };
}

const unboundEntries = (d) => read(d, "rebind").filter((e) => e.found === UNBOUND);

test("calibrate files an unbound row once per adapter, and closes it when the row settles", (t) => {
  const { d, commit, tree } = project(t);
  commit({ "tests/adapters/old/index.ts": "export default 1;\n" });
  const A = tree();
  const rows = [row("R-1.1", "unbound", { adapter: A }), row("R-1.2", "unbound", { adapter: A }), row("R-1.3", "pass", { adapter: A })];

  const first = syncUnbound(d, "old", { rows, adapter: A, limit: 2, at: "2026-01-01T00:00:00.000Z" });
  assert.equal(first.path, "tests/adapters/rebind.yaml");
  assert.deepEqual(first.opened, ["R-1.1", "R-1.2"]);
  const [e] = unboundEntries(d);
  assert.deepEqual([e.id, e.target, e.found, e.adapter, e.by], ["R-1.1", "old", UNBOUND, A, "runner:calibrate"]);
  assert.match(e.why, /^unbound: a-page\.go — no button labelled "Go"/);

  assert.equal(syncUnbound(d, "old", { rows, adapter: A, limit: 2 }).path, null, "a second pass over the same rows changes nothing");

  // R-1.1 now passes and R-1.2 was ruled on: neither is owed any more.
  const settled = syncUnbound(d, "old", { rows: [row("R-1.1", "pass", { adapter: A }), row("R-1.2", "unbound", { adapter: A, ruled: "defect-in-old" })], adapter: A, limit: 2 });
  assert.deepEqual(settled.closed.sort(), ["R-1.1", "R-1.2"]);
  const byId = new Map(unboundEntries(d).map((x) => [x.id, x]));
  assert.equal(byId.get("R-1.1").closed.outcome, "met");
  assert.match(byId.get("R-1.1").closed.why, /pass/);
  assert.equal(byId.get("R-1.2").closed.outcome, "withdrawn");
  assert.match(byId.get("R-1.2").closed.why, /ruled defect-in-old/);
});

test("an entry lapses when the adapter changes, and a row still unbound is sent again until the limit is spent", (t) => {
  const { d, commit, tree } = project(t);
  commit({ "tests/adapters/old/index.ts": "export default 1;\n" });
  const A = tree();
  syncUnbound(d, "old", { rows: [row("R-1.1", "unbound", { adapter: A })], adapter: A, limit: 2 });

  commit({ "tests/adapters/old/index.ts": "export default 2;\n" });
  const B = tree();
  const second = syncUnbound(d, "old", { rows: [row("R-1.1", "unbound", { adapter: B })], adapter: B, limit: 2 });
  assert.deepEqual(second.closed, ["R-1.1"]);
  assert.deepEqual(second.opened, ["R-1.1"]);
  const list = unboundEntries(d);
  assert.match(list[0].closed.why, /tests\/adapters\/old has changed since this was found/);
  assert.deepEqual(list.filter(isOpen).map((x) => x.adapter), [B]);
  assert.equal(sends(read(d, "rebind"), "old:R-1.1"), 2);

  commit({ "tests/adapters/old/index.ts": "export default 3;\n" });
  const C = tree();
  const third = syncUnbound(d, "old", { rows: [row("R-1.1", "unbound", { adapter: C })], adapter: C, limit: 2 });
  assert.deepEqual(third.opened, [], "two sends spent: not sent a third time");
  assert.deepEqual(unboundEntries(d).filter(isOpen), []);
});

// Rows recorded before an adapter was written on them were found under the adapter at the
// commit that recorded them. When that adapter has since changed, whatever it was owed was
// sent under it, and is counted as sent once, then lapses.
test("a row found under an earlier adapter and never filed is counted as sent under it, then lapses", (t) => {
  const { d, commit, tree } = project(t);
  commit({ "tests/adapters/old/index.ts": "export default 1;\n" });
  const A = tree();
  commit({ "tests/results/old/latest.json": JSON.stringify({ rows: [row("R-1.1", "unbound")] }) }, "stage(calibrate)");
  commit({ "tests/adapters/old/index.ts": "export default 2;\n" });
  const B = tree();
  assert.equal(legacyAdapter(d, "old", "HEAD"), A);

  const before = syncUnbound(d, "old", { rows: [row("R-1.1", "unbound")], fallback: A, adapter: B, limit: 2, settle: false });
  assert.deepEqual(before.opened, ["R-1.1"]);
  assert.deepEqual(before.closed, ["R-1.1"]);
  const [e] = unboundEntries(d);
  assert.equal(e.adapter, A);
  assert.ok(!isOpen(e));
  assert.equal(syncUnbound(d, "old", { rows: [row("R-1.1", "unbound")], fallback: A, adapter: B, limit: 2, settle: false }).path, null, "counted once");

  const after = syncUnbound(d, "old", { rows: [row("R-1.1", "unbound", { adapter: B })], adapter: B, limit: 2 });
  assert.deepEqual(after.opened, ["R-1.1"]);
  assert.equal(sends(read(d, "rebind"), "old:R-1.1"), 2);
});

test("an adapter's reason is scrubbed of local paths where calibrate writes it", (t) => {
  const { d, commit, tree } = project(t);
  commit({ "tests/adapters/old/index.ts": "export default 1;\n" });
  const A = tree();
  const elsewhere = `/${"home"}/someone`;
  const leaky = row("R-1.1", "unbound", { adapter: A, tests: [{ title: "t", status: "failed", error: `Error: unbound: a-page.go — see ${elsewhere}/notes/go.md` }] });
  syncUnbound(d, "old", { rows: [leaky], adapter: A, limit: 2 });
  const [e] = unboundEntries(d);
  assert.ok(!e.why.includes(elsewhere), e.why);
  assert.match(e.why, /^unbound: a-page\.go — see ~\/notes\/go\.md$/);
});

// ── what bind-adapter is handed ───────────────────────────────────────────────────────────

test("bind-adapter is handed the unbound rows nothing has filed yet, under the adapter it is binding", (t) => {
  const { d, commit, tree } = project(t);
  commit({ "tests/adapters/old/index.ts": "export default 1;\n" });
  const A = tree();
  commit({ "tests/results/old/latest.json": JSON.stringify({ rows: [row("R-1.1", "unbound"), row("R-1.2", "unbound", { adapter: "someother" }), row("R-1.3", "pass")] }) });
  const handed = unboundHanded(d, "old", { policy: {} });
  assert.deepEqual(handed.map((e) => [e.id, e.adapter, e.found]), [["R-1.1", A, UNBOUND]]);
  assert.deepEqual(unboundHanded(d, "new", {}), [], "a target with no results is handed nothing");
});

test("a binding run is told which bindings its own adapter reported unbound, in its own words", () => {
  const stage = stageFor("bind-adapter");
  const prompt = stage.prompt({
    target: "old", bindAdapterBaseUrl: "http://localhost:3000", bindAdapterIdentity: "session-route",
    bindAdapterRebind: [
      { id: "R-1.8", why: 'reported "Save Draft" missing; the page renders it' },
      { id: "R-2.3", found: UNBOUND, why: 'unbound: a-page.go — no button labelled "Go" on /a' },
    ],
  });
  assert.match(prompt, /the reviewer found the criterion and the test sound/);
  assert.match(prompt, /- R-1\.8: reported "Save Draft" missing/);
  const paragraphs = prompt.split("\n\n");
  const reviewers = paragraphs[paragraphs.findIndex((p) => /the reviewer found/.test(p)) + 1];
  assert.match(reviewers, /R-1\.8/);
  assert.doesNotMatch(reviewers, /R-2\.3/, "an unbound report is not presented as a reviewer's finding");
  assert.match(prompt, /this adapter reported unbound/);
  assert.match(prompt, /- R-2\.3: unbound: a-page\.go — no button labelled "Go" on \/a/);
  assert.match(prompt, /say in the reason what you did to look/);
  const only = stage.prompt({ target: "old", bindAdapterBaseUrl: "http://x", bindAdapterRebind: [{ id: "R-2.3", found: UNBOUND, why: "unbound: a-page.go — gone" }] });
  assert.doesNotMatch(only, /the reviewer found/);
});

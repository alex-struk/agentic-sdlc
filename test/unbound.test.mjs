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
import { UNBOUND, PERSONA_UNAVAILABLE, openUnboundRows, unboundHanded, unboundOwed, unboundWhy, syncUnbound, withdrawUnclaimed, legacyAdapter, targetIdentity, unavailablePersonas, personaUnavailable } from "../src/spec/unbound.mjs";
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

// ── a persona the contract marks unavailable ─────────────────────────────────────────────

// A test signing in as a persona the approved contract says the target offers no way to act as
// can never run against it, whatever a binding run does (`docs/decisions/0068`).
const PERSONAS = {
  personas: [
    { id: "applicant", can: ["apply"], sign_in: { "session-route": { route: "/as/applicant" }, "sandbox-idp": { username: "applicant-1" } } },
    { id: "second-applicant", can: ["apply"], sign_in: { "session-route": { unavailable: "the target has one applicant account" }, "sandbox-idp": { username: "applicant-2" } } },
    { id: "blank-reason", can: ["apply"], sign_in: { "session-route": { unavailable: "  " } } },
    { id: "visitor", can: ["look"], sign_in: null },
  ],
};

const signInRow = (id, personas, more = {}) => row(id, "unbound", {
  tests: personas.map((p, i) => ({ title: `t${i}`, status: "failed", error: `Error: unbound: signIn.${p} — the target has one applicant account\n    at stack` })),
  ...more,
});

test("a target's identity is the oracle's for the oracle, and its own entry's otherwise", () => {
  const config = { oracle: { target: "old", identity: "session-route" }, targets: { new: { identity: "sandbox-idp" } } };
  assert.equal(targetIdentity(config, "old"), "session-route");
  assert.equal(targetIdentity(config, "new"), "sandbox-idp");
  assert.equal(targetIdentity(config, "elsewhere"), null);
});

test("the personas the contract marks unavailable are read per identity, each with its reason", () => {
  const onOracle = unavailablePersonas(PERSONAS, "session-route");
  assert.deepEqual([...onOracle], [["second-applicant", "the target has one applicant account"]], "a blank reason marks nothing");
  assert.deepEqual([...unavailablePersonas(PERSONAS, "sandbox-idp")], []);
  assert.deepEqual([...unavailablePersonas(null, "session-route")], []);
  assert.deepEqual([...unavailablePersonas(PERSONAS, null)], []);
});

test("a row closes on an unavailable persona only when every failing test stopped at signing in as one", () => {
  const unavailable = unavailablePersonas(PERSONAS, "session-route");
  assert.deepEqual(personaUnavailable(signInRow("R-1.1", ["second-applicant", "second-applicant"]), unavailable), ["second-applicant"]);
  const mixed = signInRow("R-1.2", ["second-applicant"]);
  mixed.tests.push({ title: "member", status: "failed", error: 'Error: unbound: a-page.go — no button labelled "Go" on /a' });
  assert.equal(personaUnavailable(mixed, unavailable), null, "a member the adapter did not bind is still binding work");
  assert.equal(personaUnavailable(signInRow("R-1.3", ["applicant"]), unavailable), null, "a persona the contract offers is the adapter's to sign in as");
  assert.equal(personaUnavailable(signInRow("R-1.4", ["second-applicant"]), unavailablePersonas(PERSONAS, "sandbox-idp")), null, "unavailable on another identity only");
  assert.equal(personaUnavailable(signInRow("R-1.5", ["second-applicant"], { result: "fail" }), unavailable), null, "only an unbound row");
  const prefix = signInRow("R-1.6", ["second-applicant-other"]);
  assert.equal(personaUnavailable(prefix, unavailable), null, "the persona is named whole, not by prefix");
  const passing = signInRow("R-1.7", ["second-applicant"]);
  passing.tests.push({ title: "fine", status: "passed" });
  assert.deepEqual(personaUnavailable(passing, unavailable), ["second-applicant"], "a passing test beside it changes nothing");
});

test("a row needing an unavailable persona is owed to nobody, and never waits on a ruler", () => {
  const unavailable = unavailablePersonas(PERSONAS, "session-route");
  const sent = (adapter) => ({ kind: "rebind", item: "old:R-1.1", id: "R-1.1", target: "old", why: "x", found: UNBOUND, adapter, closed: { outcome: "met", why: "changed" } });
  const rows = [signInRow("R-1.1", ["second-applicant"], { adapter: "C" }), row("R-1.2", "unbound", { adapter: "C" })];
  const fresh = unboundOwed({ target: "old", rows, adapter: "C", entries: [], limit: 2, unavailable });
  assert.deepEqual(fresh.pending.map((e) => e.id), ["R-1.2"]);
  const past = unboundOwed({ target: "old", rows, adapter: "C", entries: [sent("A"), sent("B")], limit: 2, unavailable });
  assert.deepEqual(past.spent, []);
  assert.equal(PERSONA_UNAVAILABLE, "persona-unavailable");
});

// ── a verify of one slice ─────────────────────────────────────────────────────────────────

// A verify runs the tests for the criteria one slice claims, so what it files and closes is
// about those criteria alone: an entry another slice's verify filed stays as it is until that
// slice is verified again, whatever the adapter has done since.
test("a sync scoped to some criteria files and closes those alone, stamped by whoever ran it", (t) => {
  const { d, commit } = project(t);
  commit({ "tests/adapters/new/index.ts": "export default 1;\n" });
  const A = execFileSync("git", ["rev-parse", "HEAD:tests/adapters/new"], { cwd: d, encoding: "utf8" }).trim();
  syncUnbound(d, "new", { rows: [row("R-9.9", "unbound", { adapter: A })], adapter: A, limit: 2, ids: ["R-9.9"], by: "runner:verify", stamp: { slice: 7 } });
  commit({ "tests/adapters/new/index.ts": "export default 2;\n" });
  const B = execFileSync("git", ["rev-parse", "HEAD:tests/adapters/new"], { cwd: d, encoding: "utf8" }).trim();

  const r = syncUnbound(d, "new", { rows: [row("R-1.1", "unbound", { adapter: B }), row("R-1.2", "pass", { adapter: B })], adapter: B, limit: 2, ids: ["R-1.1", "R-1.2"], by: "runner:verify", stamp: { slice: 1 } });
  assert.deepEqual(r.opened, ["R-1.1"]);
  assert.deepEqual(r.closed, [], "R-9.9 is another slice's, and nothing about it was run");
  const byId = new Map(unboundEntries(d).map((x) => [x.id, x]));
  assert.deepEqual([byId.get("R-1.1").by, byId.get("R-1.1").slice, byId.get("R-1.1").target, byId.get("R-1.1").adapter], ["runner:verify", 1, "new", B]);
  assert.ok(isOpen(byId.get("R-9.9")));
  assert.equal(byId.get("R-9.9").slice, 7);

  // The slice is verified again under the adapter the binding run wrote, and R-1.1 passes.
  const again = syncUnbound(d, "new", { rows: [row("R-1.1", "pass", { adapter: B })], adapter: B, limit: 2, ids: ["R-1.1", "R-1.2"], by: "runner:verify" });
  assert.deepEqual(again.closed, ["R-1.1"]);
  assert.equal(new Map(unboundEntries(d).map((x) => [x.id, x])).get("R-1.1").closed.outcome, "met");
});

// A plan revised after a verify filed a row can move the criterion to another slice. No verify of
// the first slice measures it again, so that slice's next verify withdraws the entry, and leaves
// another slice's entries, and its own for criteria it still claims, as they are
// (`docs/decisions/0085`).
test("a verify withdraws the entries its slice filed for criteria the slice no longer claims", (t) => {
  const { d } = project(t);
  const entry = (id, slice) => `  - { id: ${id}, target: new, why: "unbound: a.b — gone", found: unbound, adapter: A, slice: ${slice}, by: "runner:verify", at: "2026-01-01T00:00:00.000Z" }\n`;
  mkdirSync(join(d, "tests", "adapters"), { recursive: true });
  writeFileSync(join(d, "tests", "adapters", "rebind.yaml"), `rebind:\n${entry("R-1.48", 7)}${entry("R-8.19", 7)}${entry("R-2.1", 9)}`);
  const r = withdrawUnclaimed(d, "new", { slice: 7, ids: ["R-8.19", "R-8.25"], by: "runner:verify", at: "2026-01-02T00:00:00.000Z" });
  assert.deepEqual(r.withdrawn, ["R-1.48"]);
  const byId = new Map(unboundEntries(d).map((x) => [x.id, x]));
  assert.deepEqual([byId.get("R-1.48").closed.outcome, byId.get("R-1.48").closed.why, byId.get("R-1.48").closed.by], ["withdrawn", "slice 7 no longer claims it", "runner:verify"]);
  assert.ok(isOpen(byId.get("R-8.19")), "a criterion the slice still claims is the sync's to settle");
  assert.ok(isOpen(byId.get("R-2.1")), "another slice's entry is that slice's");
  assert.deepEqual(withdrawUnclaimed(d, "new", { slice: 7, ids: ["R-8.19"] }), { path: null, withdrawn: [] }, "nothing left to withdraw writes nothing");
});

// A verify measures one build of the application, and the slice's next build can add the very
// screen a row needed. The rebind limit stops a binding loop on one application, so the sends a
// row spent against an earlier build do not stop it being owed against a new one
// (`docs/decisions/0083`).
test("a verify's rebind limit counts the sends made against the application it measured", (t) => {
  const { d, commit } = project(t);
  commit({ "tests/adapters/new/index.ts": "export default 1;\n" });
  const A = execFileSync("git", ["rev-parse", "HEAD:tests/adapters/new"], { cwd: d, encoding: "utf8" }).trim();
  const spentOn = (appTree) => `  - { id: R-1.1, target: new, why: "unbound: a.b — gone", found: unbound, adapter: ${A}, slice: 1, by: "runner:verify", at: "2026-01-01T00:00:00.000Z"${appTree ? `, app_tree: ${appTree}` : ""}, closed: { outcome: met, why: "sent", at: "2026-01-01T00:00:00.000Z" } }\n`;
  const sync = (appTree) => syncUnbound(d, "new", { rows: [row("R-1.1", "unbound", { adapter: A })], adapter: A, limit: 2, ids: ["R-1.1"], by: "runner:verify", stamp: { slice: 1 }, appTree });

  writeFileSync(join(d, "tests", "adapters", "rebind.yaml"), `rebind:\n${spentOn("tree-a")}${spentOn("tree-a")}`);
  assert.deepEqual(sync("tree-a").opened, [], "two sends spent against this build: not sent a third time");
  const again = sync("tree-b");
  assert.deepEqual(again.opened, ["R-1.1"], "a new build of the application is owed the binding again");
  const filed = unboundEntries(d).find(isOpen);
  assert.deepEqual([filed.app_tree, filed.slice, filed.adapter], ["tree-b", 1, A]);
  assert.equal(sends(read(d, "rebind"), "new:R-1.1", "tree-b"), 1);
  assert.equal(sends(read(d, "rebind"), "new:R-1.1", "tree-a"), 2);
  assert.equal(sends(read(d, "rebind"), "new:R-1.1"), 3, "counted without a tree, every send is one");

  // An entry filed before verify recorded the application counts against every build.
  writeFileSync(join(d, "tests", "adapters", "rebind.yaml"), `rebind:\n${spentOn("")}${spentOn("")}`);
  assert.deepEqual(sync("tree-c").opened, [], "sends that name no application are spent against this one too");
  writeFileSync(join(d, "tests", "adapters", "rebind.yaml"), `rebind:\n${spentOn("")}${spentOn("tree-a")}`);
  assert.deepEqual(sync("tree-a").opened, [], "one unstamped send and one against this build make two");
  assert.deepEqual(sync("tree-c").opened, ["R-1.1"], "against another build only the unstamped send counts");
});

// Calibration measures a fixed application and passes no tree, so every send counts, as it did.
test("a calibration's rebind limit counts every send, whatever application a verify stamped", (t) => {
  const { d, commit, tree } = project(t);
  commit({ "tests/adapters/old/index.ts": "export default 1;\n" });
  const A = tree();
  const spentOn = (appTree) => `  - { id: R-1.1, target: old, why: "unbound: a.b — gone", found: unbound, adapter: ${A}, by: "runner:calibrate", at: "2026-01-01T00:00:00.000Z"${appTree ? `, app_tree: ${appTree}` : ""}, closed: { outcome: met, why: "sent", at: "2026-01-01T00:00:00.000Z" } }\n`;
  writeFileSync(join(d, "tests", "adapters", "rebind.yaml"), `rebind:\n${spentOn("tree-a")}${spentOn("tree-b")}`);
  const r = syncUnbound(d, "old", { rows: [row("R-1.1", "unbound", { adapter: A })], adapter: A, limit: 2 });
  assert.deepEqual(r.opened, []);
  assert.equal(unboundEntries(d).filter(isOpen).length, 0);
  assert.equal(unboundOwed({ target: "old", rows: [row("R-1.1", "unbound", { adapter: A })], adapter: A, entries: read(d, "rebind"), limit: 2 }).spent.length, 1);
});

// A binding run is handed every open rebind entry for its target. One approved with the adapter
// left as it was has looked at each and found nothing to bind it to, and another run would look
// at the same adapter: the row is the ruler's, as if its sends were spent (`docs/decisions/0097`).
const answeredBy = (adapter, more = {}) => ({ kind: "rebind", item: "old:R-1.1", id: "R-1.1", target: "old", why: "x", found: UNBOUND, adapter,
  closed: { outcome: "met", why: "left as it was", answered_by: "bind-adapter-old-4" }, ...more });

test("a row an approved binding answered under the adapter there is now is the ruler's, not sent again", () => {
  const rows = [row("R-1.1", "unbound", { adapter: "A" })];
  const r = unboundOwed({ target: "old", rows, adapter: "A", entries: [answeredBy("A")], limit: 2 });
  assert.deepEqual(r.pending, [], "one send of two, and still not owed to bind-adapter again");
  assert.deepEqual(r.spent.map((s) => [s.id, s.sends, s.answered_by]), [["R-1.1", 1, "bind-adapter-old-4"]]);
  const changed = unboundOwed({ target: "old", rows: [row("R-1.1", "unbound", { adapter: "B" })], adapter: "B", entries: [answeredBy("A")], limit: 2 });
  assert.equal(changed.pending.length, 1, "under an adapter that has changed since, the row is owed again");
  assert.deepEqual(changed.spent, []);
});

test("a run does not file again a row a binding answered against the same adapter and build", (t) => {
  const { d, commit } = project(t);
  commit({ "tests/adapters/new/index.ts": "export default 1;\n" });
  const A = execFileSync("git", ["rev-parse", "HEAD:tests/adapters/new"], { cwd: d, encoding: "utf8" }).trim();
  writeFileSync(join(d, "tests", "adapters", "rebind.yaml"), `rebind:\n  - { id: R-1.1, target: new, why: "unbound: a.b — gone", found: unbound, adapter: ${A}, slice: 1, by: "runner:verify", at: "2026-01-01T00:00:00.000Z", app_tree: tree-a, closed: { outcome: met, why: "left as it was", at: "2026-01-02T00:00:00.000Z", answered_by: bind-adapter-new-4 } }\n`);
  const sync = (appTree) => syncUnbound(d, "new", { rows: [row("R-1.1", "unbound", { adapter: A })], adapter: A, limit: 2, ids: ["R-1.1"], by: "runner:verify", stamp: { slice: 1 }, appTree });
  assert.deepEqual(sync("tree-a").opened, [], "the binding has answered against this build");
  assert.deepEqual(sync("tree-b").opened, ["R-1.1"], "a new build of the application is owed the binding again");
});

test("an unbound row's reason is read off the last step where the test caught the adapter's error", () => {
  const caught = { id: "R-1.9", result: "unbound", tests: [{ title: "t", status: "failed", error: "Error: the proposal carries no score",
    steps: [{ step: "view.open" }, { step: "view.totalScore", threw: "unbound: view.total_score — the page now shows a total score" }] }] };
  assert.equal(unboundWhy(caught), "unbound: view.total_score — the page now shows a total score");
});

test("a sign-in refusal a test caught is read off its last step, and a test that timed out is not", () => {
  const unavailable = new Map([["applicant", "no account on this identity"]]);
  const caught = (status) => ({ id: "R-1.8", result: "unbound", tests: [{ title: "t", status, error: "Error: the form opened",
    steps: [{ step: "signIn", threw: "unbound: signIn.applicant — no account on this identity" }] }] });
  assert.deepEqual(personaUnavailable(caught("failed"), unavailable), ["applicant"]);
  assert.equal(personaUnavailable(caught("timedOut"), unavailable), null);
  assert.equal(unboundWhy(caught("timedOut")), "unbound: the adapter gave no reason");
});

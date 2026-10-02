// Two runs that start from the same `main` number their journal entries alike, and two entries
// for the same stage then share a file name. When the branches meet, both entries are kept: the
// one `main` holds keeps its name, and the other sits beside it with `-<n>` added.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeInto } from "../src/lib/git.mjs";

function repo(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-merge-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  const commit = (m) => { run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", m]); };
  run(["init", "-q", "-b", "main"]);
  mkdirSync(join(d, ".sdlc", "journal"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "journal", "001-plan.md"), "plan\n");
  commit("start");
  run(["checkout", "-q", "-b", "proposal/build-slice-2"]);
  writeFileSync(join(d, ".sdlc", "journal", "002-build.md"), "slice 2's build\n");
  commit("slice 2");
  run(["checkout", "-q", "main"]);
  run(["checkout", "-q", "-b", "proposal/build-slice-1"]);
  writeFileSync(join(d, ".sdlc", "journal", "002-build.md"), "slice 1's build\n");
  commit("slice 1");
  run(["checkout", "-q", "main"]);
  run(["-c", "user.name=t", "-c", "user.email=t@e.test", "merge", "-q", "--no-ff", "-m", "slice 1 approved", "proposal/build-slice-1"]);
  return { d, run };
}

const read = (d, f) => readFileSync(join(d, ".sdlc", "journal", f), "utf8");

test("main merged into a branch whose journal entry took the same name keeps both, main's under its own name", (t) => {
  const { d, run } = repo(t);
  run(["checkout", "-q", "proposal/build-slice-2"]);
  const r = mergeInto(d, "main", "merge(verify): main into proposal/build-slice-2");
  assert.equal(r.ok, true);
  assert.equal(read(d, "002-build.md"), "slice 1's build\n", "the entry main holds keeps its name");
  assert.equal(read(d, "002-build-2.md"), "slice 2's build\n", "the branch's own entry is kept beside it");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: d, encoding: "utf8" }), "");
  run(["checkout", "-q", "main"]);
  const back = mergeInto(d, "proposal/build-slice-2", "merge: slice 2 approved");
  assert.equal(back.ok, true, "the branch then merges into main with nothing left to reconcile");
  assert.equal(back.kept, undefined);
});

test("a branch merged into main keeps main's entry under its name and the branch's beside it", (t) => {
  const { d } = repo(t);
  const r = mergeInto(d, "proposal/build-slice-2", "merge: slice 2 approved");
  assert.equal(r.ok, true);
  assert.equal(read(d, "002-build.md"), "slice 1's build\n");
  assert.equal(read(d, "002-build-2.md"), "slice 2's build\n");
});

test("a conflict outside the journal is still reported, and nothing is merged", (t) => {
  const { d, run } = repo(t);
  run(["checkout", "-q", "proposal/build-slice-2"]);
  writeFileSync(join(d, "app.txt"), "two\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "app 2"]);
  run(["checkout", "-q", "main"]);
  writeFileSync(join(d, "app.txt"), "one\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "app 1"]);
  run(["checkout", "-q", "proposal/build-slice-2"]);
  const r = mergeInto(d, "main", "merge");
  assert.equal(r.ok, false);
  assert.ok(r.conflicts.includes("app.txt"));
  assert.equal(existsSync(join(d, ".sdlc", "journal", "002-build-2.md")), false);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: d, encoding: "utf8" }), "", "the merge was undone");
});

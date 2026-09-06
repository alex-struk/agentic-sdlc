import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { resolvePacks, installPacks, packUrl } from "../src/commands/packs.mjs";

function makePack() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-pack-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, "skills/engineering/tdd"), { recursive: true });
  writeFileSync(join(d, "skills/engineering/tdd/SKILL.md"), "---\nname: tdd\n---\n# tdd\n");
  mkdirSync(join(d, "skills/productivity/grilling"), { recursive: true });
  writeFileSync(join(d, "skills/productivity/grilling/SKILL.md"), "---\nname: grilling\n---\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "init"], d);
  return { dir: d, sha: git(["rev-parse", "HEAD"], d) };
}

function makeTwoCommitPack() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-pack-"));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, "skills/tdd"), { recursive: true });
  writeFileSync(join(d, "skills/tdd/SKILL.md"), "version: A\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "commit A"], d);
  const commitA = git(["rev-parse", "HEAD"], d);
  writeFileSync(join(d, "skills/tdd/SKILL.md"), "version: B\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "commit B"], d);
  return { dir: d, commitA };
}

test("packUrl maps owner/name to GitHub and leaves paths alone", () => {
  assert.equal(packUrl("mattpocock/skills"), "https://github.com/mattpocock/skills.git");
  assert.equal(packUrl("/tmp/x"), "/tmp/x");
  assert.equal(packUrl("https://example.org/a.git"), "https://example.org/a.git");
});

test("resolve pins a branch ref to a commit; install copies the named skills", () => {
  const { dir, sha } = makePack();
  const proj = mkdtempSync(join(tmpdir(), "sdlc-proj-"));
  const resolved = resolvePacks([{ repo: dir, ref: "main", skills: ["tdd", "grilling", "missing"] }], proj);
  assert.equal(resolved[0].commit, sha);
  const r = installPacks(proj, resolved);
  assert.ok(existsSync(join(proj, ".claude/skills/tdd/SKILL.md")));
  assert.ok(existsSync(join(proj, ".claude/skills/grilling/SKILL.md")));
  assert.ok(r.skipped.some((s) => s.includes("missing")));
  const again = installPacks(proj, resolved);
  assert.equal(again.installed.length, 0, "second install is a no-op");
});

test("pinned commit older than HEAD is checked out", () => {
  const { dir, commitA } = makeTwoCommitPack();
  const proj = mkdtempSync(join(tmpdir(), "sdlc-proj-"));
  const resolved = resolvePacks([{ repo: dir, ref: commitA, skills: ["tdd"] }], proj);
  assert.equal(resolved[0].commit, commitA);
  const r = installPacks(proj, resolved);
  assert.ok(r.installed.some((s) => s.includes("tdd")));
  const packCheckoutHead = git(["rev-parse", "HEAD"], join(proj, ".sdlc/packs", resolved[0].name));
  assert.equal(packCheckoutHead, commitA, "pack checkout HEAD matches pinned commit A");
  const skillContent = readFileSync(join(proj, ".claude/skills/tdd/SKILL.md"), "utf-8");
  assert.equal(skillContent, "version: A\n", "skill content is from commit A");
});

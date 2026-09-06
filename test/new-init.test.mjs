import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { init } from "../src/commands/init.mjs";
import { runChecks } from "../src/checks/index.mjs";

function makePack() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-pack-"));
  git(["init", "-q", "-b", "main"], d); git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, "skills/tdd"), { recursive: true }); writeFileSync(join(d, "skills/tdd/SKILL.md"), "---\nname: tdd\n---\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

test("new --from creates a project that passes the structural checks", async () => {
  // Isolate the egress check from the real machine's default names file, the same way
  // test/checks.test.mjs does: pointing SDLC_EGRESS_NAMES at an existing-but-empty file
  // wins the lookup outright, so ~/.config/agentic-sdlc/egress-names.txt is never consulted.
  // `init` may still create that real default file if it does not already exist (it writes
  // a fixed path, not the env var) — that is expected and nothing under $HOME is deleted here.
  const prevEgressNames = process.env.SDLC_EGRESS_NAMES;
  const egressDir = mkdtempSync(join(tmpdir(), "sdlc-egress-"));
  const emptyList = join(egressDir, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  try {
    const pack = makePack();
    const cfgPath = join(mkdtempSync(join(tmpdir(), "sdlc-cfg-")), "example.yaml");
    writeFileSync(cfgPath, `
pipeline: { repo: agentic-sdlc, ref: main }
profile: rebuild
stack: openshift-ts
project: { name: example-service, domains: [accounts, orders] }
sources:
  old: { repo: https://example.org/old.git, commit: 0123456789abcdef0123456789abcdef01234567 }
oracle: { target: old, compose: sources/old/docker-compose.yml, seed: tests/seed/, base_url: http://localhost:3000, identity: session-route }
targets: { new: { base_url: http://localhost:8080, identity: sandbox-idp } }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead, human_sample_per_week: 5 }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [ { repo: ${pack}, ref: main, skills: [tdd] } ] }
egress: { rules: [E-1, E-2, E-3, E-4] }
`);
    const dir = join(mkdtempSync(join(tmpdir(), "sdlc-new-")), "example-service");
    await newProject({ dir, from: cfgPath });
    assert.ok(existsSync(join(dir, ".sdlc/lock.json")));
    assert.ok(existsSync(join(dir, ".claude/skills/tdd/SKILL.md")));
    assert.ok(existsSync(join(dir, ".sdlc/hooks/implement-guard.sh")));
    assert.ok(existsSync(join(dir, ".github/workflows/sdlc-checkpoint.yml")));
    const spec = readFileSync(join(dir, "spec/spec.md"), "utf8");
    assert.match(spec, /## accounts/); assert.match(spec, /## orders/);
    assert.equal(git(["status", "--porcelain"], dir), "", "everything committed");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    const results = await runChecks(dir);
    const failing = results.filter((r) => !r.ok && r.id !== "constitution");
    assert.deepEqual(failing.map((r) => [r.id, r.messages]), []);
    // constitution still has {{placeholders}} for project articles: expected to fail until filled
    assert.equal(results.find((r) => r.id === "constitution").ok, false);

    // Re-running init on an unchanged project must be a no-op: no new commit, no dirty tree.
    const commitCountBefore = git(["rev-list", "--count", "HEAD"], dir);
    const second = await init(dir);
    assert.equal(git(["rev-list", "--count", "HEAD"], dir), commitCountBefore, "no new commit on an unchanged re-run");
    assert.equal(git(["status", "--porcelain"], dir), "", "tree stays clean on an unchanged re-run");
    assert.equal(second.changed, false);
  } finally {
    if (prevEgressNames === undefined) delete process.env.SDLC_EGRESS_NAMES;
    else process.env.SDLC_EGRESS_NAMES = prevEgressNames;
  }
});

function makeTwoCommitPack() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-pack2-"));
  git(["init", "-q", "-b", "main"], d); git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, "skills/tdd"), { recursive: true });
  writeFileSync(join(d, "skills/tdd/SKILL.md"), "version: A\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "commit A"], d);
  const commitA = git(["rev-parse", "HEAD"], d);
  writeFileSync(join(d, "skills/tdd/SKILL.md"), "version: B\n");
  git(["add", "."], d); git(["commit", "-q", "-m", "commit B"], d);
  return { dir: d, commitA, commitB: git(["rev-parse", "HEAD"], d) };
}

function projectConfig(packRepo, packRef) {
  return `
pipeline: { repo: agentic-sdlc, ref: main }
profile: rebuild
stack: openshift-ts
project: { name: example-service, domains: [accounts] }
targets: { new: { base_url: http://localhost:8080, identity: sandbox-idp } }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: tech-lead }
    G3: { holder: tech-lead }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [ { repo: ${packRepo}, ref: ${packRef}, skills: [tdd] } ] }
egress: { rules: [E-2] }
`;
}

test("init reinstalls a pack's skills when its pinned commit moves", async () => {
  const prevEgressNames = process.env.SDLC_EGRESS_NAMES;
  const egressDir = mkdtempSync(join(tmpdir(), "sdlc-egress-"));
  const emptyList = join(egressDir, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  try {
    const pack = makeTwoCommitPack();
    const cfgPath = join(mkdtempSync(join(tmpdir(), "sdlc-cfg-")), "example.yaml");
    writeFileSync(cfgPath, projectConfig(pack.dir, pack.commitA));
    const dir = join(mkdtempSync(join(tmpdir(), "sdlc-bump-")), "example-service");
    await newProject({ dir, from: cfgPath });
    const skill = join(dir, ".claude/skills/tdd/SKILL.md");
    assert.equal(readFileSync(skill, "utf8"), "version: A\n");

    writeFileSync(join(dir, ".sdlc/config.yaml"), projectConfig(pack.dir, pack.commitB));
    // `init` runs on a dirty tree by design, so it must stage only the files it owns:
    // an agent's scratch file sitting in the tree is not part of the init commit.
    writeFileSync(join(dir, "scratch.txt"), "an agent's working file\n");
    const second = await init(dir);
    assert.equal(second.changed, true, "a moved pack commit is a change");
    assert.equal(readFileSync(skill, "utf8"), "version: B\n", "the installed skill is refreshed to commit B");
    const committed = git(["show", "HEAD", "--name-only", "--format="], dir).split("\n").filter(Boolean);
    assert.ok(!committed.includes("scratch.txt"), "the scratch file is not in the init commit");
    assert.ok(!committed.includes(".sdlc/config.yaml"), "the edited config is not swept into the init commit");
    assert.match(git(["status", "--porcelain"], dir), /scratch\.txt/, "the scratch file is left untracked");
  } finally {
    if (prevEgressNames === undefined) delete process.env.SDLC_EGRESS_NAMES;
    else process.env.SDLC_EGRESS_NAMES = prevEgressNames;
  }
});

test("init leaves an unrelated, uncommitted .gitignore edit unstaged", async () => {
  // `changed` has to end up true for a reason that has nothing to do with the
  // .gitignore edit, so the commit path (which is what used to stage .gitignore
  // unconditionally) actually runs: a missing persona brief, exactly like
  // test/brownfield.test.mjs uses to force the same thing.
  const prevEgressNames = process.env.SDLC_EGRESS_NAMES;
  const egressDir = mkdtempSync(join(tmpdir(), "sdlc-egress-"));
  const emptyList = join(egressDir, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  try {
    const pack = makePack();
    const cfgPath = join(mkdtempSync(join(tmpdir(), "sdlc-cfg-")), "example.yaml");
    writeFileSync(cfgPath, projectConfig(pack, "main"));
    const dir = join(mkdtempSync(join(tmpdir(), "sdlc-gitignore-edit-")), "example-service");
    await newProject({ dir, from: cfgPath });

    // Force `changed: true` on the next init without touching anything staged by name
    // other than the persona directory it already owns.
    rmSync(join(dir, ".sdlc", "personas", "tech-lead.md"), { force: true });

    // A team's own, uncommitted edit to .gitignore — nothing reconcileGitignore would
    // ever rewrite (the required lines are already there, and this adds no `site/`
    // line), so it must be left exactly as the team left it even though this init call
    // does go on to make a real commit (the restored persona brief, above).
    const ignorePath = join(dir, ".gitignore");
    const ignoreBefore = readFileSync(ignorePath, "utf8");
    writeFileSync(ignorePath, `${ignoreBefore}scratch/\n`);

    const r = await init(dir);

    assert.equal(r.changed, true, "the restored persona brief is a real change");
    assert.ok(existsSync(join(dir, ".sdlc", "personas", "tech-lead.md")), "the persona brief is restored");
    assert.equal(readFileSync(ignorePath, "utf8"), `${ignoreBefore}scratch/\n`, "the edit is still there, uncommitted");
    // `git(...)` trims the whole of a porcelain line, including the leading status
    // character a purely-unstaged change carries (" M"), so the dirty/staged split is
    // checked with `diff` and `diff --cached` instead of a literal porcelain string.
    assert.equal(git(["diff", "--name-only"], dir), ".gitignore", "the only unstaged change is .gitignore");
    assert.equal(git(["diff", "--cached", "--name-only"], dir), "", "nothing is staged");
  } finally {
    if (prevEgressNames === undefined) delete process.env.SDLC_EGRESS_NAMES;
    else process.env.SDLC_EGRESS_NAMES = prevEgressNames;
  }
});

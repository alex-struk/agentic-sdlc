import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
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
  } finally {
    if (prevEgressNames === undefined) delete process.env.SDLC_EGRESS_NAMES;
    else process.env.SDLC_EGRESS_NAMES = prevEgressNames;
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { nextProposalName, stageFor } from "../src/stages/registry.mjs";

function repo(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-plan-revise-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const run = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]);
  writeFileSync(join(d, "README.md"), "x\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "start"]);
  return { d, run };
}

test("plan --revise starts from the returned plan and quotes its ruling", (t) => {
  const { d, run } = repo(t);
  run(["checkout", "-q", "-b", "proposal/plan"]);
  mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
  mkdirSync(join(d, ".sdlc", "proposals"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "proposals", "plan.md"), "---\ngate: G2\n---\n");
  writeFileSync(join(d, ".sdlc", "gates", "plan.yaml"),
    "gate: G2\nverdict: return\nby: agent:architect\nheld_by: agent\nrationale: the plan ignores the stack profile\nconditions:\n  - \"Adopt the openshift-ts stack profile\"\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "returned"]);
  run(["checkout", "-q", "main"]);
  const plan = stageFor("plan");
  const ctx = { revise: true, dryRun: true };
  const check = plan.preChecks(d, ctx).find((c) => c.id === "plan-revise-source");
  assert.equal(check.ok, true);
  assert.equal(ctx.revision.name, "plan");
  assert.deepEqual(plan.revisionOverlayPaths(ctx), ["plan", "docs/decisions"]);
  const prompt = plan.prompt(ctx);
  assert.match(prompt, /This is a revision/);
  assert.match(prompt, /the plan ignores the stack profile/);
  assert.match(prompt, /- Adopt the openshift-ts stack profile/);
});

// Recording the return on main is what spends the name: the revision's own proposal is
// numbered past it instead of colliding with the returned branch.
test("a recorded plan return makes the revision's proposal plan-2", (t) => {
  const { d, run } = repo(t);
  mkdirSync(join(d, ".sdlc", "gates"), { recursive: true });
  writeFileSync(join(d, ".sdlc", "gates", "plan.yaml"), "gate: G2\nverdict: return\n");
  run(["add", "-A"]); run(["-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "-m", "recorded"]);
  assert.equal(nextProposalName(d, "plan"), "plan-2");
});

test("plan --revise with nothing returned is refused", (t) => {
  const { d } = repo(t);
  const ctx = { revise: true, dryRun: true };
  const check = stageFor("plan").preChecks(d, ctx).find((c) => c.id === "plan-revise-source");
  assert.equal(check.ok, false);
  assert.match(check.messages[0], /no returned plan ruling/);
});

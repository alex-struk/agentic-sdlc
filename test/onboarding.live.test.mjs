import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newProject } from "../src/commands/new.mjs";
import { loadConfig } from "../src/config/load.mjs";

const BRIEF = `# Stakeholder brief: permit intake
We are building a new service called permit-intake. It has two areas: applications and fees.
It is greenfield. Deploy on OpenShift with the openshift-ts stack. The tech lead holds ratify, plan, review and policy;
the UX reviewer holds design; intent may be held by a product-owner agent escalating to the tech lead.
No source repository. Tests sign in through a sandbox identity provider at http://localhost:8080.
No extra skill packs.`;

test("onboarding interview against a written brief produces a valid config", { skip: process.env.SDLC_LIVE !== "1" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-live-"));
  const brief = join(root, "brief.md"); writeFileSync(brief, BRIEF);
  const dir = join(root, "permit-intake");
  await newProject({ dir, answers: brief });
  assert.ok(existsSync(join(dir, ".sdlc", "config.yaml")));
  const { config, errors } = loadConfig(join(dir, ".sdlc", "config.yaml"));
  assert.deepEqual(errors, []);
  assert.equal(config.profile, "greenfield");
  assert.deepEqual(config.project.domains, ["applications", "fees"]);
  assert.equal(config.policy.gates["G-DESIGN"].holder, "ux-reviewer");
});

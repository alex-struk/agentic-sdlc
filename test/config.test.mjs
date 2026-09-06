import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, loadConfig } from "../src/config/load.mjs";

const GOOD = `
pipeline: { repo: agentic-sdlc, ref: v0.1.0 }
profile: rebuild
stack: openshift-ts
project:
  name: example-service
  domains: [accounts, orders]
sources:
  old: { repo: https://example.org/old.git, commit: 0123456789abcdef0123456789abcdef01234567, docs: [README.md], exclude: [tests/] }
oracle: { target: old, compose: sources/old/docker-compose.yml, seed: tests/seed/, base_url: http://localhost:3000, identity: session-route }
targets:
  new: { base_url: http://localhost:8080, identity: sandbox-idp }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead, human_sample_per_week: 5 }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
  rungs: {}
  triage: { direct_max_files: 3, direct_allowed_paths: [app/] }
  budgets: { archaeology: 4000000, build: 3000000 }
skills:
  packs:
    - { repo: mattpocock/skills, ref: 0123456789abcdef0123456789abcdef01234567, skills: [grilling, tdd] }
  extra: []
egress:
  rules: [E-1, E-2, E-3, E-4]
`;

test("valid config has no errors", () => {
  const { config, errors } = parseConfig(GOOD);
  assert.deepEqual(errors, []);
  assert.equal(config.profile, "rebuild");
});

test("unknown key is an error", () => {
  const { errors } = parseConfig(GOOD + "\nextra_key: 1\n");
  assert.ok(errors.some((e) => e.includes("additional")), errors.join("\n"));
});

test("bad profile is an error", () => {
  const { errors } = parseConfig(GOOD.replace("profile: rebuild", "profile: bespoke"));
  assert.ok(errors.length > 0);
});

test("a person-looking holder is rejected: holders are roles or agent:persona", () => {
  const { errors } = parseConfig(GOOD.replace("G1: { holder: tech-lead }", "G1: { holder: jane.doe }"));
  assert.ok(errors.length > 0);
});

test("malformed YAML is an error, not a thrown exception", () => {
  const { config, errors } = parseConfig("project: { name: p, domains: [a }\n");
  assert.equal(config, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^config\.yaml is not valid YAML: /);
});

test("loadConfig reads a file and reports the same way parseConfig does", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-loadcfg-"));
  const good = join(d, "good.yaml"); writeFileSync(good, GOOD);
  assert.deepEqual(loadConfig(good).errors, []);
  assert.equal(loadConfig(good).config.project.name, "example-service");
  const bad = join(d, "bad.yaml"); writeFileSync(bad, "policy: { gates: [\n");
  const r = loadConfig(bad);
  assert.equal(r.config, null);
  assert.match(r.errors[0], /not valid YAML/);
});

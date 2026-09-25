import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, loadConfig } from "../src/config/load.mjs";
import { checkConfig } from "../src/checks/config.mjs";

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
  turns: { archaeology: 120, build: 400 }
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

// A budget the runner would ignore or reduce is worse than no budget: it reads as a cap a
// gate approved and a run honoured, and it is neither. A real run lost a whole gate cycle
// to this — a policy proposal raised a stage's budget to 1200, a persona approved it, and
// the stage then ran with the 40-turn default, because 1200 reads as a token budget. The
// refusal belongs in front of whoever proposes the number, not an hour into the stage it
// was meant to size.
test("checkConfig refuses a turn budget the runner would ignore or reduce", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-budget-"));
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  const write = (budgets) => writeFileSync(join(d, ".sdlc/config.yaml"),
    GOOD.replace("turns: { archaeology: 120, build: 400 }", `budgets: ${budgets}`));

  write("{ design: 1200 }");
  const tokenSized = checkConfig(d);
  assert.equal(tokenSized.ok, false);
  assert.match(tokenSized.messages.join("\n"), /policy\.budgets\.design is 1200[\s\S]*token budget[\s\S]*below 1000/);

  write("{ design: 999 }");
  assert.equal(checkConfig(d).ok, true, "the largest readable turn count passes");

  write("{ design: 400 }");
  assert.equal(checkConfig(d).ok, true, "a turn count inside the ceiling passes");
});

// Nothing in this repository writes `targets.<t>.depends_on`, and a key nothing writes is
// a key nobody fills. What reaches a project that already exists is the check: the
// configuration already says the target signs in through a provider the project stands up
// itself, which is the one shape `sandbox up` cannot settle from the application's own
// address.
test("checkConfig warns where a target signs in through a provider it never says how to reach, and does not fail on it", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-depends-"));
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  const write = (targets) => writeFileSync(join(d, ".sdlc/config.yaml"),
    GOOD.replace("  new: { base_url: http://localhost:8080, identity: sandbox-idp }", targets));

  write("  new: { base_url: http://localhost:8080, identity: sandbox-idp }");
  const bare = checkConfig(d);
  assert.equal(bare.ok, true, "the key is optional and a check that failed would make it mandatory");
  assert.match(bare.warnings.join("\n"), /targets\.new signs in through sandbox-idp and declares no targets\.new\.depends_on\.identity/);
  assert.match(bare.warnings.join("\n"), /without establishing that anything can sign in there/);

  write('  new: { base_url: http://localhost:8080, identity: sandbox-idp, depends_on: { identity: "http://localhost:8081/realms/sandbox" } }');
  assert.deepEqual(checkConfig(d).warnings, [], "a target that says where its provider answers is asked nothing");

  write("  new: { base_url: http://localhost:8080, identity: session-route }");
  assert.deepEqual(checkConfig(d).warnings, [], "a target that signs in through the application itself stands up no provider");
});

// Each limit the engine applies is a policy value with a default, and a value the engine
// could not act on is refused where it is written rather than where it is read.
const withPolicy = (lines) => GOOD.replace("  default_tier: STANDARD\n", `  default_tier: STANDARD\n${lines.map((l) => `  ${l}\n`).join("")}`);

test("policy.loops.verify_returns is a positive whole number", () => {
  assert.deepEqual(parseConfig(withPolicy(["loops: { verify_returns: 2 }"])).errors, []);
  assert.ok(parseConfig(withPolicy(["loops: { verify_returns: 0 }"])).errors.length > 0);
  assert.ok(parseConfig(withPolicy(["loops: { verify_retries: 2 }"])).errors.length > 0, "an unknown loop is an error");
});

test("policy.loops.ratify_follow_ups takes a positive max and one of two outcomes", () => {
  assert.deepEqual(parseConfig(withPolicy(["loops: { ratify_follow_ups: { max: 3, on_limit: obsolete } }"])).errors, []);
  assert.deepEqual(parseConfig(withPolicy(["loops: { ratify_follow_ups: { on_limit: escalate } }"])).errors, []);
  assert.ok(parseConfig(withPolicy(["loops: { ratify_follow_ups: { max: 0 } }"])).errors.length > 0);
  assert.ok(parseConfig(withPolicy(["loops: { ratify_follow_ups: { on_limit: ignore } }"])).errors.length > 0);
});

test("policy.retries.post_check_repair is a whole number, and zero is allowed", () => {
  assert.deepEqual(parseConfig(withPolicy(["retries: { post_check_repair: 0 }"])).errors, []);
  assert.deepEqual(parseConfig(withPolicy(["retries: { post_check_repair: 2 }"])).errors, []);
  assert.ok(parseConfig(withPolicy(["retries: { post_check_repair: -1 }"])).errors.length > 0);
});

// CRITICAL is a floor: a project may narrow which tiers force an escalation or block an
// unverified test, and may not take CRITICAL out of either.
test("policy.escalate_tiers and policy.provenance.block_unverified must keep CRITICAL", () => {
  assert.deepEqual(parseConfig(withPolicy(["escalate_tiers: [CRITICAL]"])).errors, []);
  assert.deepEqual(parseConfig(withPolicy(["escalate_tiers: [STANDARD, HIGH, CRITICAL]"])).errors, []);
  assert.ok(parseConfig(withPolicy(["escalate_tiers: [HIGH]"])).errors.length > 0);
  assert.ok(parseConfig(withPolicy(["escalate_tiers: []"])).errors.length > 0);
  assert.deepEqual(parseConfig(withPolicy(["provenance: { block_unverified: [CRITICAL] }"])).errors, []);
  assert.ok(parseConfig(withPolicy(["provenance: { block_unverified: [HIGH] }"])).errors.length > 0);
  assert.ok(parseConfig(withPolicy(["provenance: { block_unverified: [CRITICAL, URGENT] }"])).errors.length > 0);
});

test("policy.gates.G3.approve_unasserted is a boolean, and only G3 carries it", () => {
  const g3 = (extra) => GOOD.replace("G3: { holder: \"agent:reviewer\", escalate_to: tech-lead, human_sample_per_week: 5 }",
    `G3: { holder: "agent:reviewer", escalate_to: tech-lead, human_sample_per_week: 5${extra} }`);
  assert.deepEqual(parseConfig(g3(", approve_unasserted: false")).errors, []);
  assert.ok(parseConfig(g3(", approve_unasserted: sometimes")).errors.length > 0);
  assert.ok(parseConfig(GOOD.replace("G2: { holder: \"agent:architect\", escalate_to: tech-lead }",
    "G2: { holder: \"agent:architect\", escalate_to: tech-lead, approve_unasserted: false }")).errors.length > 0);
});

// `policy.budgets` is what existing projects carry, and they change their configuration only
// through a policy proposal, so it keeps working. It counts turns, and the key that says so
// is `policy.turns`.
test("policy.turns is a turn count per stage; policy.budgets still works and is reported as deprecated", () => {
  const turns = (value) => parseConfig(GOOD.replace("turns: { archaeology: 120, build: 400 }", `turns: ${value}`)).errors;
  assert.deepEqual(turns("{ design: 250, rule: 12 }"), []);
  assert.ok(turns("{ design: 1000 }").length > 0, "a turn count has the same ceiling as ever");
  assert.ok(turns("{ design: 0 }").length > 0);

  const d = mkdtempSync(join(tmpdir(), "sdlc-turns-"));
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), GOOD.replace("turns: { archaeology: 120, build: 400 }", "budgets: { archaeology: 120, build: 400 }"));
  const legacy = checkConfig(d);
  assert.equal(legacy.ok, true, legacy.messages.join("\n"));
  assert.ok(legacy.warnings.some((w) => /policy\.budgets is deprecated[\s\S]*policy\.turns/.test(w)), legacy.warnings.join("\n"));

  writeFileSync(join(d, ".sdlc/config.yaml"), GOOD);
  const current = checkConfig(d);
  assert.equal(current.ok, true, current.messages.join("\n"));
  assert.ok(!current.warnings.some((w) => /budgets/.test(w)), current.warnings.join("\n"));
});

// Two keys the schema accepts and nothing in the pipeline reads. A project that sets one
// believes it has configured something, so it is told it has not.
test("policy.triage and policy.rungs are reserved: accepted, and reported as doing nothing", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-reserved-"));
  mkdirSync(join(d, ".sdlc"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), withPolicy(["rungs: { LOW: merge }", "triage: { direct_max_files: 3 }"]));
  const r = checkConfig(d);
  assert.equal(r.ok, true, r.messages.join("\n"));
  assert.ok(r.warnings.some((w) => /policy\.triage is reserved/.test(w)), r.warnings.join("\n"));
  assert.ok(r.warnings.some((w) => /policy\.rungs is reserved/.test(w)), r.warnings.join("\n"));
  writeFileSync(join(d, ".sdlc/config.yaml"), GOOD);
  assert.ok(!checkConfig(d).warnings.some((w) => /reserved/.test(w)));
});

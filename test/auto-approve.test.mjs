// The runner approves a proposal from a stage the gate's `auto_approve` lists when every one of
// its checks holds, and asks the persona exactly as before when any of them does not
// (`docs/decisions/0105`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { propose } from "../src/commands/propose.mjs";
import { rule, ruleByAgentReported } from "../src/commands/rule.mjs";
import { parseConfig } from "../src/config/load.mjs";
import { checkConfigText } from "../src/checks/config.mjs";
import { collect } from "../src/site/model.mjs";
import { open as openOwed } from "../src/spec/owed.mjs";
import { recordReturnOnMain } from "../src/stages/proposals.mjs";
import { AUTO_APPROVE_STAGES } from "../src/config/policy.mjs";

const FROM = fileURLToPath(new URL("../fixture-project/fixture.config.yaml", import.meta.url));
const SCHEMA = JSON.parse(readFileSync(new URL("../schema/config.schema.json", import.meta.url), "utf8"));

const commit = (dir, message) => {
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", message], dir);
};

// A spec file asserting `n` things.
const spec = (n) => `import { test, expect } from "@playwright/test";\n\ntest("a criterion", async () => {\n${
  Array.from({ length: n }, (_, i) => `  expect(${i}).toBe(${i});`).join("\n")}\n});\n`;

const PASSING_TSC = "";
const FAILING_TSC = "process.stdout.write(\"acceptance/applications/age.spec.ts(1,1): error TS2304: Cannot find name 'x'.\\n\"); process.exit(2);\n";

// A project whose G1 and G3 are held by personas, with each gate's `auto_approve` as given, an
// acceptance spec and an adapter already on `main`, and a stand-in compiler the runner's
// typecheck runs. `tests/node_modules` is ignored by the project, so the compiler leaves the
// tree clean.
async function withProject({ g1 = "[contract]", g3 = "[derive-tests, bind-adapter]", tsc = PASSING_TSC } = {}, fn) {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-auto-approve-"));
  const prev = { egress: process.env.SDLC_EGRESS_NAMES, executor: process.env.SDLC_EXECUTOR, mock: process.env.SDLC_MOCK_DIR };
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  try {
    const dir = join(tmp, "permit-intake");
    await newProject({ dir, from: FROM });
    const c = join(dir, "constitution.md");
    writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
    const cfg = join(dir, ".sdlc/config.yaml");
    writeFileSync(cfg, readFileSync(cfg, "utf8")
      .replace(/^(\s+)G1: .*$/m, `$1G1: { holder: "agent:product-owner", escalate_to: tech-lead${g1 ? `, auto_approve: ${g1}` : ""} }`)
      .replace(/^(\s+)G3: .*$/m, `$1G3: { holder: "agent:reviewer", escalate_to: tech-lead, human_sample_per_week: 5${g3 ? `, auto_approve: ${g3}` : ""} }`));
    write(dir, "tests/acceptance/applications/age.spec.ts", spec(2));
    write(dir, "tests/adapters/new/index.ts", "export default function create() { return {}; }\n");
    commit(dir, "fixture");
    write(dir, "tests/node_modules/typescript/bin/tsc", tsc);
    process.env.SDLC_EXECUTOR = "mock";
    await fn(dir);
  } finally {
    for (const [key, value] of [["SDLC_EGRESS_NAMES", prev.egress], ["SDLC_EXECUTOR", prev.executor], ["SDLC_MOCK_DIR", prev.mock]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

// Opens `proposal/<name>` at `gate` carrying `files`: a path to its new text, or `null` to
// delete it.
function proposeFiles(dir, name, gate, files) {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, path));
    else write(dir, path, text);
  }
  propose(dir, name, { gate, question: "Is this right?", recommendation: "Yes.", paths: Object.keys(files) });
  git(["checkout", "-q", "main"], dir);
}

// No canned reply: a persona turn asked for here throws, which is how a test knows none was.
function noPersona() {
  process.env.SDLC_MOCK_DIR = mkdtempSync(join(tmpdir(), "sdlc-mock-none-"));
}

// A canned persona approval, so a ruling that asks the persona finishes and says who ruled.
function personaApproves() {
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-rule-"));
  writeFileSync(join(mockDir, "rule.json"), JSON.stringify({
    text: `Read it.\n\n\`\`\`json\n${JSON.stringify({ verdict: "approve", rationale: "the persona read it and approves", conditions: [] })}\n\`\`\``,
  }));
  process.env.SDLC_MOCK_DIR = mockDir;
}

async function ruled(dir, name, persona) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let r;
  try { r = await ruleByAgentReported(dir, name, persona); } finally { console.log = orig; }
  return { r, out: lines.join("\n"), gate: parseYaml(git(["show", `main:.sdlc/gates/${name}.yaml`], dir)) };
}

async function assertPersonaAsked(dir, name, persona) {
  personaApproves();
  const { r, gate } = await ruled(dir, name, persona);
  assert.equal(r.verdict, "approve");
  assert.equal(gate.by, `agent:${persona}`, "the persona ruled, not the runner");
  assert.match(gate.rationale, /the persona read it and approves/);
}

test("auto_approve: a listed stage whose checks all hold is approved by the runner with no persona turn", async () => {
  await withProject({}, async (dir) => {
    proposeFiles(dir, "derive-tests-applications", "G3", {
      "tests/acceptance/applications/age.spec.ts": spec(3),
      "tests/acceptance/applications/fee.spec.ts": spec(1),
    });
    const short = git(["rev-parse", "--short", "proposal/derive-tests-applications"], dir);
    noPersona();
    const { r, out, gate } = await ruled(dir, "derive-tests-applications", "reviewer");
    assert.equal(r.verdict, "approve");
    assert.equal(r.escalated, false);
    assert.equal(gate.verdict, "approve");
    assert.equal(gate.by, "runner:checks");
    assert.equal(gate.held_by, "agent", "the auto-approval sits in the agent seat");
    assert.equal(gate.cost, 0);
    assert.equal(gate.turns, 0);
    assert.equal(gate.session, "");
    assert.deepEqual(gate.conditions, []);
    assert.match(gate.rationale, /^Approved by the runner's checks, which policy\.gates\.G3\.auto_approve lets settle derive-tests proposals: /);
    assert.ok(gate.rationale.includes(`the acceptance typecheck of ${short} is clean`), gate.rationale);
    assert.match(gate.rationale, /no condition is open against it/);
    assert.match(gate.rationale, /no test file was deleted, no changed test asserts less than before and no new test asserts nothing/);

    // Recorded as any approval is: merged onto main, the ruling on the proposal page, a clean tree.
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.equal(git(["log", "-1", "--format=%s", "main"], dir), "merge: derive-tests-applications approved at G3 by runner:checks");
    assert.equal(git(["show", "main:tests/acceptance/applications/fee.spec.ts"], dir), spec(1).trimEnd());
    const page = git(["show", "main:.sdlc/proposals/derive-tests-applications.md"], dir);
    assert.match(page, /## Ruling\n\n\*\*Verdict:\*\* approve\n\*\*By:\*\* runner:checks/);
    assert.match(page, /Runner-owned typecheck evidence/);

    // Printed the way every ruling is, plus the line saying who approved it.
    assert.match(out, /^derive-tests-applications: approve at G3$/m);
    assert.match(out, /^ {2}approved by the runner's checks under policy\.gates\.G3\.auto_approve; no persona turn was run$/m);

    // And sampled for a person to read back, as the persona's approval would have been.
    const model = collect(dir);
    const row = model.gates.find((g) => g.name === "derive-tests-applications");
    assert.ok(model.sampled.has(row), "a runner:checks approval in an agent-held seat counts toward human_sample_per_week");
  });
});

test("auto_approve: a contract proposal that only adds lines is approved by the runner", async () => {
  await withProject({}, async (dir) => {
    const surface = readFileSync(join(dir, "spec/contract/surface.yaml"), "utf8");
    proposeFiles(dir, "contract-v1", "G1", { "spec/contract/surface.yaml": `${surface}# one more line\n` });
    noPersona();
    const { gate } = await ruled(dir, "contract-v1", "product-owner");
    assert.equal(gate.by, "runner:checks");
    assert.match(gate.rationale, /policy\.gates\.G1\.auto_approve lets settle contract proposals/);
    assert.match(gate.rationale, /no line under spec\/contract was deleted/);
  });
});

test("auto_approve: a binding that changes only what bind-adapter delivers is approved by the runner", async () => {
  await withProject({}, async (dir) => {
    proposeFiles(dir, "bind-adapter-new", "G3", { "tests/adapters/new/index.ts": "export default function create() { return { a: 1 }; }\n" });
    noPersona();
    const { gate } = await ruled(dir, "bind-adapter-new", "reviewer");
    assert.equal(gate.by, "runner:checks");
    assert.match(gate.rationale, /nothing outside tests\/adapters changed/);
  });
});

test("auto_approve: a stage the gate does not list is ruled by the persona", async () => {
  await withProject({ g3: "[bind-adapter]" }, async (dir) => {
    proposeFiles(dir, "derive-tests-applications", "G3", { "tests/acceptance/applications/age.spec.ts": spec(3) });
    await assertPersonaAsked(dir, "derive-tests-applications", "reviewer");
  });
});

test("auto_approve: a typecheck that did not pass leaves the ruling to the persona", async () => {
  await withProject({ tsc: FAILING_TSC }, async (dir) => {
    proposeFiles(dir, "derive-tests-applications", "G3", { "tests/acceptance/applications/age.spec.ts": spec(3) });
    await assertPersonaAsked(dir, "derive-tests-applications", "reviewer");
  });
});

test("auto_approve: a condition open against the stage leaves the ruling to the persona", async () => {
  await withProject({}, async (dir) => {
    openOwed(dir, "condition", [{
      ref: "derive-tests-fees#1", text: "assert the fee is recalculated", from: "derive-tests-fees", family: "derive-tests-fees",
      gate: "G3", stage: "derive-tests", by: "agent:reviewer", at: new Date().toISOString(),
    }]);
    commit(dir, "an open condition");
    proposeFiles(dir, "derive-tests-applications", "G3", { "tests/acceptance/applications/age.spec.ts": spec(3) });
    await assertPersonaAsked(dir, "derive-tests-applications", "reviewer");
  });
});

// What a binding or a derivation is routinely sent to do is not an instruction it answers to a
// ruler for: an unbound row verify filed and a test a criterion's new version asks to be derived
// again are each measured by the next verify, not judged at the gate.
test("auto_approve: a binding sent for an unbound row is still approved by the runner", async () => {
  await withProject({}, async (dir) => {
    openOwed(dir, "rebind", [{ id: "applications.age", target: "new", why: "unbound: applications.age — not bound", found: "unbound", by: "runner:verify", at: new Date().toISOString() }]);
    commit(dir, "an unbound row");
    proposeFiles(dir, "bind-adapter-new", "G3", { "tests/adapters/new/index.ts": "export default function create() { return { a: 1 }; }\n" });
    noPersona();
    const { gate } = await ruled(dir, "bind-adapter-new", "reviewer");
    assert.equal(gate.by, "runner:checks");
  });
});

test("auto_approve: a derivation sent to derive a test again is still approved by the runner", async () => {
  await withProject({}, async (dir) => {
    openOwed(dir, "redo", [{ id: "R-1.1", version: 2, why: "the criterion's wording changed", by: "runner", at: new Date().toISOString() }]);
    commit(dir, "a test to derive again");
    proposeFiles(dir, "derive-tests-applications", "G3", { "tests/acceptance/applications/age.spec.ts": spec(3) });
    noPersona();
    const { gate } = await ruled(dir, "derive-tests-applications", "reviewer");
    assert.equal(gate.by, "runner:checks");
  });
});

test("auto_approve: a new test that asserts nothing leaves the ruling to the persona", async () => {
  await withProject({}, async (dir) => {
    proposeFiles(dir, "derive-tests-applications", "G3", { "tests/acceptance/applications/fee.spec.ts": spec(0) });
    await assertPersonaAsked(dir, "derive-tests-applications", "reviewer");
  });
});

// A run that takes up a ruler's revision request marks it taken before its proposal is ruled, so
// the request is no longer open when the ruling comes; the proposal that took it is still the
// answer to a ruler, and a ruler says whether it was answered.
test("auto_approve: a proposal that took up a ruler's revision request is ruled by the persona", async () => {
  await withProject({}, async (dir) => {
    const at = new Date().toISOString();
    write(dir, ".sdlc/revision-requests.yaml", `requests:\n  - stage: bind-adapter\n    target: new\n    why: "read the status after the page renders it"\n    from: build-slice-1\n    gate: G3\n    by: agent:reviewer\n    at: ${at}\n    taken: ${at}\n    taken_by: bind-adapter-new\n`);
    commit(dir, "a request taken up");
    proposeFiles(dir, "bind-adapter-new", "G3", { "tests/adapters/new/index.ts": "export default function create() { return { a: 1 }; }\n" });
    await assertPersonaAsked(dir, "bind-adapter-new", "reviewer");
  });
});

test("auto_approve: a revision of a returned proposal is ruled by the persona", async () => {
  await withProject({}, async (dir) => {
    proposeFiles(dir, "derive-tests-applications", "G3", { "tests/acceptance/applications/age.spec.ts": spec(3) });
    rule(dir, "derive-tests-applications", "return", { by: "tech-lead", note: "derive it again" });
    git(["checkout", "-q", "main"], dir);
    recordReturnOnMain(dir, { name: "derive-tests-applications", branch: "proposal/derive-tests-applications" }, { gate: "G3", keepBranch: true });
    proposeFiles(dir, "derive-tests-applications-2", "G3", { "tests/acceptance/applications/age.spec.ts": spec(4) });
    await assertPersonaAsked(dir, "derive-tests-applications-2", "reviewer");
  });
});

test("auto_approve: a changed spec with fewer expect( calls leaves the ruling to the persona", async () => {
  await withProject({}, async (dir) => {
    proposeFiles(dir, "derive-tests-applications", "G3", { "tests/acceptance/applications/age.spec.ts": spec(1) });
    await assertPersonaAsked(dir, "derive-tests-applications", "reviewer");
  });
});

test("auto_approve: a deleted acceptance file leaves the ruling to the persona", async () => {
  await withProject({}, async (dir) => {
    proposeFiles(dir, "derive-tests-applications", "G3", {
      "tests/acceptance/applications/age.spec.ts": null,
      "tests/acceptance/applications/fee.spec.ts": spec(5),
    });
    await assertPersonaAsked(dir, "derive-tests-applications", "reviewer");
  });
});

test("auto_approve: a contract proposal that deletes a line leaves the ruling to the persona", async () => {
  await withProject({}, async (dir) => {
    const surface = readFileSync(join(dir, "spec/contract/surface.yaml"), "utf8");
    const lines = surface.split("\n");
    proposeFiles(dir, "contract-v1", "G1", { "spec/contract/surface.yaml": `${lines.slice(1).join("\n")}# one more line\n` });
    await assertPersonaAsked(dir, "contract-v1", "product-owner");
  });
});

test("auto_approve: a binding that changes a path bind-adapter does not deliver leaves the ruling to the persona", async () => {
  await withProject({}, async (dir) => {
    proposeFiles(dir, "bind-adapter-new", "G3", {
      "tests/adapters/new/index.ts": "export default function create() { return { a: 1 }; }\n",
      "tests/acceptance/applications/age.spec.ts": spec(3),
    });
    await assertPersonaAsked(dir, "bind-adapter-new", "reviewer");
  });
});

test("auto_approve: a standing escalation leaves the ruling to the persona", async () => {
  await withProject({}, async (dir) => {
    proposeFiles(dir, "derive-tests-applications", "G3", { "tests/acceptance/applications/age.spec.ts": spec(3) });
    git(["checkout", "-q", "proposal/derive-tests-applications"], dir);
    write(dir, ".sdlc/gates/derive-tests-applications.yaml",
      "gate: G3\nverdict: escalated\nby: agent:reviewer\nheld_by: agent\nescalate_to: tech-lead\nrationale: |2-\n  unsure\n");
    commit(dir, "an escalation");
    git(["checkout", "-q", "main"], dir);
    await assertPersonaAsked(dir, "derive-tests-applications", "reviewer");
  });
});

const GATES = (g1, g3) => [
  "pipeline: { repo: agentic-sdlc, ref: main }",
  "profile: greenfield",
  "stack: openshift-ts",
  "project: { name: example, domains: [one] }",
  "policy:",
  "  gates:",
  "    G0: { holder: \"agent:product-owner\", escalate_to: tech-lead }",
  `    G1: ${g1}`,
  "    G-DESIGN: { holder: ux-reviewer }",
  "    G2: { holder: \"agent:architect\", escalate_to: tech-lead }",
  `    G3: ${g3}`,
  "    G-POL: { holder: tech-lead }",
  "  default_tier: STANDARD",
  "skills: { packs: [] }",
  "egress: { rules: [E-1, E-2, E-3, E-4] }",
  "",
].join("\n");

test("auto_approve: config validation refuses a stage the runner cannot approve, and names the ones it can", () => {
  const agentG1 = "{ holder: \"agent:product-owner\", escalate_to: tech-lead }";
  const g3 = (list) => `{ holder: "agent:reviewer", escalate_to: tech-lead, auto_approve: ${list} }`;
  assert.deepEqual(parseConfig(GATES(agentG1, g3("[derive-tests, bind-adapter]"))).errors, []);
  const errors = parseConfig(GATES(agentG1, g3("[derive-tests, verify]"))).errors;
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /^\/policy\/gates\/G3\/auto_approve\/1: /);
  for (const stage of AUTO_APPROVE_STAGES) assert.ok(errors[0].includes(stage), errors[0]);
  assert.deepEqual(SCHEMA.definitions.gate.properties.auto_approve.items.enum, [...AUTO_APPROVE_STAGES]);
});

test("auto_approve: a list that would apply to nothing fails the config check", () => {
  const personG1 = "{ holder: tech-lead, auto_approve: [contract] }";
  const g3 = "{ holder: \"agent:reviewer\", escalate_to: tech-lead, auto_approve: [contract] }";
  const r = checkConfigText(GATES(personG1, g3));
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => /policy\.gates\.G1\.auto_approve is set, but G1 is held by tech-lead/.test(m)), r.messages.join("\n"));
  assert.ok(r.messages.some((m) => /policy\.gates\.G3\.auto_approve names contract, whose proposals are ruled at G1/.test(m)), r.messages.join("\n"));
  const ok = checkConfigText(GATES("{ holder: \"agent:product-owner\", escalate_to: tech-lead, auto_approve: [contract] }",
    "{ holder: \"agent:reviewer\", escalate_to: tech-lead, auto_approve: [derive-tests, bind-adapter] }"));
  assert.deepEqual(ok.messages.filter((m) => /auto_approve/.test(m)), []);
});

// test/policy-set.test.mjs — `sdlc policy set`: a policy change proposed at G-POL.
//
// The command edits the `policy` block of `main`'s `.sdlc/config.yaml`, keeps the rest of
// the file as it was written, refuses anything the schema or the config check refuses, and
// opens the change as a proposal at G-POL, where `rule` seats it by `main`'s policy (`0043`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { git, gitOk } from "../src/lib/git.mjs";
import { policySet } from "../src/commands/policy.mjs";
import { rule, ruleByAgent } from "../src/commands/rule.mjs";
import { main } from "../src/cli.mjs";

const CONFIG = `pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: sample, domains: [alpha] }
# Who holds each gate, and every limit the engine applies.
policy:
  default_tier: STANDARD # assumed where a proposal names none
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: "agent:product-owner", escalate_to: tech-lead }
    G-DESIGN: { holder: "agent:product-owner", escalate_to: tech-lead }
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead }
    G-POL: { holder: tech-lead, escalate_to: delivery-lead }
  loops: { verify_returns: 3 }
skills: { packs: [] }
egress: { rules: [E-2] }
`;

const ASK = { question: "Should this project's agents run on another backend?", recommendation: "Yes." };

function project(t) {
  const d = mkdtempSync(join(tmpdir(), "sdlc-policy-set-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(["init", "-q", "-b", "main"], d);
  git(["config", "user.email", "t@example.org"], d);
  git(["config", "user.name", "t"], d);
  mkdirSync(join(d, ".sdlc", "personas"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), CONFIG);
  writeFileSync(join(d, ".gitattributes"), ".sdlc/runs/*.md merge=union\n");
  for (const p of ["product-owner", "architect", "reviewer", "tech-lead"]) writeFileSync(join(d, `.sdlc/personas/${p}.md`), `# Persona: ${p}\n\nRules.\n`);
  git(["add", "-A"], d);
  git(["commit", "-q", "-m", "init"], d);
  return d;
}

// Everything a command could have changed in the repository: where HEAD is, what the tree
// holds and which branches exist.
function snapshot(d) {
  return [git(["rev-parse", "HEAD"], d), git(["status", "--porcelain"], d), git(["for-each-ref", "refs/heads"], d)].join("\n");
}

const branchConfig = (d, name) => git(["show", `proposal/${name}:.sdlc/config.yaml`], d);

test("a key outside policy is refused, naming what may be changed", (t) => {
  const d = project(t);
  const before = snapshot(d);
  assert.throws(() => policySet(d, { set: ["project.name=other"], ...ASK }), /project is not under policy[\s\S]*agents/);
  assert.throws(() => policySet(d, { set: ["targets.new.base_url=http://host.invalid"], ...ASK }), /targets is not under policy/);
  assert.throws(() => policySet(d, { set: ["policy=x"], ...ASK }), /a key under policy/);
  assert.equal(snapshot(d), before);
});

test("a key may be written with or without its policy prefix, and values are read as YAML", (t) => {
  const d = project(t);
  const r = policySet(d, { set: ["policy.loops.verify_returns=5", "agents.stages.build={ backend: codex, egress: registry }", "gates.G3.holder=tech-lead"], ...ASK });
  const policy = parse(branchConfig(d, r.name)).policy;
  assert.equal(policy.loops.verify_returns, 5);
  assert.deepEqual(policy.agents.stages.build, { backend: "codex", egress: "registry" });
  assert.equal(policy.gates.G3.holder, "tech-lead");
  assert.equal(policy.gates.G3.escalate_to, "tech-lead", "a sibling of an edited key is left as it was");
});

test("the rest of the file keeps its comments and its layout", (t) => {
  const d = project(t);
  const r = policySet(d, { set: ["agents.backend=codex", "default_tier=HIGH"], ...ASK });
  const text = branchConfig(d, r.name);
  assert.match(text, /^# Who holds each gate, and every limit the engine applies\.$/m);
  assert.match(text, /^  default_tier: HIGH # assumed where a proposal names none$/m, "a replaced value keeps its comment");
  assert.match(text, /^    G2: \{ holder: "agent:architect", escalate_to: tech-lead \}$/m);
  assert.match(text, /^pipeline: \{ repo: agentic-sdlc, ref: main \}$/m);
  assert.match(text, /^  agents:\n    backend: codex$/m);
});

test("a line the change does not touch is written exactly as it was, however the library would write it", (t) => {
  const d = project(t);
  writeFileSync(join(d, ".sdlc/config.yaml"), CONFIG.replace("project: { name: sample, domains: [alpha] }", "project:\n  name: sample\n  domains: [alpha, beta]"));
  git(["commit", "-q", "-am", "two domains"], d);
  const r = policySet(d, { set: ["agents.backend=codex"], dryRun: true, ...ASK });
  assert.deepEqual(r.diff.split("\n").filter((l) => /^[+-][^+-]/.test(l)), ["+  agents:", "+    backend: codex"]);
});

test("a proposal opens at G-POL with the changed config as its one path, and main is untouched", (t) => {
  const d = project(t);
  const mainBefore = git(["rev-parse", "main"], d);
  const r = policySet(d, { set: ["agents.backend=codex"], ...ASK });
  assert.equal(r.name, "policy-agents-backend");
  assert.equal(r.branch, "proposal/policy-agents-backend");
  assert.equal(git(["rev-parse", "main"], d), mainBefore);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  assert.equal(git(["status", "--porcelain"], d), "");
  const changed = git(["diff", "--name-only", "main", r.branch], d).split("\n").filter((p) => !p.startsWith(".sdlc/runs/"));
  assert.deepEqual(changed.sort(), [".sdlc/config.yaml", ".sdlc/proposals/policy-agents-backend.md"]);
  const page = git(["show", `${r.branch}:.sdlc/proposals/policy-agents-backend.md`], d);
  assert.match(page, /^gate: G-POL$/m);
  assert.match(page, /^# Should this project's agents run on another backend\?$/m);
  assert.match(page, /\| `policy\.agents\.backend` \| \*not set\* \| `codex` \|/);
  assert.match(page, /```diff\n[\s\S]*\+  agents:\n\+    backend: codex\n[\s\S]*```/);
});

test("an unset removes the key, and a map it leaves empty goes with it", (t) => {
  const d = project(t);
  const r = policySet(d, { unset: ["loops.verify_returns"], ...ASK });
  const policy = parse(branchConfig(d, r.name)).policy;
  assert.equal(policy.loops, undefined);
  assert.match(git(["show", `${r.branch}:.sdlc/proposals/${r.name}.md`], d), /\| `policy\.loops\.verify_returns` \| `3` \| \*not set\* \|/);
  assert.throws(() => policySet(d, { unset: ["turns.build"], ...ASK }), /policy\.turns\.build is not set on main/);
});

test("a change the schema refuses opens nothing", (t) => {
  const d = project(t);
  const before = snapshot(d);
  assert.throws(() => policySet(d, { set: ["agents.backend=nonesuch"], ...ASK }), /refused[\s\S]*\/policy\/agents\/backend/);
  assert.throws(() => policySet(d, { unset: ["gates.G3"], ...ASK }), /refused[\s\S]*G3/);
  assert.equal(snapshot(d), before);
});

test("a change the config check refuses opens nothing", (t) => {
  const d = project(t);
  const before = snapshot(d);
  assert.throws(() => policySet(d, { set: ["agents.stages.nonesuch.backend=codex"], ...ASK }), /policy\.agents\.stages\.nonesuch names no stage/);
  assert.throws(() => policySet(d, { set: ["agents.stages.build.egress=mirror"], ...ASK }), /egress is mirror, which no allowlist defines/);
  assert.equal(snapshot(d), before);
});

test("an edit that changes nothing, or edits that overlap, are refused", (t) => {
  const d = project(t);
  const before = snapshot(d);
  assert.throws(() => policySet(d, { set: ["default_tier=STANDARD"], ...ASK }), /policy\.default_tier is already STANDARD on main/);
  assert.throws(() => policySet(d, { set: ["agents={ backend: codex }", "agents.model=m"], ...ASK }), /policy\.agents and policy\.agents\.model overlap/);
  assert.throws(() => policySet(d, { set: ["agents.backend=codex"], unset: ["agents.backend"], ...ASK }), /overlap/);
  assert.throws(() => policySet(d, { set: ["agents.backend="], ...ASK }), /no value[\s\S]*--unset/);
  assert.throws(() => policySet(d, { set: ["agents.backend"], ...ASK }), /<key>=<value>/);
  assert.throws(() => policySet(d, { set: [], ...ASK }), /at least one/);
  assert.throws(() => policySet(d, { set: ["agents.backend=codex"], question: "q" }), /--question and --recommendation/);
  assert.equal(snapshot(d), before);
});

test("a name already used is refused when given, and the default name moves past it", (t) => {
  const d = project(t);
  const first = policySet(d, { set: ["agents.backend=codex"], ...ASK });
  assert.equal(first.name, "policy-agents-backend");
  const second = policySet(d, { set: ["agents.backend=codex"], ...ASK });
  assert.equal(second.name, "policy-agents-backend-2");
  const before = snapshot(d);
  assert.throws(() => policySet(d, { set: ["agents.backend=codex"], name: "policy-agents-backend", ...ASK }), /proposal policy-agents-backend already exists/);
  assert.throws(() => policySet(d, { set: ["agents.backend=codex"], name: "Not A Name", ...ASK }), /proposal name/);
  assert.equal(snapshot(d), before);
});

test("the working tree must be clean and on main", (t) => {
  const d = project(t);
  writeFileSync(join(d, "stray.txt"), "x\n");
  assert.throws(() => policySet(d, { set: ["agents.backend=codex"], ...ASK }), /uncommitted changes[\s\S]*stray\.txt/);
  rmSync(join(d, "stray.txt"));
  git(["checkout", "-q", "-b", "elsewhere"], d);
  assert.throws(() => policySet(d, { set: ["agents.backend=codex"], ...ASK }), /must start on main; you are on elsewhere/);
});

test("a dry run returns the page and the diff and writes nothing", (t) => {
  const d = project(t);
  const before = snapshot(d);
  const r = policySet(d, { set: ["agents.backend=codex"], dryRun: true, ...ASK });
  assert.equal(r.dryRun, true);
  assert.equal(r.name, "policy-agents-backend");
  assert.match(r.page, /^gate: G-POL$/m);
  assert.match(r.diff, /^\+  agents:$/m);
  assert.equal(snapshot(d), before);
  assert.equal(gitOk(["rev-parse", "--verify", "--quiet", "refs/heads/proposal/policy-agents-backend"], d), false);
});

test("approved by the G-POL holder, the change is merged and main's config carries it", (t) => {
  const d = project(t);
  const r = policySet(d, { set: ["agents.backend=codex", "agents.stages.bind-adapter.backend=claude"], ...ASK });
  assert.throws(() => rule(d, r.name, "approve", { by: "architect", note: "fine" }), /architect is not a holder of G-POL/);
  const ruled = rule(d, r.name, "approve", { by: "tech-lead", note: "move the work" });
  assert.equal(ruled.verdict, "approve");
  const policy = parse(git(["show", "main:.sdlc/config.yaml"], d)).policy;
  assert.equal(policy.agents.backend, "codex");
  assert.equal(policy.agents.stages["bind-adapter"].backend, "claude");
});

test("a seat that holds another gate cannot rule a policy change, from either seat", async (t) => {
  const d = project(t);
  const r = policySet(d, { set: ["gates.G-POL.holder=agent:architect"], ...ASK });
  const mock = mkdtempSync(join(tmpdir(), "sdlc-policy-set-mock-"));
  t.after(() => { rmSync(mock, { recursive: true, force: true }); delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR; });
  writeFileSync(join(mock, "rule.json"), JSON.stringify({ text: "```json\n" + JSON.stringify({ verdict: "approve", rationale: "it holds", conditions: [] }) + "\n```" }));
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mock;
  await assert.rejects(() => ruleByAgent(d, r.name, { persona: "architect" }), /agent:architect is not a holder of G-POL/);
  assert.throws(() => rule(d, r.name, "approve", { by: "architect", note: "fine" }), /architect is not a holder of G-POL/);
  assert.equal(parse(git(["show", "main:.sdlc/config.yaml"], d)).policy.gates["G-POL"].holder, "tech-lead");
});

test("the command line takes the first edit positionally and the rest as --set and --unset", async (t) => {
  const d = project(t);
  const cwd = process.cwd();
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    process.chdir(d);
    const before = snapshot(d);
    assert.equal(await main(["policy", "set", "agents.backend=codex", "--set", "agents.stages.build.backend=claude",
      "--unset", "loops.verify_returns", "--question", ASK.question, "--recommendation", ASK.recommendation, "--dry-run"]), 0);
    assert.equal(snapshot(d), before);
    assert.match(lines.join("\n"), /dry run: would open proposal\/policy-agents-backend at G-POL/);
    assert.match(lines.join("\n"), /^-  loops: \{ verify_returns: 3 \}$/m);
    assert.equal(await main(["policy", "nonesuch"]), 1);
  } finally { console.log = log; process.chdir(cwd); }
});

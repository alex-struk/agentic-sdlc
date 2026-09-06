import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { propose } from "../src/commands/propose.mjs";
import { rule } from "../src/commands/rule.mjs";
import { newProject } from "../src/commands/new.mjs";

const CONFIG = `
pipeline: { repo: agentic-sdlc, ref: main }
profile: greenfield
stack: openshift-ts
project: { name: p, domains: [a] }
policy:
  gates:
    G0: { holder: "agent:product-owner", escalate_to: tech-lead }
    G1: { holder: tech-lead }
    G-DESIGN: { holder: ux-reviewer }
    G2: { holder: tech-lead }
    G3: { holder: tech-lead }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;

function project() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-gate-"));
  git(["init", "-q", "-b", "main"], d); git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, ".sdlc"), { recursive: true }); writeFileSync(join(d, ".sdlc/config.yaml"), CONFIG);
  // `rule` builds the state site after every ruling; it is generated output, not
  // something these fixtures track, so it is ignored the same way templates/project's
  // own .gitignore ignores it in a real project.
  writeFileSync(join(d, ".gitignore"), "site/\n");
  writeFileSync(join(d, "README.md"), "x"); git(["add", "-A"], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

test("propose then approve merges into main with a gate record", () => {
  const d = project();
  const { branch } = propose(d, "harness-ready", { gate: "G1", question: "Is the harness ready?", recommendation: "Yes." });
  assert.equal(branch, "proposal/harness-ready");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), branch);
  assert.throws(() => rule(d, "harness-ready", "approve", { by: "ux-reviewer" }), /not a holder/);
  rule(d, "harness-ready", "approve", { by: "tech-lead", note: "checks green" });
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  assert.ok(existsSync(join(d, ".sdlc/gates/harness-ready.yaml")));
  assert.match(readFileSync(join(d, ".sdlc/gates/harness-ready.yaml"), "utf8"), /verdict: approve/);
  assert.match(git(["log", "--oneline", "-3"], d), /harness-ready/);
});

test("return keeps the branch open and records the verdict", () => {
  const d = project();
  propose(d, "plan-v1", { gate: "G2", question: "Sound?", recommendation: "No." });
  rule(d, "plan-v1", "return", { by: "tech-lead", note: "criterion R-1.2 unassigned" });
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "proposal/plan-v1");
  assert.match(readFileSync(join(d, ".sdlc/gates/plan-v1.yaml"), "utf8"), /verdict: return/);
});

test("an agent-held gate records held_by agent and can escalate to the human", () => {
  const d = project();
  propose(d, "intent-1", { gate: "G0", question: "Right problem?", recommendation: "Yes." });
  rule(d, "intent-1", "approve", { by: "agent:product-owner", note: "rationale…" });
  assert.match(readFileSync(join(d, ".sdlc/gates/intent-1.yaml"), "utf8"), /held_by: agent/);
  const d2 = project();
  propose(d2, "intent-2", { gate: "G0", question: "?", recommendation: "?" });
  rule(d2, "intent-2", "approve", { by: "tech-lead" });
  assert.match(readFileSync(join(d2, ".sdlc/gates/intent-2.yaml"), "utf8"), /held_by: human/);
});

test("propose leaves the working tree clean and commits the run record on its own branch", () => {
  const d = project();
  propose(d, "clean-tree", { gate: "G1", question: "Clean?", recommendation: "Yes." });
  assert.equal(git(["status", "--porcelain"], d), "");
  const files = git(["log", "-1", "--name-only"], d);
  assert.match(files, /\.sdlc\/runs\//);
});

test("rule approve leaves main's working tree clean", () => {
  const d = project();
  propose(d, "clean-main", { gate: "G1", question: "Clean?", recommendation: "Yes." });
  rule(d, "clean-main", "approve", { by: "tech-lead" });
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  assert.equal(git(["status", "--porcelain"], d), "");
});

test("two proposals in sequence keep separate run-record entries in their own commits", () => {
  const d = project();
  propose(d, "first-one", { gate: "G1", question: "First?", recommendation: "Yes." });
  propose(d, "second-one", { gate: "G2", question: "Second?", recommendation: "Yes." });
  const added = git(["show", "HEAD", "--format=", "--", ".sdlc/runs/"], d);
  const addedLines = added.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  assert.ok(addedLines.some((l) => l.includes("second-one")));
  assert.ok(!addedLines.some((l) => l.includes("first-one")));
});

test("propose refuses a dirty working tree and names what is dirty", () => {
  const d = project();
  writeFileSync(join(d, "scratch-note.txt"), "half-finished work\n");
  assert.throws(() => propose(d, "dirty-tree", { gate: "G1", question: "?", recommendation: "?" }),
    (e) => /uncommitted changes/.test(e.message) && e.message.includes("scratch-note.txt"));
  // Nothing was started: no branch, and the scratch file is untouched.
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  assert.equal(readFileSync(join(d, "scratch-note.txt"), "utf8"), "half-finished work\n");
});

test("the proposal commit contains the proposal and the run record and nothing else", () => {
  const d = project();
  writeFileSync(join(d, ".gitignore"), "scratch.txt\n");
  git(["add", "-A"], d); git(["commit", "-q", "-m", "ignore scratch"], d);
  writeFileSync(join(d, "scratch.txt"), "an agent's working file\n");
  propose(d, "only-mine", { gate: "G1", question: "?", recommendation: "?" });
  const files = git(["show", "HEAD", "--name-only", "--format="], d).split("\n").filter(Boolean).sort();
  assert.deepEqual(files.filter((f) => !f.startsWith(".sdlc/runs/")), [".sdlc/proposals/only-mine.md"]);
  assert.ok(files.some((f) => f.startsWith(".sdlc/runs/")));
  assert.ok(!files.includes("scratch.txt"));
});

test("rule refuses a dirty working tree", () => {
  const d = project();
  propose(d, "ruled-clean", { gate: "G1", question: "?", recommendation: "?" });
  writeFileSync(join(d, "scratch-note.txt"), "x\n");
  assert.throws(() => rule(d, "ruled-clean", "approve", { by: "tech-lead" }),
    (e) => /uncommitted changes/.test(e.message) && e.message.includes("scratch-note.txt"));
});

test("propose rejects a gate the policy does not define", () => {
  const d = project();
  assert.throws(() => propose(d, "bad-gate", { gate: "G9", question: "?", recommendation: "?" }), /gate G9 is not in policy/);
  assert.equal(git(["branch", "--list", "proposal/bad-gate"], d), "", "no branch is left behind");
});

test("two proposals opened the same day both merge into main", async () => {
  // Both proposals append to the same dated run record, so the second merge is a
  // content conflict on a file where both sides are right. `.gitattributes` marks
  // .sdlc/runs/*.md as merge=union, and `init` installs it.
  const prevEgressNames = process.env.SDLC_EGRESS_NAMES;
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-sameday-"));
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  try {
    const cfgPath = join(tmp, "example.yaml");
    writeFileSync(cfgPath, CONFIG);
    const d = join(tmp, "same-day");
    await newProject({ dir: d, from: cfgPath });
    assert.ok(existsSync(join(d, ".gitattributes")), "init installs the merge attribute");

    propose(d, "first-gate", { gate: "G1", question: "First?", recommendation: "Yes." });
    propose(d, "second-gate", { gate: "G2", question: "Second?", recommendation: "Yes." });
    rule(d, "first-gate", "approve", { by: "tech-lead" });
    rule(d, "second-gate", "approve", { by: "tech-lead" });

    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
    assert.equal(git(["status", "--porcelain"], d), "", "main is not left mid-merge");
    assert.ok(existsSync(join(d, ".sdlc/gates/first-gate.yaml")));
    assert.ok(existsSync(join(d, ".sdlc/gates/second-gate.yaml")));
    const day = new Date().toISOString().slice(0, 10);
    const runs = readFileSync(join(d, `.sdlc/runs/${day}.md`), "utf8");
    assert.ok(runs.includes("first-gate"), "the run record keeps the first proposal's lines");
    assert.ok(runs.includes("second-gate"), "the run record keeps the second proposal's lines");
  } finally {
    if (prevEgressNames === undefined) delete process.env.SDLC_EGRESS_NAMES;
    else process.env.SDLC_EGRESS_NAMES = prevEgressNames;
  }
});

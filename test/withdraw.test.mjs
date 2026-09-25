// test/withdraw.test.mjs — `sdlc withdraw`: setting aside a proposal that is neither approved
// nor returned, without a ruling on what it asks, recorded and from either seat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { git, SDLC_AUTHOR_NAME } from "../src/lib/git.mjs";
import { propose } from "../src/commands/propose.mjs";
import { rule } from "../src/commands/rule.mjs";
import { withdraw } from "../src/commands/withdraw.mjs";
import { followUpState } from "../src/stages/shared.mjs";
import { whatNext, formatNext } from "../src/runner/next.mjs";

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
    G2: { holder: "agent:architect", escalate_to: tech-lead }
    G3: { holder: "agent:reviewer", escalate_to: tech-lead }
    G-POL: { holder: tech-lead }
  default_tier: STANDARD
skills: { packs: [] }
egress: { rules: [E-2] }
`;

function project() {
  const d = mkdtempSync(join(tmpdir(), "sdlc-withdraw-"));
  git(["init", "-q", "-b", "main"], d); git(["config", "user.email", "t@example.org"], d); git(["config", "user.name", "t"], d);
  mkdirSync(join(d, ".sdlc"), { recursive: true }); writeFileSync(join(d, ".sdlc/config.yaml"), CONFIG);
  writeFileSync(join(d, ".gitignore"), ".sdlc/*.local.txt\n");
  writeFileSync(join(d, "README.md"), "x"); git(["add", "-A"], d); git(["commit", "-q", "-m", "init"], d);
  return d;
}

const NAME = "widgets-triage-3";

function openOne(d) {
  return propose(d, NAME, { gate: "G3", question: "Which failures are the harness's?", recommendation: "Sort each." });
}

test("a withdrawn proposal is recorded on its branch and on main, says who and why, and is no longer open", () => {
  const d = project();
  const { branch } = openOne(d);
  const r = withdraw(d, NAME, { by: "tech-lead", reason: "its rows came from a run whose target could not be reset" });
  assert.equal(r.gate, "G3");

  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  assert.equal(git(["status", "--porcelain"], d), "");
  const onMain = readFileSync(join(d, `.sdlc/gates/${NAME}.yaml`), "utf8");
  const doc = parseYaml(onMain);
  assert.equal(doc.verdict, "withdrawn");
  assert.equal(doc.gate, "G3");
  assert.equal(doc.by, "tech-lead");
  assert.equal(doc.held_by, "human");
  assert.match(doc.note, /could not be reset/);
  assert.ok(!("conditions" in doc), "a withdrawal answers nothing the proposal asked");
  // The same record on the branch, which is where every reader of an open proposal looks.
  assert.equal(git(["show", `${branch}:.sdlc/gates/${NAME}.yaml`], d), onMain.trimEnd());

  // Not open, and its number is still taken.
  assert.deepEqual(followUpState(d, "widgets-triage"), { open: null, highest: 3 });
  assert.ok(!formatNext(whatNext(d)).includes(NAME), formatNext(whatNext(d)));

  // Recorded as the pipeline's own act, with the line in the run record.
  assert.equal(git(["log", "-1", "--pretty=%an", "main"], d), SDLC_AUTHOR_NAME);
  assert.equal(git(["log", "-1", "--pretty=%an", branch], d), SDLC_AUTHOR_NAME);
  const day = new Date().toISOString().slice(0, 10);
  assert.match(readFileSync(join(d, `.sdlc/runs/${day}.md`), "utf8"), new RegExp(`withdraw ${NAME} at G3 by tech-lead: its rows came from`));
});

test("the agent seat withdraws through the same check as a person, and a seat that does not hold the gate is refused", () => {
  const d = project();
  openOne(d);
  assert.throws(() => withdraw(d, NAME, { by: "agent:architect", reason: "x" }), /not a holder of G3/);
  assert.throws(() => withdraw(d, NAME, { by: "ux-reviewer", reason: "x" }), /not a holder of G3/);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], d), "main");
  withdraw(d, NAME, { by: "agent:reviewer", reason: "superseded by a fresh calibration" });
  assert.equal(parseYaml(readFileSync(join(d, `.sdlc/gates/${NAME}.yaml`), "utf8")).held_by, "agent");
});

test("withdraw refuses a proposal already ruled, one with no reason, and one that does not exist", () => {
  const d = project();
  openOne(d);
  assert.throws(() => withdraw(d, NAME, { by: "tech-lead", reason: "  " }), /reason/);
  assert.throws(() => withdraw(d, "no-such-thing-1", { by: "tech-lead", reason: "x" }), /no proposal branch/);
  rule(d, NAME, "return", { by: "tech-lead", note: "sort them again" });
  git(["checkout", "-q", "main"], d);
  assert.throws(() => withdraw(d, NAME, { by: "tech-lead", reason: "x" }), /already ruled: return/);
});

test("a local path in the reason is scrubbed before it is written", () => {
  const d = project();
  openOne(d);
  const elsewhere = `/${"home"}/someone`;
  withdraw(d, NAME, { by: "tech-lead", reason: `see ${elsewhere}/notes/why.txt` });
  const doc = parseYaml(readFileSync(join(d, `.sdlc/gates/${NAME}.yaml`), "utf8"));
  assert.ok(!doc.note.includes(elsewhere), doc.note);
});

test("sdlc withdraw is wired to the command line, and a missing reason exits non-zero", () => {
  const d = project();
  openOne(d);
  const bin = new URL("../bin/sdlc.mjs", import.meta.url).pathname;
  const refused = spawnSync(process.execPath, [bin, "withdraw", NAME, "--by", "tech-lead"], { cwd: d, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--reason/);
  const done = spawnSync(process.execPath, [bin, "withdraw", NAME, "--by", "tech-lead", "--reason", "superseded"], { cwd: d, encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, new RegExp(`${NAME}: withdrawn at G3 by tech-lead`));
});

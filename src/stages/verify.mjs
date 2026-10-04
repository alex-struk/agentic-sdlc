// `verify --slice N`: run the acceptance tests for the criteria one slice claims against
// the application its open build proposal contains, and record what happened on that
// proposal's own branch (spec §5.11). Deterministic: no agent turn, like `calibrate`.
//
// A slice that passes is ready for G3; the reviewer's ruling is refused without this result
// (src/commands/rule.mjs). A slice that fails is returned by the runner itself, through the
// same gate file a ruling writes, so `build --slice N --revise` picks the failures up the
// way `design --revise` picks up a returned design. The return that reaches the project's
// limit (`policy.loops.verify_returns`, three by default) escalates to G3's escalation
// target instead: a slice that fails that many builds running is usually failing for a
// reason another build will not fix (spec §7.1).
import { basename, join, relative } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { writeText } from "../lib/fsx.mjs";
import { redactLocalPaths } from "../lib/redact.mjs";
import { git, gitOk, stagePaths, enterBranch, leaveBranch, mergeInto, SDLC_AUTHOR } from "../lib/git.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { emptyReadOf, runSuite } from "../testrun/playwright.mjs";
import { caseOf, casesPhrase, failureMessage, failuresOf, quotedList, stoppedAt, FAILURES_DESCRIBED } from "../testrun/failures.mjs";
import { resetCommandFor, targetSettings, APPLICATION } from "../sandbox/local.mjs";
import { sandboxUp, sandboxDown } from "../commands/sandbox.mjs";
import { readSlice, buildProposals, buildProposalBase, openBuildProposal, specFilesFor } from "./slices.mjs";
import { checkSandboxPassword, escapeRe, skillPath } from "./shared.mjs";
import { ADDRESSED_CONDITION_FORM, OVERREACH_CONDITION_FORM } from "../spec/criteria.mjs";
import { isNotAsserted, notAssertedEntries, environmentGap, MAIL_CATCHER_UNSET_RE } from "../testrun/results.mjs";
import { verifyReturnLimit, owedLoopLimit } from "../config/policy.mjs";
import { readConfigurations } from "../oracle/configurations.mjs";
import { taggedSpecFiles } from "../testrun/tags.mjs";
import { adapterAt, syncUnbound, unavailableOn, personaUnavailable, withdrawUnclaimed } from "../spec/unbound.mjs";
import { isOpen, read as readOwed } from "../spec/owed.mjs";

// Five outcomes, because a slice's claims come apart five ways and a reader has to be able
// to tell them apart. `fail` is a criterion exercised against the application and not met,
// and it is the only one the builder is answerable for. `environment` is a criterion this
// environment could not test at all: its test reads a mail catcher the target does not
// declare, or it is written for a configuration verify cannot start the target in
// (`configured`, criterion to reason). `unbound` is a criterion the adapter could not drive.
// `pass` is reserved for the slice whose every claimed criterion was put to the running
// application and met — the one outcome the trailer's universal is true of.
// `pass-unasserted` is the slice where nothing failed and something was never asserted
// against the application at all: a `not-testable` criterion the contract surface offers no
// way to exercise, or an `attested` one somebody vouched for in place of a test. That slice
// reaches its gate exactly as it did before, and it says what it is on the way
// (`docs/decisions/0033-a-criterion-nobody-asserted.md`, `0075`).
export function verifyVerdict(rows, criteria, { configured = new Map() } = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const failing = [];
  const unbound = [];
  const environment = [];
  for (const id of criteria) {
    const r = byId.get(id);
    const configuration = configured.get(id);
    if (!r) {
      if (configuration) environment.push({ id, reason: configuration });
      else failing.push({ id, result: "missing", tests: [] });
    } else if (r.result === "unbound") unbound.push(id);
    else if (isNotAsserted(r)) continue;
    else if (r.result === "pass") {
      // The tests in the file that were not written for the configuration passed; the ones
      // that were never ran.
      if (configuration) environment.push({ id, reason: configuration });
    } else {
      const gap = environmentGap(r);
      if (gap) environment.push({ id, reason: gap });
      else failing.push(r);
    }
  }
  const unasserted = notAssertedEntries(rows, criteria);
  const verdict = failing.length ? "fail"
    : environment.length ? "environment"
      : unbound.length ? "unbound"
        : unasserted.length ? "pass-unasserted" : "pass";
  return { verdict, failing, unbound, environment, unasserted };
}

// What the slices already approved established, to be checked again. Each approved slice's
// verify result is on main, and every criterion it passed then is a criterion a later build
// can break without any criterion of its own saying so. Only what passed counts: a criterion
// an earlier slice never passed is owed where it already is, and is not a later build's to
// answer. A criterion this slice claims is judged as its own and is left out here.
// Returns criterion id -> the slice whose approval it passed under.
export function earlierPasses(projectDir, sliceNumber, own = []) {
  const dir = join(projectDir, "tests", "results", "new");
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const m = /^slice-(\d+)\.json$/.exec(f);
    if (!m || Number(m[1]) === sliceNumber) continue;
    let result;
    try { result = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    for (const r of result.rows ?? []) {
      if (r?.result === "pass" && !own.includes(r.id) && !out.has(r.id)) out.set(r.id, Number(m[1]));
    }
  }
  return out;
}

// How each earlier criterion came out this time. One that fails is a regression and returns
// the build. One the run could not exercise — no row, unbound, written for a configuration,
// or stopped by the environment — says nothing about the application and is reported apart.
export function recheckEarlier(rows, earlier, configured = new Map()) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const regressed = [];
  const held = [];
  const unexercised = [];
  for (const [id, slice] of earlier) {
    const r = byId.get(id);
    const configuration = configured.get(id);
    if (configuration) unexercised.push({ id, slice, why: configuration });
    else if (!r) unexercised.push({ id, slice, why: "no test of it ran" });
    else if (r.result === "pass") held.push(id);
    else if (r.result === "unbound") unexercised.push({ id, slice, why: "the adapter could not drive it" });
    else if (isNotAsserted(r)) unexercised.push({ id, slice, why: r.result });
    else if (environmentGap(r)) unexercised.push({ id, slice, why: environmentGap(r) });
    else regressed.push({ id, slice, row: r });
  }
  return { regressed, held, unexercised };
}

const criteriaWord = (n) => (n === 1 ? "criterion" : "criteria");

// The criteria among `files` whose tests are written for one of the contract's
// configurations, each with why verify leaves them out, and the tags that leave them out.
// A configuration's tests run only against an instance started in it, and nothing starts the
// new target's sandbox in one (`docs/decisions/0071-a-configuration-gets-its-own-oracle.md`),
// so the ordinary run leaves them out and the criteria are reported as untested here rather
// than as failures of the build.
export function configuredCriteria(projectDir, files) {
  const { configurations } = readConfigurations(projectDir);
  const wanted = new Set(files);
  const configured = new Map();
  for (const c of configurations) {
    for (const f of taggedSpecFiles(projectDir, c.tag)) {
      if (!wanted.has(f)) continue;
      configured.set(basename(f).replace(/\.spec\.ts$/, ""),
        `its test is written for configuration ${c.name} (${c.tag}), which the target reads at start-up, and verify cannot start the new target in a configuration`);
    }
  }
  return { configured, tags: configurations.map((c) => c.tag) };
}

// What a slice is told about the criteria this environment could not test. None of it is
// the builder's, so none of it is a condition of a return, and the remedy is named by
// cause: a mail catcher is one line of configuration, and a configuration is a ruler's call.
function environmentLines(slice, environment) {
  if (!environment.length) return [];
  const mail = environment.some((e) => /mail catcher/.test(e.reason));
  const configuration = environment.some((e) => /configuration/.test(e.reason));
  return [
    `${environment.length} of the criteria this slice claims could not be tested in this environment, which is not the build's to fix; nothing about ${environment.length === 1 ? "it" : "them"} is recorded against the build or counted toward the verify return limit:`,
    ...environment.map((e) => `  ${e.id}: ${e.reason}`),
    ...(mail ? [`A test that reads a mail catcher needs targets.new.mail_api in .sdlc/config.yaml: the address the application's own compose file publishes its mail catcher's API on. Set it, then sdlc run verify --slice ${slice}.`] : []),
    ...(configuration ? ["A test written for a configuration runs only against an instance started in it, and verify cannot start the new target in a configuration (docs/decisions/0071-a-configuration-gets-its-own-oracle.md). Whether the slice can be ruled without it is the G3 ruler's to decide."] : []),
  ];
}

// What a slice is told about the unbound rows a binding run is owed for. The adapter may have
// been bound before this slice built what the tests need — against the application it
// replaces, or an earlier cut of this one — so a binding run against the application this
// proposal carries is what can close them, and the verify after it says whether it did.
function owedBindingLines(slice, branch, owed, claimed) {
  return [
    `${owed.length} ${owed.length === 1 ? "criterion" : "criteria"} could not be exercised because the adapter reports what ${owed.length === 1 ? "its test needs" : "their tests need"} as unbound. That is the adapter's gap, not the build's, so ${owed.length === 1 ? "it is" : "each is"} owed to bind-adapter --target new (tests/adapters/rebind.yaml) and nothing about ${owed.length === 1 ? "it" : "them"} is recorded against the build:`,
    ...unboundReasons(claimed, owed).map(({ id, reason }) => `  ${id}: ${reason}`),
    `The application the binding needs is on ${branch} and nowhere else until that proposal is ruled, so bind against it from there. From main, with a clean tree:`,
    `  1. sdlc sandbox up --target new --from ${branch}`,
    "  2. sdlc run bind-adapter --target new",
    "  3. rule the bind-adapter proposal at G3, which puts the adapter on main",
    `  4. sdlc sandbox down --target new --from ${branch}`,
    `  5. sdlc run verify --slice ${slice}`,
    "Step 5 closes each row the new binding reaches. A row still unbound is sent to the binding again until policy.loops.rebind is spent, and then comes to this proposal's ruler.",
  ];
}

const plural = (n, one, many) => (n === 1 ? one : many);

// What a slice is told when nothing failed and something was never asserted. The count and
// the ids are in the first line, which is the line the run record keeps and the line a
// caller reads; the reasons follow, one per criterion, because they are the only account of
// why the application was never asked and they exist nowhere else in the run's output. The
// last line says the gate is still reachable, since that is the question the reader has by
// then and the answer is not the one the paragraph above it suggests.
export function unassertedText({ slice, proposal, criteria, unasserted }) {
  const asserted = criteria - unasserted.length;
  const n = unasserted.length;
  return [
    `verify slice ${slice}: ${asserted} of the ${criteria} criteria this slice claims ${plural(asserted, "passes", "pass")} against the application in ${proposal}; the other ${n} ${plural(n, "was", "were")} never asserted against it at all — ${unasserted.map((u) => u.id).join(", ")}.`,
    `Nothing is established about ${plural(n, "it", "them")} in either direction. Each carries its own recorded reason:`,
    ...unasserted.map((u) => `  ${u.id} (${u.result}): ${u.reason}`),
    `Slice ${slice} is ready for G3 on the strength of the ${asserted} that ${plural(asserted, "was", "were")} asserted. Whether it may be approved with ${n} that nobody asserted is the ruling's to make, and the ruler is shown these same rows and reasons.`,
  ].join("\n");
}

// `bind-adapter` throws `unbound: <page>.<member> — <reason>` from any member it could
// not bind, and the suite carries that text through to the row (`src/testrun/playwright.mjs`).
// It is the adapter's own account of what the application does not provide, and the only
// place in the pipeline where that reason is written down, so an unbound verdict quotes it
// rather than describing it.
const UNBOUND_LINE = /^(?:Error: )?unbound: (.*)$/m;

export function unboundReasons(rows, ids) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const reason = (byId.get(id)?.tests ?? [])
      .map((t) => UNBOUND_LINE.exec(t.error ?? "")?.[1]?.trim())
      .find(Boolean);
    return { id, reason: reason || "the adapter gave no reason" };
  });
}

// Whether this target has an adapter at all. Read off the file the suite itself imports
// rather than matched in the unbound text: a target with no adapter is reported unbound
// through a reason `runSuite` writes for it, and a target whose adapter ran and found
// nothing to bind is reported unbound through a reason the adapter wrote. The two call for
// opposite remedies, and the file either exists or it does not.
function adapterExists(projectDir, target) {
  return existsSync(join(projectDir, "tests", "adapters", target, "index.ts"));
}

// A failed test as the builder is given it: its message, which says what the running application
// did (`failureMessage`). The builder never sees the test (`build.mjs`), so without that a
// condition reads `expect(received).toBeFalsy()` and names nothing it can find in the application.
//
// After it comes the place the test stopped: `at tests/acceptance/<domain>/<file>:<line>`, the
// first frame inside the spec file. Several assertions in one test can each read "Received:
// ''", and the line is what says which one failed. A place is not the test's code, so the
// builder is still never shown the test. The path is the row's own, relative to the project,
// and only the line is taken from the stack. The cap is applied to what comes before it, so
// truncation never cuts the place off.
const MAX_FAILURE_TEXT = 400;

function failureText(r, t) {
  const text = failureMessage(t);
  const where = failedAt(r, t);
  const room = MAX_FAILURE_TEXT - where.length;
  return `${text.length > room ? `${text.slice(0, room - 1)}…` : text}${where}${stepsClause(t)}${evidenceClause(t)}`;
}

// A criterion's first failure, as the result file records a criterion an earlier slice passed.
function firstError(r) {
  if (r.result === "missing") return "no acceptance test ran for this criterion";
  if (r.result === "stale") return "its test was written for an older version of the criterion";
  return failureText(r, (r.tests ?? []).find((x) => x.error));
}

// The conditions a failing criterion goes back with: one for each different way its tests failed,
// naming the cases that failed that way (`docs/decisions/0094`). Each is a fix of its own, and a
// failure left out would only be found by the next verify. Past the first few, the rest are named
// by their cases, so one criterion cannot crowd out the others.
function conditionsFor(r, label = r.id) {
  const failures = r.result === "missing" || r.result === "stale" ? [] : failuresOf(r);
  if (!failures.length) return [`${label}: ${firstError(r)}`];
  const described = failures.slice(0, FAILURES_DESCRIBED).map((tests) => {
    const phrase = casesPhrase(r, tests);
    return `${label}${phrase ? `, ${phrase}` : ""}: ${failureText(r, tests[0])}`;
  });
  const rest = failures.slice(FAILURES_DESCRIBED).flat();
  if (rest.length) {
    described.push(`${label}: ${rest.length} more ${rest.length === 1 ? "case" : "cases"} failed, not described here: ${quotedList(rest.map((t) => caseOf(r, t)))}`);
  }
  return described;
}

// ` — its last steps: <step> → <step>` for a failed test the harness recorded steps for: each
// a member of the contract's surface, what it was given, the page it ended on and what it read
// there or threw. The contract is the builder's to read, so naming its members shows the
// builder nothing of the test; what it adds is where the test was when it stopped and what the
// application put in front of it (`docs/decisions/0091`). The last few are enough to place the
// failure, and the clause is capped on its own so it never crowds out the error.
const STEPS_SHOWN = 4;
const MAX_STEPS_TEXT = 600;

export function stepText(s) {
  const outcome = s.threw ? ` threw ${JSON.stringify(s.threw)}` : s.read !== undefined ? ` read ${s.read}` : "";
  return `${s.step}(${s.given ?? ""})${s.at ? ` at ${s.at}` : ""}${outcome}`;
}

function stepsClause(t) {
  const steps = (t?.steps ?? []).slice(-STEPS_SHOWN);
  if (!steps.length) return "";
  const text = steps.map(stepText).join(" → ");
  return ` — its last steps: ${text.length > MAX_STEPS_TEXT ? `…${text.slice(text.length - MAX_STEPS_TEXT + 1)}` : text}`;
}

// ` — the page: <picture>, <outline>` where verify kept them (`keepEvidence`). Paths inside the
// project, to files git ignores: they are on the machine the slice is being built on, and a
// reader elsewhere has the steps without them.
function evidenceClause(t) {
  const parts = [t?.screen, t?.outline].filter(Boolean);
  return parts.length ? ` — the page as it failed: ${parts.join(", ")}` : "";
}

// Where verify keeps what failing tests left behind for one slice (`docs/decisions/0091`).
export function evidenceDir(slice) {
  return `.sdlc/evidence/slice-${slice}`;
}

const FAILED_STATUSES = new Set(["failed", "timedOut", "interrupted"]);

// Whatever an earlier verify of the slice kept is removed before the suite runs: evidence is
// about the application this run measures.
function clearEvidence(projectDir, slice) {
  rmSync(join(projectDir, evidenceDir(slice)), { recursive: true, force: true });
}

// Copies each failing test's picture and outline, which the suite runner left on this machine,
// into the slice's evidence folder, and records their paths on the test. Called after each run
// of the suite, before the next: Playwright empties its own output folder when it starts.
// Nothing is written to a folder git does not ignore, where it would stop the next command that
// needs a clean tree; the steps still travel without it.
function keepEvidence(projectDir, slice, rows) {
  const rel = evidenceDir(slice);
  if (!gitOk(["check-ignore", "-q", `${rel}/probe.png`], projectDir)) return;
  const taken = (stem) => existsSync(join(projectDir, `${stem}.png`)) || existsSync(join(projectDir, `${stem}.txt`));
  for (const row of rows) {
    for (const t of row.tests ?? []) {
      const ev = t.evidence;
      if (!ev || !FAILED_STATUSES.has(t.status)) continue;
      const id = String(row.id ?? basename(String(row.file ?? "test"), ".spec.ts")).replace(/[^A-Za-z0-9._-]/g, "_");
      let k = 1;
      while (taken(`${rel}/${id}${k > 1 ? `-${k}` : ""}`)) k += 1;
      const stem = `${rel}/${id}${k > 1 ? `-${k}` : ""}`;
      mkdirSync(join(projectDir, rel), { recursive: true });
      if (ev.screen && existsSync(ev.screen)) { copyFileSync(ev.screen, join(projectDir, `${stem}.png`)); t.screen = `${stem}.png`; }
      if (ev.outline) { writeText(join(projectDir, `${stem}.txt`), redactLocalPaths(ev.outline, projectDir)); t.outline = `${stem}.txt`; }
    }
  }
}

// Whether a failed row has a failure only a look at the page can place: one of its tests stopped
// after a read that came back with nothing (`emptyReadOf`).
function readNothing(r) {
  return (r?.tests ?? []).some((x) => x.error && emptyReadOf(x));
}

// ` — at <file>:<line>` for a failed test, or nothing where the line is not known or the row's
// file is not a path inside the project.
function failedAt(r, t) {
  const file = String(r.file ?? "");
  if (!file.startsWith("tests/acceptance/") || file.includes("..")) return "";
  const line = stoppedAt(r, t);
  return line ? ` — at ${file}:${line}` : "";
}

// Every proposal name this slice's build has ever gone under — wherever its gate file
// lives now, not only under `proposal/*`. `build --revise`'s own pre-check
// (`recordReturnOnMain`, `src/stages/proposals.mjs`) copies a returned gate onto `main`
// and renames the spent branch to `returned/<name>` once it has read the return off it, so
// by the time a later verify run asks this question, an earlier return's gate file is no
// longer under `proposal/<name>` at all — only on `main` and on `returned/<name>`.
// Counting just `proposal/*` (as an earlier version of this did) undercounts every return
// that has already been revised from, which makes the return limit unreachable: three
// real fail-then-revise cycles would report `return` every time and never `escalated`.
// Names are de-duplicated (the same name can carry an identical gate copy on both `main`
// and `returned/<name>` at once) rather than counted once per place it is found.
function buildProposalFamily(projectDir, slice) {
  const base = buildProposalBase(slice);
  const re = new RegExp(`^${escapeRe(base)}(?:-(\\d+))?$`);
  const names = new Set(buildProposals(projectDir, slice));
  const refs = gitOk(["for-each-ref", "--format=%(refname:short)", `refs/heads/returned/${base}*`], projectDir)
    ? git(["for-each-ref", "--format=%(refname:short)", `refs/heads/returned/${base}*`], projectDir).split("\n").filter(Boolean)
    : [];
  for (const ref of refs) {
    const short = ref.slice("returned/".length);
    if (re.test(short)) names.add(short);
  }
  const gatesDir = join(projectDir, ".sdlc", "gates");
  if (existsSync(gatesDir)) {
    for (const f of readdirSync(gatesDir)) {
      const m = /^(.+)\.yaml$/.exec(f);
      if (m && re.test(m[1])) names.add(m[1]);
    }
  }
  return names;
}

// A named proposal's gate file, read from whichever of the three places it actually lives:
// still open on its own branch, renamed to `returned/<name>` once `build --revise` has
// read it, or copied onto `main` by that same rename. At most one of these ever holds it
// (the branch case and the `main` case are mutually exclusive with the renamed case), so
// the first match wins.
function verifyReturnGate(projectDir, name) {
  for (const ref of [`proposal/${name}`, `returned/${name}`, "main"]) {
    if (!gitOk(["cat-file", "-e", `${ref}:.sdlc/gates/${name}.yaml`], projectDir)) continue;
    try { return parseYaml(git(["show", `${ref}:.sdlc/gates/${name}.yaml`], projectDir)); }
    catch { return null; }
  }
  return null;
}

// How many times this slice's build has already been returned by verify itself —
// `by: "runner:verify"` is what tells its own return apart from a reviewer's, whose
// return must never count toward this escalation threshold.
//
// A return whose every condition is an environment gap — a test stopped for want of a mail
// catcher — is not counted either. It says nothing about the application, and a slice sent
// back for it has not failed a build (`docs/decisions/0075`).
//
// And the count starts again after a person's return. The limit exists to put a person in
// front of a slice the loop is not closing; once one has read it and asked for another
// build, the returns before that ruling have been answered. Only a person's ruling resets
// it: an agent seat returning its own escalation would let the loop run without end
// (`docs/decisions/0076`). The family's order is its proposal numbers, which only grow.
function returnsByVerify(projectDir, slice) {
  const base = buildProposalBase(slice);
  const seq = (name) => (name === base ? 1 : Number(name.slice(base.length + 1)));
  const gates = [...buildProposalFamily(projectDir, slice)]
    .map((name) => ({ name, n: seq(name), gate: verifyReturnGate(projectDir, name) }));
  const since = Math.max(0, ...gates.filter(({ gate }) => gate?.verdict === "return" && byPerson(gate.by)).map(({ n }) => n));
  return gates.filter(({ n, gate, name }) => n > since && !environmentOnly(gate)
    && (gate?.by === "runner:verify" || (gate?.verdict === "return" && sortedOn(projectDir, name, slice)))).length;
}

// Whether a build was left open by verify for its ruler to sort the failures, rather than
// returned by verify itself (`docs/decisions/0091`). The ruler's return of it is verify's
// return in all but who wrote it, and is counted as one: otherwise a slice whose failures keep
// reading nothing off the page would go round without ever reaching the limit.
function sortedOn(projectDir, name, slice) {
  for (const ref of [`proposal/${name}`, `returned/${name}`]) {
    const rel = `tests/results/new/slice-${slice}.json`;
    if (!gitOk(["cat-file", "-e", `${ref}:${rel}`], projectDir)) continue;
    try { return Boolean(JSON.parse(git(["show", `${ref}:${rel}`], projectDir))?.sort); } catch { return false; }
  }
  return false;
}

function byPerson(by) {
  return typeof by === "string" && by !== "" && !by.startsWith("agent:") && !by.startsWith("runner");
}

function environmentOnly(gate) {
  const conditions = Array.isArray(gate?.conditions) ? gate.conditions : [];
  return conditions.length > 0 && conditions.every((c) => MAIL_CATCHER_UNSET_RE.test(String(c)));
}

// What this run established about the application on this branch, written where
// `buildVerified` (`src/commands/rule.mjs`) reads it to decide whether a G3 ruling may be
// given at all. Every route out of `execute` that ends with a verdict writes one, including
// the routes where no test ran: currency is judged by `app_tree`, so a run that left this
// file alone would leave an earlier `pass` on the same tree standing and the proposal
// rulable as approved. `not_verified` says, for a reader, why there are no rows.
function writeVerifyResult(projectDir, { slice, name, verdict, rows, unasserted = [], environment = [], unbound = [], adapter = "", notVerified = "", rechecked = [], regressed = [], sort = null }) {
  const resultRel = `tests/results/new/slice-${slice}.json`;
  mkdirSync(join(projectDir, "tests", "results", "new"), { recursive: true });
  // Each row carries the acceptance test's own error text, which is a browser's or a
  // runner's stack trace and names the file it was thrown from. The file is committed to
  // the proposal branch, so rule E-2's redaction applies to it as it does to every other
  // agent-produced text this pipeline commits (`src/lib/redact.mjs`).
  writeText(join(projectDir, resultRel), redactLocalPaths(`${JSON.stringify({
    slice, proposal: name, app_tree: git(["rev-parse", "HEAD:app"], projectDir),
    at: new Date().toISOString(), verdict,
    // The criteria this run never put to the application, beside the verdict rather than
    // only inside the rows: a reader deciding what the verdict means should not have to
    // reconstruct it by sorting the rows for itself.
    ...(unasserted.length ? { unasserted } : {}),
    // The criteria this environment could not test, and the ones the adapter could not
    // drive, each apart from the failures: neither is the builder's, and `next` routes each
    // by its own list (`docs/decisions/0075`). `adapter` is the tree of tests/adapters/new
    // the suite ran with.
    ...(environment.length ? { environment } : {}),
    ...(unbound.length ? { unbound } : {}),
    ...(adapter ? { adapter } : {}),
    ...(notVerified ? { not_verified: notVerified } : {}),
    // What earlier, approved slices passed and this run checked again: the ones that still pass,
    // and the ones that no longer do, each with the slice it passed under. Apart from `rows`,
    // which are this slice's own criteria and nothing else.
    ...(rechecked.length ? { rechecked } : {}),
    ...(regressed.length ? { regressed } : {}),
    // A failing verify left for its ruler to sort (`docs/decisions/0091`): the criteria whose
    // test read nothing off the page, and every failure as the build would be told it.
    ...(sort ? { sort } : {}),
    rows,
  }, null, 2)}\n`, projectDir));
  return resultRel;
}

// One return by verify, written the one way. `by: "runner:verify"` is what makes
// `returnsByVerify` count it, and the count is read here so the return that reaches the
// limit escalates instead of asking for another build — the same ceiling whether the slice
// failed its criteria or never started at all (docs/decisions/0017-a-sandbox-that-is-not-up.md).
function writeVerifyReturn(projectDir, { name, slice, limit, escalateTo, conditions, rationale, escalatedRationale }) {
  const escalate = returnsByVerify(projectDir, slice) + 1 >= limit;
  const gateRel = `.sdlc/gates/${name}.yaml`;
  // The conditions are a service's own log or an acceptance test's own error, quoted
  // verbatim so the builder has the evidence. Both come off this machine and name paths
  // on it, and this file is committed and published (`src/lib/redact.mjs`).
  writeText(join(projectDir, gateRel), redactLocalPaths(stringifyYaml({
    gate: "G3", verdict: escalate ? "escalated" : "return", by: "runner:verify", held_by: "runner",
    ...(escalate ? { escalate_to: escalateTo } : {}),
    rationale: escalate ? escalatedRationale : rationale,
    conditions,
    at: new Date().toISOString(),
  }), projectDir));
  return { escalate, gateRel };
}

// What a builder is given to act on when the sandbox did not come up: one condition per
// service that failed, each naming the service, what became of it and the end of its own
// log — which is where the reason lives, since the service that failed is not the one the
// base URL points at and nothing else in the pipeline has read it.
export function sandboxConditions(started) {
  const failures = started.failures ?? [];
  if (!failures.length) return (started.messages ?? []).map((m) => `sandbox: ${m}`);
  return failures.map((f) => [`sandbox ${f.service}: ${f.reason}.`, f.log ? `Its own log ends:\n${f.log}` : ""].filter(Boolean).join(" "));
}

function commitOnBranch(projectDir, paths, message) {
  stagePaths(projectDir, paths);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", message], projectDir);
}

// A merge can fail for reasons that are not a conflict at all — an unresolvable ref, a
// hook, a commit git declined. Reporting those as a conflict names the wrong cause and
// prescribes a rebuild that would not help, so the two are told apart by whether git named
// any conflicted path, and git's own reason is carried rather than discarded.
export function mergeFailureText(sliceNumber, branch, merged) {
  if (merged.conflicts.length) {
    return [
      `verify slice ${sliceNumber}: ${branch} no longer merges with main, so nothing was verified.`,
      `Conflicted paths:\n  ${merged.conflicts.join("\n  ")}`,
      `The merge was undone and ${branch} is exactly as it was. Rule or close this proposal and rebuild the slice on top of main.`,
    ].join("\n");
  }
  const said = (merged.message ?? "").split("\n").map((l) => `  ${l}`).join("\n").trimEnd();
  return [
    `verify slice ${sliceNumber}: main could not be merged into ${branch}, so nothing was verified.`,
    `git named no conflicted path, so this is not a stale proposal. What it said:\n${said}`,
    `${branch} is exactly as it was.`,
  ].join("\n");
}

export const verify = {
  name: "verify",
  title: (ctx) => `verify slice ${ctx.slice}`,
  skill: skillPath("verify"),
  workspace: "project",
  gate: null,
  agent: false,
  collect: [],
  implemented: true,
  preChecks(projectDir, ctx) {
    const id = "verify-slice";
    if (ctx.slice === undefined) return [{ id, ok: false, messages: ["verify needs --slice <n>"] }];
    // Checked before anything is started, the way `calibrate` and `bind-adapter` check it:
    // verify signs the suite in to the `new` target, and where that target's identity is
    // the sandbox's own provider, every test in the slice fails at the sign-in form
    // without the password in the environment. Verify would read a whole suite of
    // sign-in failures as the application's fault and return the slice to the builder —
    // a rebuild that cannot fix an environment defect (spec 7.1). The check reads only
    // whether the variable is set; its value is never read, printed or stored.
    const password = checkSandboxPassword("verify", ctx, "verifying", "new");
    // Where a slice that reaches the return limit goes is the project's policy, and a
    // project whose G3 names nowhere has not said. Refused before anything is started,
    // rather than discovered on the build that reaches the limit, and never answered with
    // a role written in here: that role may not exist in the project, and a gate file
    // naming it names somebody who never receives the question.
    if (!ctx.config?.policy?.gates?.G3?.escalate_to) {
      return [password, { id: "verify-escalation", ok: false, messages: [
        `policy.gates.G3 names no escalate_to. Verify escalates a slice to it once the slice has failed verify ${verifyReturnLimit(ctx.config)} times, and has nowhere else to send it; add escalate_to to G3 in .sdlc/config.yaml`,
      ] }];
    }
    // The proposal has to exist before the slice's own text does: a build proposal is
    // named from the slice number alone, so a slice that plan/tasks.md has not yet (or
    // no longer) defined a heading for is still reported as "no open build proposal" —
    // the precondition a person actually needs to act on — rather than a parse error
    // about the plan.
    const proposal = openBuildProposal(projectDir, ctx.slice);
    if (!proposal) return [password, { id, ok: false, messages: [`no open build proposal for slice ${ctx.slice}; run sdlc run build --slice ${ctx.slice} first`] }];
    const slice = readSlice(projectDir, ctx.slice);
    if (!slice) return [password, { id, ok: false, messages: [`plan/tasks.md has no slice ${ctx.slice}`] }];
    ctx.verifySlice = slice;
    ctx.verifyProposal = proposal;
    return [password, { id, ok: true, messages: [] }];
  },
  async execute(projectDir, ctx) {
    const { verifySlice: slice, verifyProposal: name, config } = ctx;
    const up = ctx.sandbox?.up ?? ((d, opts) => sandboxUp(d, config, "new", opts));
    const down = ctx.sandbox?.down ?? ((d) => sandboxDown(d, config, "new"));
    // Who a G3 escalation goes to is the project's policy, not this stage's: `rule.mjs`
    // already routes by `policy.gates.G3.escalate_to`, and the name written here is the
    // same answer rendered for a reader. The pre-check has already refused a policy that
    // names none.
    const escalateTo = config.policy.gates.G3.escalate_to;
    const limit = verifyReturnLimit(config);
    const branch = `proposal/${name}`;
    // The tree goes to the proposal the slice was built on and comes back afterwards, the
    // same borrow `sdlc sandbox --from` makes (`enterBranch`/`leaveBranch`,
    // `src/lib/git.mjs`, and docs/decisions/0016-binding-and-verifying-an-unmerged-proposal.md).
    const start = enterBranch(projectDir, branch, `verify slice ${slice.number}`);
    let text;
    let dirty = false;
    // What the operator is told instead of `ok`, and what makes the run exit non-zero,
    // when verify finished its own work correctly and the thing it was asked about did
    // not pass (`src/commands/run.mjs`). Left unset by exactly one route out — the one
    // where every criterion the slice claims passed. The three that do set it read
    // differently on purpose: a criterion that was exercised and came out wrong, a
    // criterion that could not be exercised at all, and a slice whose third failure goes
    // to a person are three different things to do next.
    let notPassed;
    // Held rather than propagated on its own, so the teardown below can run first and
    // then say what the run actually left behind. Rethrown either way: nothing that went
    // wrong here is swallowed.
    let failure;
    // What the suite found about the adapter, carried off the branch to be filed on main, and
    // how the run's account changes once it is known which unbound rows a binding run is
    // owed for.
    let binding = null;
    let describeUnbound = null;
    try {
      // The branch was cut from `main` when the slice was built, and `main` has moved
      // since: an adapter ruled at G3 in the meantime is on `main` and nowhere else, and
      // so is every other thing the harness has become. Verify runs the suite on this
      // branch, so a branch left as it was cut is verified against a test rig the
      // project no longer has — and, where the missing piece is the adapter, reports the
      // same criteria unbound for ever with no command able to change it
      // (docs/decisions/0016-binding-and-verifying-an-unmerged-proposal.md). Bringing `main` in
      // first is what makes the slice's next verify see it.
      const merged = mergeInto(projectDir, "main", `merge(verify): main into ${branch} before slice ${slice.number}`);
      if (!merged.ok) {
        // Not a verdict about the application: nothing has run, so nothing is written to
        // a gate file and the builder is not returned anything. A proposal that no
        // longer merges is a slice that needs rebuilding on top of what `main` now has,
        // and the reviewer would otherwise be the one to find that out.
        text = mergeFailureText(slice.number, branch, merged);
        throw new Error(text);
      }
      // Every copy the target declares, so the suite can spread its tests across them
      // (`docs/decisions/0090`). A target that declares none is the one copy it always was.
      const started = await up(projectDir, { copies: "all" });
      if (!started.ok && started.cause !== APPLICATION) {
        // The machine's half. A port already taken, an image that would not pull, a daemon
        // that is not there: nothing the builder wrote ever ran, so there is nothing to
        // tell a builder to fix and nothing is recorded against the build. The run still
        // has to end non-zero and say so — returning normally here printed
        // `run verify: ok` over a verification that never happened, which is the one
        // outcome a caller must never be given.
        text = `verify slice ${slice.number}: the sandbox did not start, so nothing was verified.\n${started.messages.join("\n")}`;
        throw new Error(text);
      } else if (!started.ok) {
        // The application's half, and the reason this path exists: a container that came
        // up, died on a file the build wrote and has been restarting ever since. No
        // acceptance criterion can express that, so the suite cannot fail on it, verify
        // cannot pass, and without a return there is nothing a reviewer or a builder can
        // be handed. It goes back to the builder the same way a failing criterion does —
        // the same gate file, the same author, the same three-strike ceiling — with the
        // failed service and the end of its own log as the conditions.
        // No test ran, so there are no rows — and the file is still written, because
        // `buildVerified` judges an earlier result current by the application tree, and a
        // gate-only commit does not change `HEAD:app`. Left alone, a `pass` from a verify
        // before the sandbox broke would still be reading as current and this proposal
        // would still be rulable as approved.
        const resultRel = writeVerifyResult(projectDir, {
          slice: slice.number, name, verdict: "fail", rows: [],
          notVerified: "the sandbox did not start, so no acceptance test ran",
        });
        const { escalate, gateRel } = writeVerifyReturn(projectDir, {
          name, slice: slice.number, limit, escalateTo,
          conditions: sandboxConditions(started),
          rationale: `Slice ${slice.number} builds an application that does not start, so none of its criteria could be tested. The compose file, the images it builds and the configuration they read are all part of this build, and each condition names a service, what became of it and what it said on the way down.`,
          escalatedRationale: `Slice ${slice.number} has been returned by verify ${limit} times, this time because the sandbox never came up. What is wrong may not be the application's to fix — the compose file, the stack profile and this machine can each be the cause (spec 7.1) — and another build would not find out which.`,
        });
        commitOnBranch(projectDir, [resultRel, gateRel], `verify(slice ${slice.number}): sandbox`);
        notPassed = escalate
          ? `escalated to ${escalateTo} — the sandbox did not start after ${limit} builds`
          : "returned — the sandbox did not start, so nothing was verified";
        text = escalate
          ? `verify slice ${slice.number}: the sandbox did not start after ${limit} builds; escalated to ${escalateTo}.`
          : `verify slice ${slice.number}: returned — the sandbox did not start, so nothing was verified. ${(started.messages[0] ?? "").split("\n")[0]} Next: sdlc run build --slice ${slice.number} --revise`;
      } else {
        const settings = targetSettings(config, "new");
        const instances = (started.copies?.length ? started.copies : [{ index: 0, baseUrl: settings.baseUrl, mailApi: settings.mailApi }])
          .map((c) => ({ baseUrl: c.baseUrl, mailApi: c.mailApi, resetCommand: resetCommandFor(projectDir, config, "new", c.index) }));
        const suite = (files) => {
          const { configured, tags } = configuredCriteria(projectDir, files);
          const { rows } = (ctx.runSuite ?? runSuite)({
            projectDir, target: "new", baseUrl: settings.baseUrl, mailApi: settings.mailApi, instances,
            files, resetCommand: resetCommandFor(projectDir, config, "new"),
            ...(tags.length ? { grepInvert: tags } : {}),
          });
          keepEvidence(projectDir, slice.number, rows);
          return { rows, configured };
        };
        // The slice's own tests first. What earlier, approved slices passed is checked again only
        // once they pass, against the same running application: a build that does not yet do what
        // its own criteria say goes back for that alone, and the whole regression suite runs on
        // the build that is a candidate for approval
        // (`docs/decisions/0087-a-later-build-is-checked-against-what-earlier-slices-passed.md`, `0089`).
        clearEvidence(projectDir, slice.number);
        const ownRun = suite(specFilesFor(projectDir, slice.criteria));
        const configured = ownRun.configured;
        const earlier = earlierPasses(projectDir, slice.number, slice.criteria);
        const ownFirst = verifyVerdict(ownRun.rows.filter((r) => slice.criteria.includes(r.id)), slice.criteria, { configured });
        const candidate = ["pass", "pass-unasserted", "environment"].includes(ownFirst.verdict);
        const earlierRun = candidate && earlier.size ? suite(specFilesFor(projectDir, [...earlier.keys()])) : null;
        if (earlierRun) for (const [id, why] of earlierRun.configured) configured.set(id, why);
        const rows = [...ownRun.rows, ...(earlierRun?.rows ?? []).filter((r) => earlier.has(r.id))];
        const earlierDeferred = !candidate && earlier.size > 0;
        // The adapter the suite drove with, recorded on the result and on every rebind entry
        // this run files, so the verify after a binding run can tell the rows it reaches.
        const adapter = adapterExists(projectDir, "new") ? adapterAt(projectDir, "new", "HEAD") : "";
        const claimed = rows.filter((r) => slice.criteria.includes(r.id)).map((r) => (adapter && r.file ? { ...r, adapter } : r));
        const own = verifyVerdict(claimed, slice.criteria, { configured });
        const recheck = earlierRun ? recheckEarlier(earlierRun.rows, earlier, configured) : { regressed: [], held: [], unexercised: [] };
        // A criterion an earlier slice passed and this build broke fails this build, however its
        // own criteria came out.
        const v = recheck.regressed.length ? { ...own, verdict: "fail" } : own;
        const regressionConditions = recheck.regressed.flatMap((x) => conditionsFor(x.row, `${x.id} (passed when slice ${x.slice} was approved)`));
        const failureConditions = [...v.failing.flatMap((r) => conditionsFor(r)), ...regressionConditions];
        // A failure that stopped on a read that came back with nothing can be the adapter's as
        // easily as the application's, and only a look at the page tells which. So a build with
        // one is left open for its G3 ruler, with the picture and outline of each page, to send
        // each failure to the build or, addressed to bind-adapter, to the binding — rather than
        // returned to a builder who cannot see the page or change the adapter
        // (`docs/decisions/0091`). A return that would reach the limit is verify's own, as ever.
        const emptyReads = v.verdict === "fail"
          ? [...v.failing.filter(readNothing).map((r) => r.id), ...recheck.regressed.filter((x) => readNothing(x.row)).map((x) => x.id)]
          : [];
        const sortFirst = emptyReads.length > 0 && returnsByVerify(projectDir, slice.number) + 1 < limit;
        const unboundListed = unboundReasons(claimed, v.unbound);
        const paths = [writeVerifyResult(projectDir, {
          slice: slice.number, name, verdict: v.verdict, rows: claimed, unasserted: v.unasserted,
          environment: v.environment, unbound: unboundListed, adapter,
          rechecked: recheck.held,
          regressed: recheck.regressed.map((x) => ({ id: x.id, slice: x.slice, result: x.row.result, error: firstError(x.row) })),
          sort: sortFirst ? { empty_reads: emptyReads, conditions: failureConditions } : null,
        })];
        // Filed on main once the tree is back there, below: owed work is read off main by
        // `next` and by the binding run, and this branch reaches main only when it is ruled.
        // `appTree` is the application measured, the tree the result records as `app_tree`: a
        // rebind entry this run files carries it, and the rebind limit counts the sends made
        // against this build of the application alone (`docs/decisions/0083`).
        if (adapter) binding = { rows: claimed, adapter, ids: slice.criteria, appTree: git(["rev-parse", "HEAD:app"], projectDir) };
        const envLines = environmentLines(slice.number, v.environment);
        if (v.verdict === "fail" && sortFirst) {
          const k = recheck.regressed.length;
          const holder = config.policy?.gates?.G3?.holder ?? "the G3 ruler";
          const failingIds = [...v.failing.map((r) => r.id), ...recheck.regressed.map((x) => `${x.id} (slice ${x.slice})`)];
          notPassed = `not yet returned — ${failingIds.length} ${failingIds.length === 1 ? "failure" : "failures"}, ${emptyReads.length} of them a read that came back with nothing, for ${holder} to sort`;
          text = [
            `verify slice ${slice.number}: ${failingIds.join(", ")} fail${k ? ` (${k} that an earlier slice passed)` : ""}. ${emptyReads.join(", ")} stopped on a read that came back with nothing, which can be the adapter's as easily as the application's, so ${name} is left open for ${holder} to send each failure to the build or to bind-adapter.`,
            ...envLines,
          ].join("\n");
          describeUnbound = (owed) => (owed.length ? [text, ...owedBindingLines(slice.number, branch, owed, claimed)].join("\n") : text);
        } else if (v.verdict === "fail") {
          const k = recheck.regressed.length;
          const regressionPart = k ? `${k} ${criteriaWord(k)} an earlier slice passed now ${k === 1 ? "fails" : "fail"}` : "";
          const { escalate, gateRel } = writeVerifyReturn(projectDir, {
            name, slice: slice.number, limit, escalateTo,
            conditions: failureConditions,
            rationale: [
              v.failing.length ? `Slice ${slice.number} does not yet do what ${v.failing.length} of its criteria say.` : "",
              k ? `This build breaks ${k} ${criteriaWord(k)} that passed when an earlier slice was approved.` : "",
              "Each condition is the criterion and what the running application did.",
            ].filter(Boolean).join(" "),
            escalatedRationale: `Slice ${slice.number} has failed verify ${limit} times. The failures below may not be the application's: a test, the adapter, the criterion or the sandbox can each be what is wrong (spec 7.1), and another build would not find out which.`,
          });
          paths.push(gateRel);
          const ownPart = v.failing.length ? `${v.failing.length} of ${slice.criteria.length} criteria fail against the application` : "";
          notPassed = escalate
            ? `escalated to ${escalateTo} — ${[v.failing.length ? `${v.failing.length} of ${slice.criteria.length} criteria still fail` : "", regressionPart].filter(Boolean).join("; ")} after ${limit} builds`
            : `returned — ${[ownPart, regressionPart].filter(Boolean).join("; ")}`;
          const failingIds = [...v.failing.map((r) => r.id), ...recheck.regressed.map((x) => `${x.id} (slice ${x.slice})`)];
          text = [
            escalate
              ? `verify slice ${slice.number}: ${failingIds.length} criteria still fail after ${limit} builds; escalated to ${escalateTo}.`
              : `verify slice ${slice.number}: returned — ${failingIds.join(", ")} fail. Next: sdlc run build --slice ${slice.number} --revise`,
            ...envLines,
          ].join("\n");
          // Told after the binding is filed, where the lines about it are added.
          describeUnbound = (owed) => (owed.length ? [text, ...owedBindingLines(slice.number, branch, owed, claimed)].join("\n") : text);
        } else if (v.verdict === "environment") {
          notPassed = `not verified — ${v.environment.length} of ${slice.criteria.length} criteria could not be tested in this environment`;
          text = [
            `verify slice ${slice.number}: not verified — ${v.environment.map((e) => e.id).join(", ")} could not be tested in this environment.`,
            ...envLines,
            "Nothing was written to the gate file: nothing the builder can change would test them.",
          ].join("\n");
          describeUnbound = (owed) => {
            if (owed.length) notPassed += `; ${owed.length} unbound, owed to bind-adapter --target new`;
            return owed.length ? [text, ...owedBindingLines(slice.number, branch, owed, claimed)].join("\n") : text;
          };
        } else if (v.verdict === "unbound") {
          const head = `verify slice ${slice.number}: ${v.unbound.length} of the ${slice.criteria.length} criteria this slice claims could not be exercised at all — ${v.unbound.join(", ")}.`;
          notPassed = `unbound — ${v.unbound.length} of ${slice.criteria.length} criteria could not be exercised at all`;
          text = adapter
            // The adapter is in place, it drove the application, and it reported the
            // surface these criteria need as absent. Where a binding run is still owed for
            // them, that is the next step (`owedBindingLines`, set below once the entries
            // are filed). Where the binding has been sent as often as policy.loops.rebind
            // allows, binding again would drive the same application and write the same
            // reasons, so the reasons are quoted, because they are the evidence, and what
            // they name is a question about what this slice builds, about what it was asked
            // to build, or about what was asked of it on the criterion's behalf.
            //
            // The third exit is there because the message this verdict produces is accurate
            // and names the wrong culprit whenever the test is the thing that over-reached:
            // the adapter truthfully reports a surface the application does not provide, and
            // the application was never answerable for it. Without a way to say so, that
            // judgement arrives at a gate with no lever and the only exits on offer are a
            // rebuild that cannot succeed and a re-scope that gives up a criterion.
            ? [
              head,
              "tests/adapters/new/index.ts is in place and was exercised. It reports each of these as part of the surface the application does not provide:",
              ...unboundListed.map(({ id, reason }) => `  ${id}: ${reason}`),
              `bind-adapter --target new has been sent for ${v.unbound.length === 1 ? "it" : "them"} as often as policy.loops.rebind allows against this build of the application, or a binding approved since looked at ${v.unbound.length === 1 ? "it" : "them"} and left the adapter as it was, or ${v.unbound.length === 1 ? "it needs" : "they need"} a persona the approved contract marks unavailable, so binding again is not the next step. The question is whether the application is missing something it was asked for, whether this slice was asked for too much, or whether a test is asking for something its criterion never did — and the choice is a person's:`,
              `  - rule ${name} at G3 with those reasons as the conditions, which returns it and lets sdlc run build --slice ${slice.number} --revise take them on;`,
              `  - or, if that surface belongs to a later slice, return ${name} with \`${ADDRESSED_CONDITION_FORM}\` among the conditions — the stage is plan, and the reason says which criterion slice ${slice.number} claims that nothing it builds demonstrates. That files a request the planner reads: sdlc run plan --revise cuts what the slice claims in plan/tasks.md again, with your reason in front of it, and the architect rules the result at the plan's own gate. The request itself changes nothing;`,
              `  - or, where a criterion is right and the test derived from it reaches past it — the test drives a capability the criterion never asks for, which is why there is nothing to bind — return ${name} with \`${OVERREACH_CONDITION_FORM}\` among the conditions. That files the criterion for re-derivation and carries your reason to the writer: sdlc run derive-tests --domain <the criterion's domain> --stale then writes that one test again. It verifies nothing — the criterion stays unverified until a regenerated test binds and passes.`,
              "Nothing was written to the gate file, because nothing about the application was tested and there is no verdict on it to record.",
            ].join("\n")
            // No adapter for this target yet. Binding needs the application answering, and
            // the application is on this proposal branch alone until the proposal is ruled
            // — so naming `bind-adapter` on its own names a step that refuses, every time,
            // for a target that has nothing running (0016). The whole sequence is printed
            // instead, branch name filled in, and it ends with the verify that picks the
            // ruled adapter up — which is a step that runs because this stage merges `main`
            // in first, and was a step that could not be reached before it did.
            : [
              head,
              "There is no adapter for the new target yet: tests/adapters/new/index.ts does not exist, so nothing on that target can be driven.",
              `The application it needs is on ${branch} and nowhere else until that proposal is ruled, so bind against it from there. From main, with a clean tree:`,
              `  1. sdlc sandbox up --target new --from ${branch}`,
              "  2. sdlc run bind-adapter --target new",
              "  3. rule the bind-adapter proposal at G3, which puts the adapter on main",
              `  4. sdlc sandbox down --target new --from ${branch}`,
              `  5. sdlc run verify --slice ${slice.number}`,
              `Step 5 picks the ruled adapter up: verify merges main into ${branch} before it runs the suite, so the branch carries whatever was ruled onto main after it was cut.`,
            ].join("\n");
          describeUnbound = (owed) => {
            if (!owed.length) return text;
            notPassed += "; owed to bind-adapter --target new";
            return [head, ...owedBindingLines(slice.number, branch, owed, claimed)].join("\n");
          };
        } else if (v.verdict === "pass-unasserted") {
          // Nothing failed, and the slice is not a slice whose claims were all asserted.
          // No gate file is written and nothing about what may be ruled changes: this is
          // the same route to G3 a clean pass takes, saying what it actually established.
          text = unassertedText({ slice: slice.number, proposal: name, criteria: slice.criteria.length, unasserted: v.unasserted });
        } else {
          // The one outcome this sentence is true of: every criterion the slice claims was
          // put to the running application and met.
          text = `verify slice ${slice.number} verified: every claimed criterion passes against the application in ${name}. Ready for G3.`;
        }
        // What became of the earlier slices' criteria, after whatever this slice's own verdict
        // said: the ones that still pass, and the ones this run could not exercise, which are
        // reported and left where they lie.
        const h = recheck.held.length;
        text = [
          text,
          ...(h ? [`${h} ${criteriaWord(h)} earlier slices passed still ${h === 1 ? "passes" : "pass"}.`] : []),
          ...(recheck.unexercised.length ? [`Not checked again, and not charged to this build: ${recheck.unexercised.map((x) => `${x.id} (slice ${x.slice}: ${x.why})`).join("; ")}.`] : []),
          ...(earlierDeferred ? [`The ${earlier.size} ${criteriaWord(earlier.size)} earlier slices passed ${earlier.size === 1 ? "is" : "are"} checked again once this slice's own criteria pass.`] : []),
        ].join("\n");
        commitOnBranch(projectDir, paths, `verify(slice ${slice.number}): ${v.verdict}`);
      }
    } catch (err) {
      failure = err;
    } finally {
      // A sandbox that will not stop is its own failure — containers left running — but
      // it must not mask the one already on its way out, and it must not skip the rest of
      // the teardown below, which is what decides where HEAD is left.
      try { await down(projectDir); } catch (err) { failure ??= err; }
      // A throw between the first working-tree write and the commit landing (the
      // gate-file write, `stringifyYaml`, or the commit itself) can leave the proposal
      // branch holding a staged or untracked file, which a checkout would carry onto
      // `main` — where `assertCleanTree` then blocks every later `sdlc run` until a
      // person cleans it up by hand, the same hazard `rule.mjs`'s `rulePending` guards
      // against. `leaveBranch` goes back only once the branch is clean, so residue stays
      // visible on the branch that produced it, and hands back what it refused to leave.
      dirty = Boolean(leaveBranch(projectDir, start));
      if (dirty) {
        text = `verify slice ${slice.number}: the working tree was left dirty on ${branch} after a failure; HEAD is still on ${branch}. Inspect and clean it before running verify again.`;
      } else if (!failure && binding) {
        // On main now. The rows this run put to the target are settled against the rebind
        // entries there: an unbound row is filed for bind-adapter --target new while the
        // binding has been sent fewer times than policy.loops.rebind allows against the
        // application this run measured, and an entry for one of this slice's criteria whose
        // row the binding now reaches is closed, as is one this slice filed for a criterion it
        // no longer claims (`src/spec/unbound.mjs`). The file is left for the run's own commit
        // on main.
        try {
          const unavailable = unavailableOn(projectDir, "new", config);
          syncUnbound(projectDir, "new", {
            rows: binding.rows, adapter: binding.adapter, ids: binding.ids, limit: owedLoopLimit(config, "rebind"),
            unavailable, by: "runner:verify", stamp: { slice: slice.number }, appTree: binding.appTree,
          });
          withdrawUnclaimed(projectDir, "new", { slice: slice.number, ids: binding.ids, by: "runner:verify" });
          const open = new Set(readOwed(projectDir, "rebind").filter((e) => isOpen(e) && e.target === "new").map((e) => e.id));
          const owed = binding.rows
            .filter((r) => r.result === "unbound" && binding.ids.includes(r.id) && open.has(r.id) && !personaUnavailable(r, unavailable))
            .map((r) => r.id);
          if (describeUnbound) text = describeUnbound(owed);
        } catch (err) { failure = err; }
      }
      // Every attempt says what became of it, including the ones that failed: a run with
      // no line in the record is indistinguishable from a run nobody made.
      const runRel = relative(projectDir, appendRun(projectDir, text?.split("\n")[0] ?? `verify slice ${slice.number}: stopped`));
      // On a clean tree the record is the only thing dirty and the run is about to throw,
      // so nothing downstream will commit it; left uncommitted it would block the next
      // `sdlc run` at `assertCleanTree`. A dirty tree is committed by nobody: the residue
      // is the diagnostic, and a person clears this line along with it.
      if (!dirty && failure) commitOnBranch(projectDir, [runRel], `run(verify): slice ${slice.number} failed`);
    }
    // A failed run fails. Resolving with no changed paths would send it to
    // `finishDeterministicNoOp` (`src/runner/finish-stage.mjs`, reached from
    // `src/commands/run.mjs`), which commits whatever is dirty and returns ok — with
    // HEAD on a proposal branch and a half-written result beside it, that committed the
    // residue onto the proposal, left HEAD there and printed `run verify: ok`. Where the tree is dirty the residue is the diagnostic a person
    // needs first, so it leads; the error that caused it is carried as the `cause` and
    // quoted in the message rather than replaced by it.
    if (dirty) throw new Error(`${text}\nWhat failed: ${failure?.message ?? "the run left the tree dirty without reporting an error"}`, { cause: failure });
    if (failure) throw failure;
    return { text, changed: [], notPassed };
  },
  postChecks() { return []; },
  proposal() { return null; },
};

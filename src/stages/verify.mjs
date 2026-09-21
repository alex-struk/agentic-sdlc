// `verify --slice N`: run the acceptance tests for the criteria one slice claims against
// the application its open build proposal contains, and record what happened on that
// proposal's own branch (spec §5.11). Deterministic: no agent turn, like `calibrate`.
//
// A slice that passes is ready for G3; the reviewer's ruling is refused without this result
// (src/commands/rule.mjs). A slice that fails is returned by the runner itself, through the
// same gate file a ruling writes, so `build --slice N --revise` picks the failures up the
// way `design --revise` picks up a returned design. The third such return escalates to the
// tech lead instead: a slice that fails three builds running is usually failing for a
// reason a fourth build will not fix (spec §7.1).
import { join, relative } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { writeText } from "../lib/fsx.mjs";
import { redactLocalPaths } from "../lib/redact.mjs";
import { git, gitOk, stagePaths, enterBranch, leaveBranch, mergeInto, SDLC_AUTHOR } from "../lib/git.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { runSuite } from "../testrun/playwright.mjs";
import { resetCommandFor, targetSettings, APPLICATION } from "../sandbox/local.mjs";
import { sandboxUp, sandboxDown } from "../commands/sandbox.mjs";
import { readSlice, buildProposals, buildProposalBase, specFilesFor } from "./slices.mjs";
import { checkSandboxPassword, escapeRe, skillPath } from "./shared.mjs";

export const MAX_VERIFY_RETURNS = 3;
const NEEDS_NO_TEST = new Set(["pass", "not-testable", "attested"]);

export function verifyVerdict(rows, criteria) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const failing = [];
  const unbound = [];
  for (const id of criteria) {
    const r = byId.get(id);
    if (!r) failing.push({ id, result: "missing", tests: [] });
    else if (r.result === "unbound") unbound.push(id);
    else if (!NEEDS_NO_TEST.has(r.result)) failing.push(r);
  }
  return { verdict: failing.length ? "fail" : unbound.length ? "unbound" : "pass", failing, unbound };
}

function firstError(r) {
  if (r.result === "missing") return "no acceptance test ran for this criterion";
  if (r.result === "stale") return "its test was written for an older version of the criterion";
  const t = (r.tests ?? []).find((x) => x.error);
  return (t?.error ?? "failed").split("\n")[0].trim();
}

// An open build proposal is one with no gate file on its branch yet: not ruled, not
// returned, not escalated. The newest is the one a revision produced last.
function openBuildProposal(projectDir, slice) {
  return buildProposals(projectDir, slice)
    .find((name) => !gitOk(["cat-file", "-e", `proposal/${name}:.sdlc/gates/${name}.yaml`], projectDir)) ?? null;
}

// Every proposal name this slice's build has ever gone under — wherever its gate file
// lives now, not only under `proposal/*`. `build --revise`'s own pre-check
// (`recordReturnOnMain`, `src/stages/proposals.mjs`) copies a returned gate onto `main`
// and renames the spent branch to `returned/<name>` once it has read the return off it, so
// by the time a later verify run asks this question, an earlier return's gate file is no
// longer under `proposal/<name>` at all — only on `main` and on `returned/<name>`.
// Counting just `proposal/*` (as an earlier version of this did) undercounts every return
// that has already been revised from, which makes `MAX_VERIFY_RETURNS` unreachable: three
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
function returnsByVerify(projectDir, slice) {
  let count = 0;
  for (const name of buildProposalFamily(projectDir, slice)) {
    if (verifyReturnGate(projectDir, name)?.by === "runner:verify") count += 1;
  }
  return count;
}

// What this run established about the application on this branch, written where
// `buildVerified` (`src/commands/rule.mjs`) reads it to decide whether a G3 ruling may be
// given at all. Every route out of `execute` that ends with a verdict writes one, including
// the routes where no test ran: currency is judged by `app_tree`, so a run that left this
// file alone would leave an earlier `pass` on the same tree standing and the proposal
// rulable as approved. `not_verified` says, for a reader, why there are no rows.
function writeVerifyResult(projectDir, { slice, name, verdict, rows, notVerified = "" }) {
  const resultRel = `tests/results/new/slice-${slice}.json`;
  mkdirSync(join(projectDir, "tests", "results", "new"), { recursive: true });
  // Each row carries the acceptance test's own error text, which is a browser's or a
  // runner's stack trace and names the file it was thrown from. The file is committed to
  // the proposal branch, so rule E-2's redaction applies to it as it does to every other
  // agent-produced text this pipeline commits (`src/lib/redact.mjs`).
  writeText(join(projectDir, resultRel), redactLocalPaths(`${JSON.stringify({
    slice, proposal: name, app_tree: git(["rev-parse", "HEAD:app"], projectDir),
    at: new Date().toISOString(), verdict,
    ...(notVerified ? { not_verified: notVerified } : {}),
    rows,
  }, null, 2)}\n`, projectDir));
  return resultRel;
}

// One return by verify, written the one way. `by: "runner:verify"` is what makes
// `returnsByVerify` count it, and the count is read here so the third return escalates
// instead of asking for a fourth build — the same ceiling whether the slice failed its
// criteria or never started at all (docs/decisions/0017-a-sandbox-that-is-not-up.md).
function writeVerifyReturn(projectDir, { name, slice, escalateTo, conditions, rationale, escalatedRationale }) {
  const escalate = returnsByVerify(projectDir, slice) + 1 >= MAX_VERIFY_RETURNS;
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
    const up = ctx.sandbox?.up ?? ((d) => sandboxUp(d, config, "new"));
    const down = ctx.sandbox?.down ?? ((d) => sandboxDown(d, config, "new"));
    // Who a G3 escalation goes to is the project's policy, not this stage's: `rule.mjs`
    // already routes by `policy.gates.G3.escalate_to`, and the name written here is the
    // same answer rendered for a reader. A project that escalates G3 elsewhere would
    // otherwise read a gate file naming a role that never gets the question.
    const escalateTo = config?.policy?.gates?.G3?.escalate_to ?? "tech-lead";
    const branch = `proposal/${name}`;
    // The tree goes to the proposal the slice was built on and comes back afterwards, the
    // same borrow `sdlc sandbox --from` makes (`enterBranch`/`leaveBranch`,
    // `src/lib/git.mjs`, and docs/decisions/0016-binding-and-verifying-an-unmerged-proposal.md).
    const start = enterBranch(projectDir, branch, `verify slice ${slice.number}`);
    let text;
    let dirty = false;
    // Held rather than propagated on its own, so the teardown below can run first and
    // then say what the run actually left behind. Rethrown either way: nothing that went
    // wrong here is swallowed.
    let failure;
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
      const started = await up(projectDir);
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
          name, slice: slice.number, escalateTo,
          conditions: sandboxConditions(started),
          rationale: `Slice ${slice.number} builds an application that does not start, so none of its criteria could be tested. The compose file, the images it builds and the configuration they read are all part of this build, and each condition names a service, what became of it and what it said on the way down.`,
          escalatedRationale: `Slice ${slice.number} has been returned by verify ${MAX_VERIFY_RETURNS} times, this time because the sandbox never came up. What is wrong may not be the application's to fix — the compose file, the stack profile and this machine can each be the cause (spec 7.1) — and a fourth build would not find out which.`,
        });
        commitOnBranch(projectDir, [resultRel, gateRel], `verify(slice ${slice.number}): sandbox`);
        text = escalate
          ? `verify slice ${slice.number}: the sandbox did not start after ${MAX_VERIFY_RETURNS} builds; escalated to ${escalateTo}.`
          : `verify slice ${slice.number}: returned — the sandbox did not start, so nothing was verified. ${(started.messages[0] ?? "").split("\n")[0]} Next: sdlc run build --slice ${slice.number} --revise`;
      } else {
        const { rows } = runSuite({
          projectDir, target: "new", baseUrl: targetSettings(config, "new").baseUrl,
          files: specFilesFor(projectDir, slice.criteria), resetCommand: resetCommandFor(projectDir, config, "new"),
        });
        const claimed = rows.filter((r) => slice.criteria.includes(r.id));
        const v = verifyVerdict(claimed, slice.criteria);
        const paths = [writeVerifyResult(projectDir, { slice: slice.number, name, verdict: v.verdict, rows: claimed })];
        if (v.verdict === "fail") {
          const { escalate, gateRel } = writeVerifyReturn(projectDir, {
            name, slice: slice.number, escalateTo,
            conditions: v.failing.map((r) => `${r.id}: ${firstError(r)}`),
            rationale: `Slice ${slice.number} does not yet do what ${v.failing.length} of its criteria say. Each condition is the criterion and what the running application did.`,
            escalatedRationale: `Slice ${slice.number} has failed verify ${MAX_VERIFY_RETURNS} times. The failures below may not be the application's: a test, the adapter, the criterion or the sandbox can each be what is wrong (spec 7.1), and a fourth build would not find out which.`,
          });
          paths.push(gateRel);
          text = escalate
            ? `verify slice ${slice.number}: ${v.failing.length} criteria still fail after ${MAX_VERIFY_RETURNS} builds; escalated to ${escalateTo}.`
            : `verify slice ${slice.number}: returned — ${v.failing.map((r) => r.id).join(", ")} fail. Next: sdlc run build --slice ${slice.number} --revise`;
        } else if (v.verdict === "unbound") {
          // Binding needs the application answering, and the application is on this
          // proposal branch alone until the proposal is ruled — so naming
          // `bind-adapter` on its own names a step that refuses, every time, for a
          // target that has nothing running (0016). The whole sequence is printed
          // instead, branch name filled in, and it ends with the verify that picks the
          // ruled adapter up — which is a step that runs because this stage merges
          // `main` in first, and was a step that could not be reached before it did.
          text = [
            `verify slice ${slice.number}: ${v.unbound.join(", ")} have no binding on the new target yet.`,
            `The application they need is on ${branch} and nowhere else until that proposal is ruled, so bind against it from there. From main, with a clean tree:`,
            `  1. sdlc sandbox up --target new --from ${branch}`,
            "  2. sdlc run bind-adapter --target new",
            "  3. rule the bind-adapter proposal at G3, which puts the adapter on main",
            `  4. sdlc sandbox down --target new --from ${branch}`,
            `  5. sdlc run verify --slice ${slice.number}`,
            `Step 5 picks the ruled adapter up: verify merges main into ${branch} before it runs the suite, so the branch carries whatever was ruled onto main after it was cut.`,
          ].join("\n");
        } else {
          text = `verify slice ${slice.number} verified: every claimed criterion passes against the application in ${name}. Ready for G3.`;
        }
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
    return { text, changed: [] };
  },
  postChecks() { return []; },
  proposal() { return null; },
};

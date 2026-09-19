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
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { writeText } from "../lib/fsx.mjs";
import { git, gitOk, stagePaths, currentBranch, SDLC_AUTHOR } from "../lib/git.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { runSuite } from "../testrun/playwright.mjs";
import { resetCommandFor, targetSettings } from "../sandbox/local.mjs";
import { sandboxUp, sandboxDown } from "../commands/sandbox.mjs";
import { readSlice, buildProposals, specFilesFor } from "./slices.mjs";
import { skillPath } from "./shared.mjs";

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

function returnsByVerify(projectDir, slice) {
  return buildProposals(projectDir, slice).filter((name) => {
    try { return parseYaml(git(["show", `proposal/${name}:.sdlc/gates/${name}.yaml`], projectDir))?.by === "runner:verify"; }
    catch { return false; }
  }).length;
}

function commitOnBranch(projectDir, paths, message) {
  stagePaths(projectDir, paths);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", message], projectDir);
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
    // The proposal has to exist before the slice's own text does: a build proposal is
    // named from the slice number alone, so a slice plan/tasks.md has not (yet, or any
    // longer) defined a heading for is still reported as "no open build proposal" —
    // the precondition a person actually needs to act on — rather than a parse error
    // about the plan.
    const proposal = openBuildProposal(projectDir, ctx.slice);
    if (!proposal) return [{ id, ok: false, messages: [`no open build proposal for slice ${ctx.slice}; run sdlc run build --slice ${ctx.slice} first`] }];
    const slice = readSlice(projectDir, ctx.slice);
    if (!slice) return [{ id, ok: false, messages: [`plan/tasks.md has no slice ${ctx.slice}`] }];
    ctx.verifySlice = slice;
    ctx.verifyProposal = proposal;
    return [{ id, ok: true, messages: [] }];
  },
  async execute(projectDir, ctx) {
    const { verifySlice: slice, verifyProposal: name, config } = ctx;
    const up = ctx.sandbox?.up ?? ((d) => sandboxUp(d, config, "new"));
    const down = ctx.sandbox?.down ?? ((d) => sandboxDown(d, config, "new"));
    const branch = `proposal/${name}`;
    const start = currentBranch(projectDir);
    git(["checkout", "-q", branch], projectDir);
    let text;
    try {
      const started = await up(projectDir);
      if (!started.ok) {
        text = `verify slice ${slice.number}: the sandbox did not start, so nothing was verified.\n${started.messages.join("\n")}`;
        return { text, changed: [] };
      }
      const { rows } = runSuite({
        projectDir, target: "new", baseUrl: targetSettings(config, "new").baseUrl,
        files: specFilesFor(projectDir, slice.criteria), resetCommand: resetCommandFor(projectDir, config, "new"),
      });
      const claimed = rows.filter((r) => slice.criteria.includes(r.id));
      const v = verifyVerdict(claimed, slice.criteria);
      const resultRel = `tests/results/new/slice-${slice.number}.json`;
      mkdirSync(join(projectDir, "tests", "results", "new"), { recursive: true });
      writeText(join(projectDir, resultRel), `${JSON.stringify({
        slice: slice.number, proposal: name, app_tree: git(["rev-parse", "HEAD:app"], projectDir),
        at: new Date().toISOString(), verdict: v.verdict, rows: claimed,
      }, null, 2)}\n`);
      const paths = [resultRel];
      if (v.verdict === "fail") {
        const escalate = returnsByVerify(projectDir, slice.number) + 1 >= MAX_VERIFY_RETURNS;
        const gateRel = `.sdlc/gates/${name}.yaml`;
        writeText(join(projectDir, gateRel), stringifyYaml({
          gate: "G3", verdict: escalate ? "escalated" : "return", by: "runner:verify", held_by: "runner",
          ...(escalate ? { escalate_to: "tech-lead" } : {}),
          rationale: escalate
            ? `Slice ${slice.number} has failed verify ${MAX_VERIFY_RETURNS} times. The failures below may not be the application's: a test, the adapter, the criterion or the sandbox can each be what is wrong (spec 7.1), and a fourth build would not find out which.`
            : `Slice ${slice.number} does not yet do what ${v.failing.length} of its criteria say. Each condition is the criterion and what the running application did.`,
          conditions: v.failing.map((r) => `${r.id}: ${firstError(r)}`),
          at: new Date().toISOString(),
        }));
        paths.push(gateRel);
        text = escalate
          ? `verify slice ${slice.number}: ${v.failing.length} criteria still fail after ${MAX_VERIFY_RETURNS} builds; escalated to the tech lead.`
          : `verify slice ${slice.number}: returned — ${v.failing.map((r) => r.id).join(", ")} fail. Next: sdlc run build --slice ${slice.number} --revise`;
      } else if (v.verdict === "unbound") {
        text = `verify slice ${slice.number}: ${v.unbound.join(", ")} have no binding on the new target yet. Next: sdlc run bind-adapter --target new, then verify again.`;
      } else {
        text = `verify slice ${slice.number} verified: every claimed criterion passes against the application in ${name}. Ready for G3.`;
      }
      commitOnBranch(projectDir, paths, `verify(slice ${slice.number}): ${v.verdict}`);
      return { text, changed: [] };
    } finally {
      await down(projectDir);
      if (currentBranch(projectDir) !== start) git(["checkout", "-q", start], projectDir);
      const runPath = appendRun(projectDir, text?.split("\n")[0] ?? `verify slice ${slice.number}: stopped`);
      void runPath;
    }
  },
  postChecks() { return []; },
  proposal() { return null; },
};

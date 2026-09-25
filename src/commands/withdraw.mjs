// `sdlc withdraw <proposal> --by <role> --reason "<why>"` — set aside a proposal that is still
// open, without ruling on anything it asks.
//
// A ruling answers the question a proposal puts: an approval accepts it, a return sends it back
// with conditions, an escalation hands it on. None of them fits a proposal whose question should
// never have been asked — one built on evidence later found to be broken, or overtaken by a newer
// proposal of the same kind. Approving or returning it would put an answer on the record about
// material nobody should answer, and leaving it open blocks the next proposal of its family
// (`followUpState`, `src/stages/shared.mjs`), which waits for the open one to be ruled.
//
// A withdrawal is recorded where a ruling is, so every reader that asks whether a proposal is
// still open reads it without learning anything new: a gate file on the proposal's branch, as a
// ruling commits, and the same file on `main`, where the proposal's number stays taken and the
// state site lists it. Its verdict, `withdrawn`, is none of the three a reader acts on, so it
// approves nothing, returns nothing to any stage and owes nothing. Both commits are the
// pipeline's own, and the run record carries who withdrew it and why.
//
// Either seat may do it, through the same check: the gate's holder or its escalation target,
// as a person typing the role or as an agent (`agent:<persona>`), the same seats that could have
// ruled it (`docs/decisions/0057-a-proposal-set-aside-without-an-answer.md`).
import { join, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseConfig } from "../config/load.mjs";
import { writeText } from "../lib/fsx.mjs";
import { assertCleanTree, assertOnMain, enterBranch, git, gitOk, leaveBranch, SDLC_AUTHOR, stagePaths } from "../lib/git.mjs";
import { redactLocalPaths } from "../lib/redact.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { heldByFor } from "../lib/seat.mjs";
import { simulatedRole } from "./rule.mjs";
import { COMMANDS } from "../cli.mjs";

export const WITHDRAWN = "withdrawn";

function showAt(projectDir, rev, path) {
  return gitOk(["cat-file", "-e", `${rev}:${path}`], projectDir) ? git(["show", `${rev}:${path}`], projectDir) : null;
}

function verdictAt(projectDir, rev, path) {
  const text = showAt(projectDir, rev, path);
  if (text === null) return null;
  try { return (parseYaml(text) ?? {}).verdict ?? "unknown"; } catch { return "unreadable"; }
}

// The seats that may withdraw a proposal at a gate: the ones that could rule it. A person sits
// in the holder's role or the escalation target's; an agent sits in the holder's, or in the
// escalation target's where this project plays that role by an agent.
function seatsFor(config, g) {
  return [...new Set([g.holder, g.escalate_to, simulatedRole(config, g.escalate_to) ? `agent:${g.escalate_to}` : null].filter(Boolean))];
}

export function withdraw(projectDir, name, { by, reason, at = new Date().toISOString() } = {}) {
  projectDir = resolve(projectDir);
  if (!by) throw new Error("withdraw needs --by <role or agent:persona>");
  const why = String(reason ?? "").trim();
  if (!why) throw new Error(`withdraw needs --reason "<why>": a proposal set aside with nothing on record says only that it disappeared`);
  const branch = `proposal/${name}`;
  if (!gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], projectDir)) throw new Error(`no proposal branch ${branch}`);
  assertCleanTree(projectDir, "withdraw");
  assertOnMain(projectDir, "withdraw");

  // Open means what `followUpState` means by it: no gate file on the branch or on `main`, or
  // one that records an escalation, which a person still owes an answer to.
  const rel = `.sdlc/gates/${name}.yaml`;
  for (const rev of [branch, "main"]) {
    const verdict = verdictAt(projectDir, rev, rel);
    if (verdict !== null && verdict !== "escalated") throw new Error(`${name} is already ruled: ${verdict}; only an open proposal can be withdrawn`);
  }

  // The gate and its seats are the proposal's own, read off its branch: a proposal is ruled
  // under the policy it was opened under (`0038`), and withdrawn by the seats that could rule it.
  const gate = /^gate:\s*(\S+)/m.exec(showAt(projectDir, branch, `.sdlc/proposals/${name}.md`) ?? "")?.[1];
  if (!gate) throw new Error(`proposal ${name} has no gate line`);
  const { config, errors } = parseConfig(showAt(projectDir, branch, ".sdlc/config.yaml") ?? "");
  if (errors.length) throw new Error(`config on ${branch} is invalid:\n  ${errors.join("\n  ")}`);
  const g = config.policy.gates[gate];
  if (!g) throw new Error(`gate ${gate} is not in policy`);
  const allowed = seatsFor(config, g);
  if (!allowed.includes(by)) throw new Error(`${by} is not a holder of ${gate} (allowed: ${allowed.join(", ")})`);

  const note = redactLocalPaths(why, projectDir);
  const text = stringifyYaml({ gate, verdict: WITHDRAWN, by, held_by: heldByFor(by), note, at });
  const subject = `withdraw(${name}): withdrawn at ${gate} by ${by}`;

  const start = enterBranch(projectDir, branch, "withdraw");
  let failure = null;
  try {
    writeText(join(projectDir, rel), text);
    stagePaths(projectDir, [rel]);
    git([...SDLC_AUTHOR, "commit", "-q", "-m", subject], projectDir);
  } catch (e) {
    failure = e;
  }
  const dirty = leaveBranch(projectDir, start);
  if (failure) throw failure;
  if (dirty) throw new Error(`withdraw: the working tree was left dirty on ${branch}; HEAD is still there:\n${dirty}`);

  writeText(join(projectDir, rel), text);
  const runRel = relative(projectDir, appendRun(projectDir, `withdraw ${name} at ${gate} by ${by}: ${note}`));
  stagePaths(projectDir, [rel, runRel]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", subject], projectDir);
  return { name, gate, by, note, branch };
}

COMMANDS.withdraw = async ({ pos, flags }) => {
  const r = withdraw(process.cwd(), pos[0], {
    by: typeof flags.by === "string" ? flags.by : undefined,
    reason: typeof flags.reason === "string" ? flags.reason : undefined,
  });
  console.log(`${r.name}: withdrawn at ${r.gate} by ${r.by}; it is no longer open, and nothing it asked was answered`);
  return 0;
};

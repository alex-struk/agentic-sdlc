import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { assertCleanTree } from "../lib/git.mjs";
import { writeText } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { stageFor, skillText } from "../stages/registry.mjs";
import { materialise, collect } from "../runner/workspace.mjs";
import { runAgent } from "../runner/executor.mjs";
import { writeRunState } from "../runner/run-state.mjs";
import { finishStage } from "../runner/finish-stage.mjs";
import { COMMANDS } from "../cli.mjs";

// `config.policy.budgets[<stage>]` is documented as a token count, but `runAgent`'s
// `maxTurns` wants a turn count and there is no token-to-turn conversion yet (that is
// its own later task). A configured value under 1000 is small enough to read as a turn
// count already — a token budget for a whole stage would run into the thousands — so
// it is used directly, clamped to 200; anything at or above 1000 is a token count we
// cannot yet translate, so it falls back to the same default of 40 turns as no budget
// at all.
function turnsFor(config, name) {
  const budget = config.policy?.budgets?.[name];
  if (budget && budget < 1000) return Math.min(budget, 200);
  return 40;
}

export async function runStage(projectDir, name, { slice, domain, dryRun = false, again = false } = {}) {
  projectDir = resolve(projectDir);
  assertCleanTree(projectDir, "run");
  const stage = stageFor(name);
  if (!stage.implemented) throw new Error(`stage ${name} is not implemented yet`);

  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);
  const ctx = { slice, domain, config };

  const pre = stage.preChecks(projectDir, ctx);
  const preFail = pre.filter((r) => !r.ok);
  if (preFail.length) {
    appendRun(projectDir, `run ${name}: pre-checks failed`);
    return { ok: false, messages: preFail.flatMap((r) => r.messages) };
  }

  const ws = materialise(projectDir, stage.workspace);
  // The skill text an agent turn reads is stage- and run-specific, so it is written to
  // its own scratch file rather than reused from disk; `again` (accepted here only for
  // CLI symmetry with `resume --again`) does not change anything below — `resume` is
  // the one place a re-run decision gets made.
  void again;
  const skillDir = mkdtempSync(join(tmpdir(), `sdlc-skill-${name}-`));
  const skillPath = join(skillDir, "SKILL.md");
  writeText(skillPath, skillText(name));

  const state = { stage: name, ctx: { slice, domain }, startedAt: new Date().toISOString(), phase: "agent" };
  writeRunState(projectDir, state);

  const prompt = stage.prompt(ctx);
  if (dryRun) {
    console.log(prompt);
    console.log(`skill: ${skillPath}`);
    ws.cleanup();
    return { ok: true, dryRun: true };
  }

  const r = await runAgent({ cwd: ws.dir, prompt, systemPromptFile: skillPath, stage: name, maxTurns: turnsFor(config, name) });
  rmSync(skillDir, { recursive: true, force: true });

  if (ws.mode !== "project") collect(projectDir, ws.dir, stage.collect);
  ws.cleanup();

  return finishStage(projectDir, stage, ctx, r);
}

COMMANDS.run = async ({ pos, flags }) => {
  const r = await runStage(process.cwd(), pos[0], {
    slice: flags.slice !== undefined ? Number(flags.slice) : undefined,
    domain: flags.domain,
    dryRun: !!flags["dry-run"],
    again: !!flags.again,
  });
  if (r.dryRun) return 0;
  if (!r.ok) { console.error(`run ${pos[0]}: failed\n  ${(r.messages ?? []).join("\n  ")}`); return 1; }
  console.log(`run ${pos[0]}: ok${r.proposal ? ` (opened ${r.proposal.branch})` : ""}`);
  return 0;
};

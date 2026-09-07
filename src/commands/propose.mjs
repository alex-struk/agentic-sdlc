import { join, relative, resolve } from "node:path";
import { git, assertCleanTree, stageAll, changedPaths, SDLC_AUTHOR } from "../lib/git.mjs";
import { writeText } from "../lib/fsx.mjs";
import { loadConfig } from "../config/load.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { COMMANDS } from "../cli.mjs";

export function propose(projectDir, name, { gate, question, recommendation, page = "", paths = null, tier = null }) {
  projectDir = resolve(projectDir);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("proposal name: lowercase letters, digits, hyphens");
  if (!gate || !question || !recommendation) throw new Error("propose needs --gate, --question and --recommendation");
  // The gate is checked against the same policy `sdlc rule` will check it against, and
  // before any git command runs: a proposal opened at a gate nobody holds can never be
  // ruled, and there is no reason to leave a branch behind saying otherwise.
  const { config, errors } = loadConfig(join(projectDir, ".sdlc", "config.yaml"));
  if (errors.length) throw new Error(`config invalid:\n  ${errors.join("\n  ")}`);
  if (!config.policy.gates[gate]) throw new Error(`gate ${gate} is not in policy`);

  if (paths) {
    // A stage that opens a gate hands over the files its own agent turn changed so
    // they land in the same commit as the proposal, which means the tree is dirty on
    // purpose here. `assertCleanTree` would reject exactly the files the caller means
    // to commit, so instead only a dirty path the caller did NOT account for fails the
    // call — the same "name what's wrong" contract `assertCleanTree` gives everywhere
    // else, but scoped to the paths this proposal was not told about.
    const allowed = new Set(paths);
    const extra = changedPaths(projectDir).filter((p) => !allowed.has(p));
    if (extra.length) throw new Error(`propose: files outside paths are dirty:\n  ${extra.join("\n  ")}`);
  } else {
    assertCleanTree(projectDir, "propose");
  }

  const branch = `proposal/${name}`;
  git(["checkout", "-q", "main"], projectDir);
  git(["checkout", "-q", "-b", branch], projectDir);
  const opened = new Date().toISOString();
  const proposalPath = join(".sdlc", "proposals", `${name}.md`);
  const tierLine = tier ? `tier: ${tier}\n` : "";
  writeText(join(projectDir, proposalPath),
    `---\ngate: ${gate}\nquestion: ${JSON.stringify(question)}\nrecommendation: ${JSON.stringify(recommendation)}\nopened: ${opened}\n${tierLine}---\n\n# ${question}\n\n**Recommendation.** ${recommendation}\n\n${page}\n`);
  const runPath = appendRun(projectDir, `propose ${name} at ${gate}`);
  // Everything the caller named, plus this command's own two files. Nothing is filtered
  // out: a stage that holds a gate builds no state site (`src/runner/finish-stage.mjs`),
  // so `paths` never carries a `site/` entry that something else already staged, and
  // dropping a path here would silently leave a change out of the proposal it belongs to.
  stageAll(projectDir, [proposalPath, relative(projectDir, runPath), ...(paths ?? [])]);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `propose(${gate}): ${name}`], projectDir);
  return { branch };
}

COMMANDS.propose = async ({ pos, flags }) => {
  const r = propose(process.cwd(), pos[0], { gate: flags.gate, question: flags.question, recommendation: flags.recommendation, page: flags.page ?? "", tier: flags.tier ?? null });
  console.log(`opened ${r.branch}`); return 0;
};

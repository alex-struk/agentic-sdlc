import { join, resolve } from "node:path";
import { git } from "../lib/git.mjs";
import { writeText } from "../lib/fsx.mjs";
import { appendRun } from "../lib/runrecord.mjs";
import { COMMANDS } from "../cli.mjs";

const SDLC_AUTHOR = ["-c", "user.name=sdlc", "-c", "user.email=sdlc@localhost"];

export function propose(projectDir, name, { gate, question, recommendation, page = "" }) {
  projectDir = resolve(projectDir);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("proposal name: lowercase letters, digits, hyphens");
  if (!gate || !question || !recommendation) throw new Error("propose needs --gate, --question and --recommendation");
  const branch = `proposal/${name}`;
  git(["checkout", "-q", "main"], projectDir);
  git(["checkout", "-q", "-b", branch], projectDir);
  const opened = new Date().toISOString();
  writeText(join(projectDir, ".sdlc", "proposals", `${name}.md`),
    `---\ngate: ${gate}\nquestion: ${JSON.stringify(question)}\nrecommendation: ${JSON.stringify(recommendation)}\nopened: ${opened}\n---\n\n# ${question}\n\n**Recommendation.** ${recommendation}\n\n${page}\n`);
  appendRun(projectDir, `propose ${name} at ${gate}`);
  git(["add", "-A"], projectDir);
  git([...SDLC_AUTHOR, "commit", "-q", "-m", `propose(${gate}): ${name}`], projectDir);
  return { branch };
}

COMMANDS.propose = async ({ pos, flags }) => {
  const r = propose(process.cwd(), pos[0], { gate: flags.gate, question: flags.question, recommendation: flags.recommendation, page: flags.page ?? "" });
  console.log(`opened ${r.branch}`); return 0;
};

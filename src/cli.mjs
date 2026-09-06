import { parseArgs } from "./lib/args.mjs";

export const COMMANDS = {};

const HELP = `sdlc <command> [args] [--flags]

  new <dir> --from <config.yaml>   create a project repo from a saved config
  new <dir> --interactive          create a project repo via the onboarding interview
  new <dir> --answers <brief.md>   run the interview against a written stakeholder brief (no person needed)
  init [dir]                       install the pipeline into a project (lockfile, packs, callers)
  checks [dir] [--self] [--json]   run the structural checks
  propose <name> --gate G1 --question "..." --recommendation "..."
  rule <name> approve|return --by <role> [--note "..."]
  status [dir]                     regenerate the state site
  doctor [dir]                     check tools, config and guardrails
`;

export async function main(argv) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  if (!cmd || cmd === "help" || flags.help) { console.log(HELP); return 0; }
  const fn = COMMANDS[cmd];
  if (!fn) { console.error(`unknown command: ${cmd}\n${HELP}`); return 2; }
  try { return await fn({ pos: rest, flags }); }
  catch (e) { console.error(e.message); return 1; }
}

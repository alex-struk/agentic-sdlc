import { parseArgs } from "./lib/args.mjs";

export const COMMANDS = {};

const HELP = `sdlc <command> [args] [--flags]

  new <dir> --from <config.yaml>   create a project repo from a saved config
  new <dir> --interactive          create a project repo via the onboarding interview
  new <dir> --answers <brief.md>   run the interview against a written stakeholder brief (no person needed)
  init [dir]                       install the pipeline into a project (lockfile, packs, callers)
  checks [dir] [--self] [--json]   run the structural checks
  propose <name> --gate G1 --question "..." --recommendation "..." [--page "..."] [--tier HIGH]
  rule <name> approve|return --by <role> [--note "..."]   or: rule <name> --by agent:<persona>
  rule --pending                   rule every open proposal an agent holds the gate for
  run <stage> [--slice N] [--domain X] [--target old|new] [--stale] [--dry-run]   run one pipeline stage
  resume [--again]                 continue an interrupted run
  status [dir]                     regenerate the state site
  doctor [dir]                     check tools, config and guardrails
  oracle up|down|status [--target <t>]   start/stop/inspect the old application via Docker Compose
`;

// Command modules (new.mjs, init.mjs, ...) import `COMMANDS` back from this module to
// register themselves, which makes this a genuine import cycle. A *static* bottom import
// here (`import "./commands/new.mjs"`) would evaluate those modules — and their top-level
// `COMMANDS.new = ...` assignment — before this module's own `export const COMMANDS = {}`
// line has run, since ES module evaluation always finishes a module's dependencies before
// running its own body, regardless of where the import appears in the file. That throws
// "Cannot access 'COMMANDS' before initialization" when this file is the entry point (e.g.
// `node bin/sdlc.mjs ...`, which imports this module first). Loading the command modules
// dynamically instead defers their evaluation until after this module has finished running
// its own top level, so `COMMANDS` is already the real object by the time they assign to it.
let commandsLoaded = null;
function loadCommands() {
  if (!commandsLoaded) commandsLoaded = Promise.all([import("./commands/new.mjs"), import("./commands/init.mjs"), import("./commands/checks.mjs"), import("./commands/doctor.mjs"), import("./commands/propose.mjs"), import("./commands/rule.mjs"), import("./commands/run.mjs"), import("./commands/resume.mjs"), import("./commands/status.mjs"), import("./commands/oracle.mjs")]);
  return commandsLoaded;
}

export async function main(argv) {
  await loadCommands();
  const { pos, flags } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  if (!cmd || cmd === "help" || flags.help) { console.log(HELP); return 0; }
  const fn = COMMANDS[cmd];
  if (!fn) { console.error(`unknown command: ${cmd}\n${HELP}`); return 2; }
  try { return await fn({ pos: rest, flags }); }
  catch (e) { console.error(e.message); return 1; }
}

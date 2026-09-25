import { resolve } from "node:path";
import { whatNext, formatNext, formatNextShort } from "../runner/next.mjs";
import { COMMANDS } from "../cli.mjs";

// Exit codes: something can run, nothing can run until a person acts, and nothing is left
// that this pipeline can run. A script tells the three apart without parsing the text.
export const NEXT_EXIT = Object.freeze({ run: 0, waiting: 3, idle: 4 });

// The block a run or a ruling ends with. Reading the record cannot change the outcome the
// command already reached, so a failure to read it is said and nothing more.
export function printNextBlock(projectDir) {
  try {
    console.log(formatNextShort(whatNext(projectDir)));
  } catch (e) {
    console.log(`next: could not be read (${e.message.split("\n")[0]})`);
  }
}

COMMANDS.next = async ({ pos, flags }) => {
  const r = whatNext(resolve(pos[0] ?? process.cwd()));
  console.log(flags.json ? JSON.stringify(r, null, 2) : formatNext(r));
  return NEXT_EXIT[r.state];
};

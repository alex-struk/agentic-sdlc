// `tests/generated/*` is derived, not authored — `writeGenerated` (src/spec/surface.mjs)
// is the only thing meant to touch it. This check is what catches a hand edit, or a
// contract that moved on without regenerating: it recomputes `generateTypes` from the
// live contract and compares byte for byte, the same idea as `checkCriteriaIndex` for
// `spec/criteria-index.json`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fsx.mjs";
import { loadContract, generateTypes } from "../spec/surface.mjs";

export function checkGenerated(projectDir) {
  const id = "generated";
  const genDir = join(projectDir, "tests", "generated");
  // A project before `derive-tests` has not generated anything yet; there is nothing
  // here for drift to be measured against.
  if (!existsSync(genDir)) return { id, ok: true, messages: [] };

  const messages = [];
  const contract = loadContract(projectDir);
  for (const e of contract.errors) messages.push(`${e.file}: ${e.message}`);

  // A contract that fails to load cannot be regenerated from, so there is nothing more
  // to compare — the load errors above are the whole story.
  if (contract.errors.length === 0) {
    const expected = generateTypes(contract);
    for (const [relPath, text] of Object.entries(expected)) {
      const abs = join(projectDir, relPath);
      if (!existsSync(abs)) { messages.push(`${relPath}: missing`); continue; }
      if (readText(abs) !== text) messages.push(`${relPath}: does not match the contract; regenerate with sdlc`);
    }
  }

  return { id, ok: messages.length === 0, messages };
}

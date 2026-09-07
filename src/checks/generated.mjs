// `tests/generated/*` is derived, not authored — `writeGenerated` (src/spec/surface.mjs)
// is the only thing meant to touch it. This check is what catches a hand edit, or a
// contract that moved on without regenerating: it recomputes `generateTypes` from the
// live contract and compares byte for byte, the same idea as `checkCriteriaIndex` for
// `spec/criteria-index.json`.
import { existsSync, readdirSync } from "node:fs";
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

  // `generateTypes` always returns the same three file names regardless of whether the
  // contract's *data* validates — only their content depends on that — so this set is
  // safe to use for the reverse-direction check below even when the contract has load
  // errors reported above.
  const expected = generateTypes(contract);

  // A contract that fails to load cannot be regenerated from, so there is nothing more
  // to compare — the load errors above are the whole story.
  if (contract.errors.length === 0) {
    for (const [relPath, text] of Object.entries(expected)) {
      const abs = join(projectDir, relPath);
      if (!existsSync(abs)) { messages.push(`${relPath}: missing`); continue; }
      if (readText(abs) !== text) messages.push(`${relPath}: does not match the contract; regenerate with sdlc`);
    }
  }

  // The other direction: a file under tests/generated/ that the generator would never
  // produce at all — hand-added, or left behind after a page was removed from the
  // contract — is drift the byte-for-byte comparison above can never catch, since it
  // only ever looks at the files it expects to exist.
  const expectedFiles = new Set(Object.keys(expected));
  for (const entry of readdirSync(genDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relPath = `tests/generated/${entry.name}`;
    if (!expectedFiles.has(relPath)) messages.push(`${relPath}: not produced by the generator`);
  }

  return { id, ok: messages.length === 0, messages };
}

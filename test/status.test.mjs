import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../src/commands/status.mjs";

test("site pages summarise criteria, gates and runs", () => {
  const d = mkdtempSync(join(tmpdir(), "sdlc-site-"));
  mkdirSync(join(d, ".sdlc/gates"), { recursive: true }); mkdirSync(join(d, ".sdlc/runs"), { recursive: true }); mkdirSync(join(d, "spec"), { recursive: true });
  writeFileSync(join(d, ".sdlc/config.yaml"), "profile: rebuild\nproject: { name: p, domains: [a] }\n");
  writeFileSync(join(d, "spec/criteria-index.json"), JSON.stringify({ criteria: [{ id: "R-1.1", state: "accepted" }, { id: "R-1.2", state: "proposed" }] }));
  writeFileSync(join(d, ".sdlc/gates/x.yaml"), "gate: G1\nverdict: approve\nby: agent:product-owner\nheld_by: agent\nnote: \"\"\nat: 2026-01-01T00:00:00Z\n");
  writeFileSync(join(d, ".sdlc/runs/2026-01-01.md"), "# Run record 2026-01-01\n\n- 10:00:00 init\n");
  const { pages } = buildSite(d);
  assert.equal(pages.length, 3);
  const index = readFileSync(join(d, "site/index.md"), "utf8");
  assert.match(index, /accepted\s*\|\s*1/); assert.match(index, /proposed\s*\|\s*1/);
  assert.match(readFileSync(join(d, "site/gates.md"), "utf8"), /agent-held/);
  assert.match(readFileSync(join(d, "site/runs.md"), "utf8"), /10:00:00 init/);
});

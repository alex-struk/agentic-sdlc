// test/fixture.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runChecks } from "../src/checks/index.mjs";
import { propose } from "../src/commands/propose.mjs";
import { rule } from "../src/commands/rule.mjs";
import { buildSite } from "../src/commands/status.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;

test("fixture project: create, fill constitution, checks green, propose, approve, site", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-fixture-"));
  // Isolate the egress name list from this machine's real one for the whole test, and
  // from before `newProject` runs: `init` seeds the default list, so an unset
  // SDLC_EGRESS_NAMES would have the test write under the developer's real home. An
  // existing-but-empty file wins the lookup outright. With an empty list the egress
  // check passes with a warning, which is expected here.
  const prev = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  try {
    const dir = join(tmp, "permit-intake");
    await newProject({ dir, from: FROM });
    const c = join(dir, "constitution.md");
    writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
    git(["add", "-A"], dir); git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "fill constitution"], dir);

    const results = await runChecks(dir);
    assert.deepEqual(results.filter((r) => !r.ok).map((r) => [r.id, r.messages]), []);

    propose(dir, "harness-ready", { gate: "G1", question: "Is the harness ready?", recommendation: "Yes: all structural checks pass on an empty proposal." });
    rule(dir, "harness-ready", "approve", { by: "tech-lead", note: "phase 0 exit" });
    const { pages } = buildSite(dir);
    assert.equal(pages.length, 3);
    assert.ok(existsSync(join(dir, "site/gates.md")));
  } finally {
    if (prev === undefined) delete process.env.SDLC_EGRESS_NAMES;
    else process.env.SDLC_EGRESS_NAMES = prev;
  }
});

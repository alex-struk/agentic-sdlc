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
import { rule, ruleByAgent } from "../src/commands/rule.mjs";
import { runStage } from "../src/commands/run.mjs";
import { buildSite } from "../src/commands/status.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;
const MOCK_DIR = new URL("../fixture-project/mock", import.meta.url).pathname;

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
    // index, gates, runs, journal, and one proposal page (harness-ready).
    assert.equal(pages.length, 5);
    assert.ok(existsSync(join(dir, "site/gates.md")));
    assert.ok(existsSync(join(dir, "site/proposals/harness-ready.md")));
    // The ruling above already folded a rebuilt site into its own commit, and the site
    // is a pure function of the state on disk, so the direct `buildSite` call above
    // rewrites the same bytes and leaves nothing to commit — which is what lets
    // `runStage` below start from a clean tree.
    assert.equal(git(["status", "--porcelain"], dir), "", "a rebuild of an unchanged site is a no-op");

    // The runner end to end, in CI: a real stage turn through the mock executor, then a
    // real persona ruling through the same mock, on the same fixture project the steps
    // above already brought to a green, committed state.
    const prevExecutor = process.env.SDLC_EXECUTOR;
    const prevMockDir = process.env.SDLC_MOCK_DIR;
    process.env.SDLC_EXECUTOR = "mock";
    process.env.SDLC_MOCK_DIR = MOCK_DIR;
    try {
      const probeResult = await runStage(dir, "probe");
      assert.equal(probeResult.ok, true);

      propose(dir, "probe-ruling", { gate: "G0", question: "Does the probe prove the runner?", recommendation: "Yes" });
      const ruling = await ruleByAgent(dir, "probe-ruling", { persona: "product-owner" });
      assert.equal(ruling.verdict, "approve");

      assert.ok(existsSync(join(dir, ".sdlc/journal/001-probe.md")));
      const gateText = readFileSync(join(dir, ".sdlc/gates/probe-ruling.yaml"), "utf8");
      assert.match(gateText, /rationale:/);
      assert.notEqual(git(["ls-files", "site/journal.md"], dir), "");
      assert.notEqual(git(["ls-files", "site/proposals/probe-ruling.md"], dir), "");
      assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "main");
      assert.equal(git(["status", "--porcelain"], dir), "");
    } finally {
      if (prevExecutor === undefined) delete process.env.SDLC_EXECUTOR;
      else process.env.SDLC_EXECUTOR = prevExecutor;
      if (prevMockDir === undefined) delete process.env.SDLC_MOCK_DIR;
      else process.env.SDLC_MOCK_DIR = prevMockDir;
    }
  } finally {
    if (prev === undefined) delete process.env.SDLC_EGRESS_NAMES;
    else process.env.SDLC_EGRESS_NAMES = prev;
  }
});

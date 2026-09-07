// test/git-identity.test.mjs — the identity every pipeline commit is authored with.
//
// `SDLC_AUTHOR` carries `commit.gpgsign=false` alongside the name and email because a
// machine identity has no signing key: on a checkout where signing is on, every commit
// the pipeline makes would otherwise die with "gpg failed to sign the data". The test
// turns signing on for the git processes the run spawns, through `GIT_CONFIG_COUNT` and
// friends (which git reads as configuration for every command, exactly as a global
// `commit.gpgsign = true` would), and asserts a full run still commits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, SDLC_AUTHOR } from "../src/lib/git.mjs";
import { newProject } from "../src/commands/new.mjs";
import { runStage } from "../src/commands/run.mjs";

const FROM = new URL("../fixture-project/fixture.config.yaml", import.meta.url).pathname;

async function makeProject(tmp) {
  const prevEgress = process.env.SDLC_EGRESS_NAMES;
  const emptyList = join(tmp, "empty-egress-names.txt");
  writeFileSync(emptyList, "");
  process.env.SDLC_EGRESS_NAMES = emptyList;
  const dir = join(tmp, "permit-intake");
  await newProject({ dir, from: FROM });
  const c = join(dir, "constitution.md");
  writeFileSync(c, readFileSync(c, "utf8").replace(/\{\{[A-Z_]+\}\}/g, "filled"));
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "fill constitution"], dir);
  return { dir, prevEgress };
}

test("SDLC_AUTHOR turns commit signing off", () => {
  assert.ok(SDLC_AUTHOR.includes("commit.gpgsign=false"));
  assert.ok(SDLC_AUTHOR.includes("tag.gpgsign=false"));
});

test("a pipeline commit succeeds on a checkout where commit signing is on", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "sdlc-gpg-"));
  const { dir, prevEgress } = await makeProject(tmp);
  const mockDir = mkdtempSync(join(tmpdir(), "sdlc-mock-"));
  writeFileSync(join(mockDir, "probe.json"), JSON.stringify({
    text: "wrote the probe file",
    files: { "app/PROBE.md": "2026-09-06 the runner works\n" },
  }));
  const prev = {
    count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0,
  };
  process.env.SDLC_EXECUTOR = "mock";
  process.env.SDLC_MOCK_DIR = mockDir;
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "commit.gpgsign";
  process.env.GIT_CONFIG_VALUE_0 = "true";
  try {
    // Signing really is on for anything that does not override it: a plain commit here
    // fails, which is what makes the run below a real test rather than a tautology.
    writeFileSync(join(dir, "canary.txt"), "x\n");
    git(["add", "-A"], dir);
    assert.throws(() => git(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "canary"], dir),
      /gpg failed to sign|gpg: skipped|secret key/);
    git(["reset", "-q", "--hard"], dir);
    git(["clean", "-qfd"], dir);

    const r = await runStage(dir, "probe");
    assert.equal(r.ok, true);
    assert.equal(git(["status", "--porcelain"], dir), "");
    assert.match(git(["log", "-1", "--format=%s"], dir), /stage\(probe\)/);
  } finally {
    delete process.env.SDLC_EXECUTOR; delete process.env.SDLC_MOCK_DIR;
    for (const [k, v] of [["GIT_CONFIG_COUNT", prev.count], ["GIT_CONFIG_KEY_0", prev.key], ["GIT_CONFIG_VALUE_0", prev.value]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (prevEgress === undefined) delete process.env.SDLC_EGRESS_NAMES; else process.env.SDLC_EGRESS_NAMES = prevEgress;
  }
});

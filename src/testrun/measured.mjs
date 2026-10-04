// What an earlier criterion's pass was measured against, so that a later verify of the same
// slice measures again only what has changed (`docs/decisions/0104`).
//
// A test's outcome is decided by the application it runs against, the test file itself and
// everything else the run reads: the adapter, the fixtures, the generated surface, the seed,
// the suite's own configuration, the helpers that sit beside the tests, the project's targets
// and the pipeline's own runner. The first is the application tree verify already records as
// `app_tree`; the last group is folded into one `harness` digest here; the test file is its
// own blob. A pass recorded against all three, all unchanged, is the pass the same run would
// give again, so it is carried rather than run.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitOk } from "../lib/git.mjs";

// The paths a test run reads besides the application and the test file. A directory is read
// as its tree and a file as its blob; one that does not exist is recorded as absent, so its
// appearing changes the digest too.
const HARNESS_PATHS = [
  "tests/adapters/new", "tests/fixtures", "tests/generated", "tests/seed",
  "tests/playwright.config.ts", "tests/package.json", "tests/package-lock.json", "tests/tsconfig.json",
  ".sdlc/config.yaml",
];

// Ledgers and notes kept beside the tests are not read by a test run; everything else there is
// (a helper a spec imports, a shared constant), and a change to it can change any test's outcome.
const NOT_READ_BY_A_RUN = /\.(?:ya?ml|md)$/;

// The pipeline's own part in a run: how the suite is started, reset and read back, and how the
// sandbox it runs against is brought up.
const PIPELINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PIPELINE_PATHS = ["src/testrun", "src/sandbox", "stacks"];

function filesUnder(dir) {
  let out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

let pipelineDigest = null;
function pipelineHarness() {
  if (pipelineDigest) return pipelineDigest;
  const h = createHash("sha256");
  for (const rel of PIPELINE_PATHS) {
    for (const f of filesUnder(join(PIPELINE_ROOT, rel))) {
      try { if (!statSync(f).isFile()) continue; } catch { continue; }
      h.update(f.slice(PIPELINE_ROOT.length)).update("\0").update(readFileSync(f)).update("\0");
    }
  }
  pipelineDigest = h.digest("hex");
  return pipelineDigest;
}

// Every file under tests/acceptance at `ref`, path to blob.
function acceptanceBlobs(projectDir, ref) {
  const out = new Map();
  if (!gitOk(["cat-file", "-e", `${ref}:tests/acceptance`], projectDir)) return out;
  for (const line of git(["ls-tree", "-r", ref, "--", "tests/acceptance"], projectDir).split("\n")) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

// What a run at `ref` would measure against: the application tree, the harness digest, and each
// acceptance test file's blob.
export function measureOf(projectDir, ref = "HEAD") {
  const h = createHash("sha256");
  for (const p of HARNESS_PATHS) {
    const id = gitOk(["cat-file", "-e", `${ref}:${p}`], projectDir) ? git(["rev-parse", `${ref}:${p}`], projectDir) : "-";
    h.update(`${p} ${id}\n`);
  }
  const blobs = acceptanceBlobs(projectDir, ref);
  const specs = new Map();
  for (const [path, blob] of blobs) {
    if (path.endsWith(".spec.ts")) specs.set(path, blob);
    else if (!NOT_READ_BY_A_RUN.test(path)) h.update(`${path} ${blob}\n`);
  }
  h.update(`pipeline ${pipelineHarness()}\n`);
  return {
    appTree: gitOk(["cat-file", "-e", `${ref}:app`], projectDir) ? git(["rev-parse", `${ref}:app`], projectDir) : "",
    harness: h.digest("hex"),
    specs,
  };
}

// The latest verify of this slice, on any branch its build has gone under, that measured the
// earlier criteria against this application and this harness: `{ from, passed }`, where `passed`
// is criterion id to the blob of the test file it passed with. Null where there is none.
export function priorMeasure(projectDir, sliceNumber, branches, measure) {
  const rel = `tests/results/new/slice-${sliceNumber}.json`;
  let best = null;
  for (const { branch } of branches) {
    if (!gitOk(["cat-file", "-e", `${branch}:${rel}`], projectDir)) continue;
    let result;
    try { result = JSON.parse(git(["show", `${branch}:${rel}`], projectDir)); } catch { continue; }
    const m = result?.measured;
    if (!m?.passed || result.app_tree !== measure.appTree || m.harness !== measure.harness) continue;
    if (!best || String(result.at ?? "") > String(best.at)) best = { from: result.proposal, at: result.at ?? "", passed: m.passed };
  }
  return best && { from: best.from, passed: best.passed };
}

// The criterion a spec file is the test of.
export const criterionOf = (file) => file.split("/").at(-1).replace(/\.spec\.ts$/, "");

// Which of `files` a prior measure already passed with the very test file each is now.
export function carriedFrom(prior, files, measure) {
  const carried = new Set();
  if (!prior) return carried;
  for (const f of files) {
    const blob = measure.specs.get(f);
    if (blob && prior.passed[criterionOf(f)] === blob) carried.add(f);
  }
  return carried;
}

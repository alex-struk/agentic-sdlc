// `calibrate` runs the blind acceptance suite against a real target — the old
// application, started as the oracle — and turns the result into one row per criterion.
// A row that fails is not a defect report: it is a question about which of three things
// is wrong (the old application, the criterion, or the test), and only the product owner
// can answer it. So the stage writes the rows, opens one G1 proposal over every failure
// nobody has ruled on yet, and applies the answers on its next run.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { readText, writeText } from "../lib/fsx.mjs";
import { git, gitOk, stagePaths, SDLC_AUTHOR } from "../lib/git.mjs";
import { checkSandboxPassword, checkTargetOption, escapeRe, followUpState, skillPath } from "./shared.mjs";
import { parseDomainFile, parseAll, applyCalibrateRulings, calibrateConditionIds, serialiseDomainFile, writeIndex, renderSpecIndex, compareIds, CALIBRATE_GRAMMAR, TRIAGE_GRAMMAR, parseTriageConditions } from "../spec/criteria.mjs";
import { close as closeOwed, open as openOwed } from "../spec/owed.mjs";
import { syncMissingTests } from "../spec/missing-tests.mjs";
import { checkTests, loadIndex } from "../checks/tests.mjs";
import { readLocal } from "../oracle/ports.mjs";
import { oracleUp, instancesOf } from "../commands/oracle.mjs";
import { runSuite, sortRows } from "../testrun/playwright.mjs";
import { propose } from "../commands/propose.mjs";

// How the suite puts the target's data back between tests. Only the oracle has one: it is
// the target this pipeline knows how to rebuild, through the same seed it started from. A
// target with no configured database has nothing to reset and gets no command, so its suite
// runs as it always did.
function resetCommandFor(config, target, instance) {
  if (target !== config?.oracle?.target || !config?.oracle?.db) return undefined;
  const bin = resolvePath(fileURLToPath(import.meta.url), "../../../bin/sdlc.mjs");
  return `node ${JSON.stringify(bin)} oracle reseed --target ${target} --instance ${instance}`;
}

// The copies of the target the suite may spread across, each with the address, mail catcher
// and reset that belong to it. Only the oracle has them: it is the target this pipeline
// starts, and it is `oracle up` that recorded what it started.
function calibrateInstances(projectDir, config, target) {
  if (target !== config?.oracle?.target) return undefined;
  const copies = instancesOf(readLocal(projectDir, target));
  if (copies.length === 0) return undefined;
  return copies.map((c, i) => ({
    baseUrl: c.base_url,
    mailApi: c.mail_api ?? "",
    resetCommand: resetCommandFor(config, target, i),
  }));
}

function calibrateResultsDir(projectDir, target) {
  return join(projectDir, "tests", "results", target);
}

// `--target` defaults to the oracle's own target: calibrating the rebuild against the
// application it replaces is what this stage exists for. Any other target has to be
// named, and has to be one `config.targets` configures with a base URL — calibrating
// against `new` is a legitimate later use with no oracle lifecycle of its own.
function calibrateTarget(ctx) {
  return ctx.target ?? ctx.config?.oracle?.target;
}

// The criteria index, through the one reader every other caller of it uses. `byId` is
// what puts a criterion's current version and statement on a results row and on the
// follow-up page; `generatedFrom` is the commit the results file records as the spec it
// ran against.
function calibrateIndex(projectDir) {
  const index = loadIndex(projectDir);
  if (!index || index.parseError) return { generatedFrom: "", byId: new Map() };
  return {
    generatedFrom: index.generated_from ?? "",
    byId: new Map((index.criteria ?? []).map((c) => [c.id, c])),
  };
}

// Where the suite is pointed, and — for the oracle — making sure it is actually running
// first. `oracle up` is idempotent (`src/commands/oracle.mjs`), so this is a no-op
// against a target already up and the way it gets started when it is not. Under
// `SDLC_ORACLE=mock` nothing is started at all, so a project that has never run `oracle
// up` has no local file to read the URLs out of; the mock test runner never calls either
// URL.
//
// Two URLs come back, and they are not interchangeable. `baseUrl` is where this machine's
// suite actually points — for the oracle, a port chosen at `oracle up` time out of
// whatever was free, which means nothing on anybody else's machine. `configured` is what
// the project's own config names for the target, and that is the one the committed
// results file records, so a result set says which target it ran against rather than
// which port one laptop happened to get.
async function calibrateEndpoint(projectDir, ctx, target) {
  if (target !== "old") {
    const configured = ctx.config?.targets?.[target]?.base_url ?? "";
    return { baseUrl: configured, mailApi: "", configured };
  }
  if (process.env.SDLC_ORACLE !== "mock") await oracleUp(projectDir, { target });
  const local = readLocal(projectDir, target);
  return {
    baseUrl: local?.base_url ?? "http://mock",
    mailApi: local?.mail_api ?? "",
    configured: ctx.config?.oracle?.base_url ?? "",
  };
}

// What this target's rulings have already done to the spec, and which gate files did it.
// `applied` names the gate files whose conditions are on disk already, so a re-run reads
// the same ruling and applies nothing a second time; `rulings` records each condition as
// `{ id, version, verb, gate }`, which is what lets a row say it was ruled on — and stop
// saying so once the criterion moves on to a version nobody has ruled on.
function readCalibrateApplied(projectDir, target) {
  const p = join(calibrateResultsDir(projectDir, target), "applied.yaml");
  if (!existsSync(p)) return { applied: [], rulings: [] };
  let doc;
  try { doc = parseYaml(readText(p)) ?? {}; } catch { return { applied: [], rulings: [] }; }
  return {
    applied: Array.isArray(doc.applied) ? doc.applied : [],
    rulings: Array.isArray(doc.rulings) ? doc.rulings : [],
  };
}

// Every calibration gate file for this target, oldest first, so a later ruling's
// condition on a criterion is applied after (and therefore over) an earlier one's — the
// same ordering rule `readRulings` follows for ratification.
function calibrateGateNames(projectDir, target) {
  const dir = join(projectDir, ".sdlc", "gates");
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^calibrate-${escapeRe(target)}-(\\d+)\\.yaml$`);
  return readdirSync(dir)
    .map((f) => [f, re.exec(f)])
    .filter(([, m]) => m)
    .sort((a, b) => Number(a[1][1]) - Number(b[1][1]))
    .map(([f]) => f.replace(/\.yaml$/, ""));
}

// Applies every approved calibration ruling for this target that has not been applied
// before, across every domain file — a ruling names criteria by id, and an id belongs to
// exactly one domain, so each domain file is read once and offered the whole condition
// list.
//
// A domain file is rewritten only when a condition actually changed something in it. Two
// files are therefore never touched at all: one no ruling named, and one that does not
// parse. The first matters because rewriting is lossy in a way reading is not — a domain
// still in the shape an agent wrote it, awaiting ratification, comes back out of the
// serialiser in the canonical shape, so a pass that rewrote every file would reformat
// work nobody had ruled on yet. The second matters more: the parser reports what it could
// not read in `errors` and returns the criteria it could, so serialising that would
// delete the malformed blocks outright. Instead the file is left exactly as it is, the
// conditions it was holding are reported unapplied, and the ruling that carried them is
// left unrecorded so the next run — after somebody fixes the file — reads it again.
function applyCalibrateGates(projectDir, target, today) {
  const state = readCalibrateApplied(projectDir, target);
  const gates = [];
  for (const name of calibrateGateNames(projectDir, target)) {
    if (state.applied.includes(name)) continue;
    let gate;
    try { gate = parseYaml(readText(join(projectDir, ".sdlc", "gates", `${name}.yaml`))) ?? {}; } catch { continue; }
    // A returned or escalated ruling decided nothing, and is left unapplied *and*
    // unrecorded, so the ruling that eventually replaces it is still read.
    if (gate.verdict !== "approve") continue;
    gates.push({ name, conditions: (gate.conditions ?? []).map(String), unparsed: (gate.unparsed_conditions ?? []).map(String) });
  }

  const result = { changed: [], applied: [], unknown: [], gateNames: [], specChanged: false };
  if (gates.length === 0) return result;

  // Which ruling a condition line came from, for the record `applied.yaml` keeps. First
  // one wins, so a line repeated verbatim by a later ruling is still credited to the
  // ruling that first said it.
  const owner = new Map();
  for (const g of gates) for (const line of g.conditions) if (!owner.has(line)) owner.set(line, g.name);
  const conditions = gates.flatMap((g) => g.conditions);
  const named = calibrateConditionIds(conditions);
  const { byId } = calibrateIndex(projectDir);

  const domainsDir = join(projectDir, "spec", "domains");
  const files = existsSync(domainsDir) ? readdirSync(domainsDir).filter((f) => f.endsWith(".md")).sort() : [];
  const redo = [];
  // Rulings that named a criterion in a file this pass would not rewrite, so they are not
  // recorded as applied and are read again next run.
  const held = new Set();
  for (const f of files) {
    const domain = f.replace(/\.md$/, "");
    const abs = join(domainsDir, f);
    const original = readText(abs);
    const { criteria, errors, preamble } = parseDomainFile(original, domain);
    if (errors.length) {
      // Which conditions this file was holding, from the two sources that can still say
      // so once the parser has given up on part of it: the criteria the parser did
      // recover from this file, and the index, which is the project's own record of
      // which domain owns an id and still answers for a criterion in the block that
      // failed.
      const recovered = new Set(criteria.map((c) => c.id));
      const blocked = named.filter(({ id }) => recovered.has(id) || byId.get(id)?.domain === domain);
      result.unknown.push(`spec/domains/${domain}.md does not parse; ${blocked.length} condition(s) not applied`);
      for (const { line } of blocked) held.add(owner.get(line));
      continue;
    }
    const { criteria: next, applied, redo: domainRedo } = applyCalibrateRulings(criteria, conditions, today);
    // No condition named a criterion in this file, so this pass has no business writing
    // it — not even to the byte-identical text the serialiser would produce for a file
    // already in canonical shape, and certainly not to the reformatted text it would
    // produce for one still in the shape it was written in.
    if (applied.length === 0) continue;
    for (const a of applied) result.applied.push({ ...a, gate: owner.get(a.line) ?? null });
    redo.push(...domainRedo);
    const serialised = serialiseDomainFile(next, domain, preamble);
    if (serialised !== original) {
      writeText(abs, serialised);
      result.changed.push(`spec/domains/${domain}.md`);
      result.specChanged = true;
    }
  }

  const redoPath = openOwed(projectDir, "redo", redo).path;
  if (redoPath) result.changed.push(redoPath);


  // A condition no domain claimed names an id the project does not have — a typo, or an
  // id from before a domain was renamed — or belongs to a file this pass refused to
  // rewrite. Reported in the run's own text rather than thrown, the same way `ratify`
  // reports an unknown ratification condition: one bad line must not block every other
  // line in the same ruling. A line the grammar could not read at all is already recorded
  // on the gate file itself and is carried through here too, so every kind of dead
  // condition is named in one place.
  const appliedLines = new Set(result.applied.map((a) => a.line));
  for (const g of gates) {
    for (const line of g.conditions) if (!appliedLines.has(line)) result.unknown.push(`${g.name}: ${line}`);
    for (const line of g.unparsed) result.unknown.push(`${g.name}: ${line} (does not match the calibration grammar)`);
  }

  result.gateNames = gates.map((g) => g.name).filter((n) => !held.has(n));
  // Every verb is idempotent against a row it has already changed, so a held ruling's
  // other conditions being applied again next run changes nothing; the record of them is
  // de-duplicated here so `applied.yaml` does not grow a copy per run.
  const seen = new Set();
  const rulings = [...state.rulings, ...result.applied.map((a) => ({ id: a.id, version: a.version, verb: a.verb, gate: a.gate }))]
    .filter((r) => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });
  const rel = `tests/results/${target}/applied.yaml`;
  const abs = join(projectDir, rel);
  const text = stringifyYaml({ applied: [...state.applied, ...result.gateNames], rulings });
  // Written, and counted as changed, only when the record actually differs — the same
  // guard `writeGenerated` applies to its own output. Every ruling this run saw held
  // (the domain file it named does not parse) leaves `state` untouched, so the record
  // re-serialises to the text already on disk; committing that would claim a ruling was
  // applied when nothing was.
  const existing = existsSync(abs) ? readText(abs) : undefined;
  if (existing !== text) {
    writeText(abs, text);
    result.changed.push(rel);
  }
  return result;
}

// The tree the adapter for this target has at `HEAD`, as git names it. An `adapter-wrong`
// verdict is a finding about one version of the adapter, so it is recorded against this and
// lapses once the adapter has changed — see `expireAdapterVerdicts`.
function adapterTree(projectDir, target) {
  const ref = `HEAD:tests/adapters/${target}`;
  return gitOk(["rev-parse", ref], projectDir) ? git(["rev-parse", ref], projectDir) : "";
}

function writeApplied(projectDir, target, applied, rulings) {
  const rel = `tests/results/${target}/applied.yaml`;
  const abs = join(projectDir, rel);
  const seen = new Set();
  const unique = rulings.filter((r) => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });
  const text = stringifyYaml({ applied, rulings: unique });
  const existing = existsSync(abs) ? readText(abs) : undefined;
  if (existing === text) return null;
  writeText(abs, text);
  return rel;
}

// Every approved triage ruling for this target not applied before. The reviewer sorts a
// calibration's failures before any reaches the product owner: `adapter-wrong` puts the
// criterion on the rebind list and takes its row out of both queues, and `product-question`
// marks the row as sorted so the product owner is asked about it. Neither touches the spec,
// because both say the spec is not where the trouble is — or not yet known to be.
export function applyTriageGates(projectDir, target) {
  const result = { changed: [], applied: [], gateNames: [] };
  const dir = join(projectDir, ".sdlc", "gates");
  if (!existsSync(dir)) return result;
  const re = new RegExp(`^calibrate-triage-${escapeRe(target)}-(\\d+)\\.yaml$`);
  const names = readdirSync(dir)
    .map((f) => [f, re.exec(f)]).filter(([, m]) => m)
    .sort((a, b) => Number(a[1][1]) - Number(b[1][1]))
    .map(([f]) => f.replace(/\.yaml$/, ""));
  const state = readCalibrateApplied(projectDir, target);
  const { byId } = calibrateIndex(projectDir);
  const tree = adapterTree(projectDir, target);
  const rebind = [];
  for (const name of names) {
    if (state.applied.includes(name)) continue;
    let gate;
    try { gate = parseYaml(readText(join(dir, `${name}.yaml`))) ?? {}; } catch { continue; }
    if (gate.verdict !== "approve") continue;
    for (const c of parseTriageConditions((gate.conditions ?? []).map(String))) {
      const version = byId.get(c.id)?.version;
      if (version === undefined) continue;
      result.applied.push({ id: c.id, version, verb: c.verb, gate: name, ...(c.verb === "adapter-wrong" ? { adapter: tree } : {}) });
      if (c.verb === "adapter-wrong") rebind.push({ id: c.id, target, why: c.text });
    }
    result.gateNames.push(name);
  }
  if (result.gateNames.length === 0) return result;
  const rel = writeApplied(projectDir, target, [...state.applied, ...result.gateNames], [...state.rulings, ...result.applied]);
  if (rel) result.changed.push(rel);
  const rebindPath = openOwed(projectDir, "rebind", rebind).path;
  if (rebindPath) result.changed.push(rebindPath);
  return result;
}

// An `adapter-wrong` verdict lapses once the adapter it was about has changed. Kept for ever,
// it would hold a criterion out of both queues after the binding run meant to fix it had
// already landed — so a fix that did not work would never be noticed, because nothing would
// ask about the row again. Dropped here, the row is a question again on this run: if it now
// passes, nothing more happens, and if it still fails, the reviewer sees it afresh. Its entry
// on the rebind list is closed too, since a new adapter has been written since it was added;
// a finding made again about the new adapter is a second send of the same binding.
export function expireAdapterVerdicts(projectDir, target) {
  const state = readCalibrateApplied(projectDir, target);
  const tree = adapterTree(projectDir, target);
  const lapsed = state.rulings.filter((r) => r?.verb === "adapter-wrong" && r.adapter !== tree);
  if (lapsed.length === 0) return [];
  const changed = [];
  const rel = writeApplied(projectDir, target, state.applied, state.rulings.filter((r) => !lapsed.includes(r)));
  if (rel) changed.push(rel);
  const lapsedIds = new Set(lapsed.map((r) => r.id));
  const rebindPath = closeOwed(projectDir, "rebind", (e) => e.target === target && lapsedIds.has(e.id), {
    outcome: "met", why: `tests/adapters/${target} has changed since this was found`, by: "runner:calibrate",
  });
  if (rebindPath) changed.push(rebindPath);
  return changed;
}

// The rulings this run applied, committed on their own before the suite runs. Applying a
// ruling rewrites tracked spec files and the criteria index; running a suite afterwards
// can throw for reasons that have nothing to do with those edits (no browser, no npm
// registry, the target gone), and a throw out of `execute` leaves whatever is in the
// working tree behind. Committing here means a failure leaves a clean tree with the
// rulings safe, and the next run reads `applied.yaml` and applies nothing twice.
// A pass that wrote nothing has nothing to commit.
function commitAppliedRulings(projectDir, rulings, paths) {
  if (paths.length === 0) return false;
  stagePaths(projectDir, paths);
  // Staging by name is not proof anything landed in the index: every ruling this run
  // saw could have been held (the domain file it named does not parse), in which case
  // `applyCalibrateGates` re-serialises `applied.yaml` to the text already on disk and
  // nothing here is actually different from HEAD. `git diff --cached --quiet` is the
  // ground truth for that — exit 0 means the index matches HEAD — so a run with nothing
  // real to record makes no commit and leaves these paths for `finishStage`'s ordinary
  // commit, which will find the same empty diff and also do nothing.
  if (gitOk(["diff", "--cached", "--quiet"], projectDir)) return false;
  const names = rulings.gateNames.join(", ");
  const subject = names ? `stage(calibrate): apply rulings ${names}` : "stage(calibrate): apply rulings";
  git([...SDLC_AUTHOR, "commit", "-q", "-m", subject], projectDir);
  return true;
}

// The verb an applied ruling gave this criterion, but only while the criterion is still
// the one that was ruled on: a `spec-wrong` ruling records the version its own edit
// produced, so a criterion later moved on again by archaeology or another calibration
// pass comes back unruled and is asked about afresh.
function calibrateRuledVerb(rulings, id, version) {
  // `product-question` is not a ruling: it says a failure is the product owner's to rule
  // on, and until they have, the row is still an open question.
  const matches = rulings.filter((r) => r?.id === id && r?.version === version && r?.verb !== "product-question");
  return matches.length ? matches[matches.length - 1].verb : null;
}

// Whether the reviewer has sorted this row and passed it on, on the same version-bound
// reading as a ruling: a criterion that has moved on since is sorted afresh.
function calibrateTriagedForProduct(rulings, id, version) {
  return rulings.some((r) => r?.id === id && r?.version === version && r?.verb === "product-question");
}

// Rows this target's results file must account for: every accepted criterion of every
// domain that has at least one test file. A domain nobody has derived tests for yet is
// not this run's business — `derive-tests` has not reached it — but once a domain has any
// test at all, a criterion of it missing from the results is a criterion nothing ran and
// nothing reported, which is exactly what this stage exists to make impossible.
//
// A criterion carrying `supersededBy` is excluded, on the same reading `derive-tests` uses
// to decide what to write a test for: it has been replaced by another criterion, a test for
// it could only ever contradict its replacement, and so it deliberately has none. Expecting
// a row for it would fail every calibration of a spec that had ever corrected itself.
export function calibrateExpectedIds(projectDir) {
  const { byId } = calibrateIndex(projectDir);
  const accepted = [...byId.values()].filter((c) => c.state === "accepted" && !c.supersededBy);
  const acceptanceDir = join(projectDir, "tests", "acceptance");
  const withTests = new Set();
  if (existsSync(acceptanceDir)) {
    for (const entry of readdirSync(acceptanceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (readdirSync(join(acceptanceDir, entry.name)).some((f) => f.endsWith(".spec.ts"))) withTests.add(entry.name);
    }
  }
  return accepted.filter((c) => withTests.has(c.domain)).map((c) => c.id);
}

function readLatestResults(projectDir, target) {
  const p = join(calibrateResultsDir(projectDir, target), "latest.json");
  if (!existsSync(p)) return { error: `tests/results/${target}/latest.json is missing` };
  try { return { results: JSON.parse(readText(p)) }; }
  catch (e) { return { error: `tests/results/${target}/latest.json does not parse: ${e.message}` }; }
}

// The name of the dated result set this run writes: `<date>.json`, or `<date>-2.json`,
// `-3.json` and so on when that day already has one. A dated file is the record of a
// particular run against a particular target, so a second run on the same day is a second
// record and not a correction of the first — overwriting it would quietly lose the
// morning's evidence the moment somebody re-ran after lunch. `latest.json` is the file
// that *is* meant to be overwritten, and it is written every time.
function nextDatedResultsName(dir, today) {
  if (!existsSync(join(dir, `${today}.json`))) return `${today}.json`;
  let n = 2;
  while (existsSync(join(dir, `${today}-${n}.json`))) n++;
  return `${today}-${n}.json`;
}

// A scoped run's rows, laid over whatever the last full run recorded. Rows this run did not
// produce are kept exactly as they were — including the `at` of the file they came from,
// which is why the merged result is honest about being partly older: a row nobody re-ran
// says what it said last time, and the dated file beside it records when that was.
function mergeRows(projectDir, target, fresh) {
  const { results } = readLatestResults(projectDir, target);
  const previous = Array.isArray(results?.rows) ? results.rows : [];
  const byId = new Map(previous.map((r) => [r?.id, r]));
  for (const row of fresh) byId.set(row.id, row);
  return sortRows([...byId.values()]);
}

// `--domain` is optional and narrows the suite to that domain. It has to name a domain the
// project has, and there has to be a full result set already: a scoped run lays its rows
// over the ones on file, and with nothing to lay them over the result would be a results
// file that accounts for one domain and silently omits the other seven.
// `--skip-suite` works over the rows already on file, so there must be some, and they must be
// a full set: combined with `--domain` it would have nothing to narrow, since no suite runs.
function checkCalibrateSkipSuite(projectDir, ctx) {
  const id = "calibrate-skip-suite";
  if (!ctx.skipSuite) return { id, ok: true, messages: [] };
  if (ctx.domain !== undefined) return { id, ok: false, messages: ["calibrate: --skip-suite runs no tests, so --domain has nothing to narrow"] };
  if (!existsSync(join(calibrateResultsDir(projectDir, ctx.target), "latest.json")))
    return { id, ok: false, messages: [`calibrate --skip-suite: no results on file for ${ctx.target}; run calibrate first`] };
  return { id, ok: true, messages: [] };
}

function checkCalibrateDomain(projectDir, ctx) {
  const id = "calibrate-domain";
  if (ctx.domain === undefined) return { id, ok: true, messages: [] };
  const domains = ctx.config?.project?.domains ?? [];
  if (domains.length && !domains.includes(ctx.domain))
    return { id, ok: false, messages: [`calibrate: ${ctx.domain} is not one of config.project.domains`] };
  if (!existsSync(join(calibrateResultsDir(projectDir, ctx.target), "latest.json")))
    return { id, ok: false, messages: [`calibrate --domain: no full result set yet for ${ctx.target}; run calibrate without --domain first`] };
  return { id, ok: true, messages: [] };
}

function checkCalibrateResults(projectDir, target) {
  const id = "calibrate-results";
  const { results, error } = readLatestResults(projectDir, target);
  if (error) return { id, ok: false, messages: [error] };
  const rows = Array.isArray(results.rows) ? results.rows : null;
  if (!rows) return { id, ok: false, messages: [`tests/results/${target}/latest.json has no rows`] };
  const covered = new Set(rows.map((r) => r?.id));
  const missing = calibrateExpectedIds(projectDir).filter((c) => !covered.has(c));
  if (missing.length)
    return { id, ok: false, messages: [`tests/results/${target}/latest.json has no row for: ${missing.join(", ")}`] };
  return { id, ok: true, messages: [] };
}

// A failing row is a question, and a question needs an id to be asked about: the
// follow-up proposal names each criterion by its own id, and a ruling answers by naming
// it back. A `fail` row with no id at all — a spec file whose provenance header did not
// parse, so nothing could say which criterion it belongs to — can never be ruled on and
// would sit in the results forever as a failure nobody is able to answer. Every other
// failing row either carries the verb an applied ruling gave it, or is what `followUp`
// opens the next calibration proposal over the moment this run's commit lands.
function checkCalibrateFailsAnswerable(projectDir, target) {
  const id = "calibrate-fails-answerable";
  const { results, error } = readLatestResults(projectDir, target);
  if (error) return { id, ok: true, messages: [] };
  const orphans = (results.rows ?? []).filter((r) => r?.result === "fail" && !r.id);
  if (orphans.length)
    return {
      id, ok: false,
      messages: orphans.map((r) => `${r.file ?? "(no file)"}: failed with no criterion id to rule on — ${r.error ?? "see the results file"}`),
    };
  return { id, ok: true, messages: [] };
}

// Every failing row nobody has ruled on, in id order — what `followUp` asks about and
// what `execute` names in its own summary, read from the same results file so the two can
// never disagree about which criteria are still open questions.
function calibrateUnruledFailures(results) {
  return (results?.rows ?? [])
    .filter((r) => r?.result === "fail" && r.id && !r.ruled)
    .sort((a, b) => compareIds(a.id, b.id));
}

// A test failure's message can be a whole page of diff, and the persona needs enough of
// it to tell a real behavioural difference from a broken test — the first lines carry the
// assertion and the values, and the rest is stack.
function trimFailure(text, limit = 20) {
  const lines = String(text).split("\n");
  return lines.length <= limit ? lines.join("\n") : [...lines.slice(0, limit), `… ${lines.length - limit} more line(s)`].join("\n");
}

// The page of the calibration proposal: every criterion that failed against the target
// with no ruling of its own, everything the persona needs to rule on it without opening
// the domain file or the report — the criterion as the spec states it, and the tests as
// they actually failed — and the grammar its answer has to be written in.
// The most failing criteria one proposal page carries. A calibration run against an
// application nobody has rebuilt yet can fail hundreds of criteria at once, and a page
// that long is neither readable nor rulable in one sitting; the ones past the cap come
// back on the next run's proposal, once these have been answered.
const CALIBRATE_PAGE_CAP = 40;

// The reviewer's page: the same evidence the product owner's carries, framed as the one
// technical question that has to be settled before theirs can be asked. Where the adapter
// lives is named, because the adapter is where the answer is visible.
function triagePage(target, baseUrl, rows, byId) {
  const shown = rows.slice(0, CALIBRATE_PAGE_CAP);
  const lines = [
    `${rows.length} criterion(s) failed against the **${target}** target at ${baseUrl}, and nobody has sorted them yet.`,
    `Before any reaches the product owner, say which of them this project's own adapter caused. The adapter is`,
    `under \`tests/adapters/${target}/\`; read each failure against it and against the test.`,
    "",
  ];
  if (shown.length < rows.length) {
    lines.push(`The ${shown.length} below are the ones to sort now; the remaining ${rows.length - shown.length} come back on the next run.`, "");
  }
  lines.push(...failureSections(shown, byId));
  lines.push("## Triage conditions", "", TRIAGE_GRAMMAR, "");
  return lines.join("\n");
}

function failureSections(rows, byId) {
  const lines = [];
  for (const row of rows) {
    const c = byId.get(row.id);
    lines.push(`### ${row.id} · v${c?.version ?? row.version}`, "");
    if (c?.statement) lines.push(c.statement, "");
    if (c?.given) lines.push(`- given: ${c.given}`);
    if (c?.when) lines.push(`- when: ${c.when}`);
    if (c?.then) lines.push(`- then: ${c.then}`);
    if (row.file) lines.push(`- test: ${row.file}`);
    lines.push("");
    const failing = (row.tests ?? []).filter((t) => t.status !== "passed" && t.status !== "skipped");
    if (failing.length === 0 && row.error) lines.push("```", trimFailure(row.error), "```", "");
    for (const t of failing) {
      lines.push(`**${t.title}** — ${t.status}`, "");
      lines.push("```", trimFailure(t.error ?? row.error ?? "(no failure message recorded)"), "```", "");
    }
  }
  return lines;
}

function calibratePage(target, baseUrl, rows, byId) {
  const shown = rows.slice(0, CALIBRATE_PAGE_CAP);
  const lines = [
    `${rows.length} criterion(s) failed against the **${target}** target at ${baseUrl}, with no ruling yet.`,
    "The tests are blind: they were written from the criteria alone, by an agent that never saw the",
    "application. So a failure means one of exactly three things, and only you can say which:",
    "the application is wrong, the criterion is wrong, or the test is wrong.",
    "",
    "Rule on each one below. Until every failure carries a ruling, this question is asked again on",
    "every calibration run.",
    "",
  ];
  if (shown.length < rows.length) {
    lines.push(`The ${shown.length} below are the ones to rule on now; the remaining ${rows.length - shown.length} come back on the next calibration run.`, "");
  }
  lines.push(...failureSections(shown, byId));
  lines.push("## Calibration conditions", "", CALIBRATE_GRAMMAR, "");
  return lines.join("\n");
}

// `calibrate` holds no gate and spawns no agent (`agent: false`, like `ratify`): running
// a suite and mapping its report onto criteria is mechanical. The judgement in the stage —
// what a failure means — is asked of two personas in turn, through the proposals `followUp`
// opens: the reviewer first sorts out the failures the project's own adapter caused, at G3,
// and only what it passes on goes to the product owner at G1.
export const calibrate = {
  name: "calibrate",
  title: (ctx) => (ctx?.target ? `calibrate against ${ctx.target}` : "calibrate"),
  skill: skillPath("calibrate"),
  workspace: "project",
  gate: null,
  agent: false,
  collect: [],
  implemented: true,
  async execute(projectDir, ctx) {
    const target = calibrateTarget(ctx);
    const today = new Date().toISOString().slice(0, 10);
    const changed = [];

    // `--skip-suite` applies whatever rulings came back and asks the next question, over the
    // rows already on file, without running anything. Sorting a calibration's failures and
    // then ruling on what is left are two rulings in a row with no change to the application
    // between them, and re-running a suite that takes hours to learn nothing new between the
    // two would make every calibration cost a morning more than it has to.
    const previous = ctx.skipSuite ? readLatestResults(projectDir, target).results : null;

    // 1. Where to point, and — for the oracle — that it is actually running.
    const { baseUrl, mailApi, configured } = ctx.skipSuite
      ? { baseUrl: "", mailApi: "", configured: previous?.base_url ?? "" }
      : await calibrateEndpoint(projectDir, ctx, target);

    // 2. Every ruling that came back since the last run, applied to the spec.
    const rulings = applyCalibrateGates(projectDir, target, today);
    const triage = applyTriageGates(projectDir, target);
    const rulingPaths = [...new Set([...rulings.changed, ...triage.changed, ...expireAdapterVerdicts(projectDir, target)])];

    // The index and the spec page are regenerated here, before the suite runs, rather
    // than after it: a `spec-wrong` ruling bumps a criterion's version, and staleness is
    // exactly the comparison between that version and the one written in the test's own
    // header — which `runSuite` reads out of the index. Regenerating afterwards would
    // report this run's own edits as passes or failures for one more run before the test
    // they invalidated was ever marked stale.
    if (rulings.specChanged) {
      const parsed = parseAll(projectDir);
      writeIndex(projectDir, parsed);
      renderSpecIndex(projectDir, parsed);
      rulingPaths.push("spec/criteria-index.json", "spec/spec.md");
    }
    // Committed here, before anything that can throw. `changed` still names these paths
    // when the commit did not happen, so the ordinary path — nothing to apply, nothing
    // committed — is unchanged.
    const allRulings = { ...rulings, gateNames: [...rulings.gateNames, ...triage.gateNames] };
    if (!commitAppliedRulings(projectDir, allRulings, rulingPaths)) changed.push(...rulingPaths);

    // 3. The suite itself, against the target. `--domain` narrows it to one domain, which
    // turns an afternoon into minutes when what is being checked is one fix; the rows it
    // returns are merged over the ones already on file, so `latest.json` stays a complete
    // account of every criterion rather than becoming a partial one.
    let rows;
    if (ctx.skipSuite) {
      rows = previous?.rows ?? [];
    } else {
      const { rows: fresh } = runSuite({
        projectDir, target, baseUrl, mailApi, domain: ctx.domain,
        instances: calibrateInstances(projectDir, ctx.config, target),
      });
      rows = ctx.domain === undefined ? fresh : mergeRows(projectDir, target, fresh);
    }

    // 4. The result set: a dated file per run, and `latest.json` beside it for everything
    // that just wants the current state. `base_url` is the target's configured URL, not
    // the one this run pointed at: for the oracle those differ, since `oracle up` picks
    // whatever port was free on this machine, and a committed file recording that would
    // be a local accident in shared history.
    const { generatedFrom, byId } = calibrateIndex(projectDir);
    const applied = readCalibrateApplied(projectDir, target);
    // Rows read back from a file already carry the marks of the run that wrote them, so they
    // are cleared first and worked out again from the rulings as they stand now.
    const ruledRows = rows.map(({ ruled: _r, triage: _t, ...row }) => {
      const version = row.id ? byId.get(row.id)?.version : undefined;
      const verb = row.id ? calibrateRuledVerb(applied.rulings, row.id, version) : null;
      const sorted = row.id && !verb && calibrateTriagedForProduct(applied.rulings, row.id, version);
      return { ...row, ...(verb ? { ruled: verb } : {}), ...(sorted ? { triage: "product-question" } : {}) };
    });
    const results = { target, base_url: configured, spec: generatedFrom, at: new Date().toISOString(), rows: ruledRows };
    const text = `${JSON.stringify(results, null, 2)}\n`;
    const dir = calibrateResultsDir(projectDir, target);
    // A run that ran nothing writes no dated file: that file is the record of a suite having
    // run, and a second one for the same results would read as a second run.
    for (const name of ctx.skipSuite ? ["latest.json"] : [nextDatedResultsName(dir, today), "latest.json"]) {
      const rel = `tests/results/${target}/${name}`;
      writeText(join(projectDir, rel), text);
      changed.push(rel);
    }

    // A missing test whose test these rows show ran at its current version is closed, with the
    // row as its evidence; one whose test exists and has not run is handed to this stage
    // (`src/spec/missing-tests.mjs`).
    const owed = syncMissingTests(projectDir, { config: ctx.config });
    if (owed.path) changed.push(owed.path);

    // 5. What happened, in the order a person reads it: how the suite came out, which
    // criteria are still questions, and what the last ruling actually did.
    const counts = new Map();
    for (const row of ruledRows) counts.set(row.result, (counts.get(row.result) ?? 0) + 1);
    const summary = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => `${n} ${k}`).join(", ");
    const lines = [`calibrate ${target}: ${ruledRows.length} row(s) — ${summary || "no rows"}.`];
    const unruled = calibrateUnruledFailures(results);
    if (unruled.length) lines.push(`Failing with no ruling: ${unruled.map((r) => r.id).join(", ")}`);
    const ruled = ruledRows.filter((r) => r.ruled);
    if (ruled.length) lines.push(`Ruled: ${ruled.map((r) => `${r.id} ${r.ruled}`).join(", ")}`);
    if (rulings.applied.length) {
      lines.push(`Applied ${rulings.applied.length} condition(s) from ${rulings.gateNames.join(", ") || "an earlier ruling"}:`);
      for (const a of rulings.applied) lines.push(`- ${a.verb} ${a.id}`);
    }
    if (rulings.unknown.length) {
      lines.push("Conditions not applied (reported, not acted on):");
      for (const u of rulings.unknown) lines.push(`- ${u}`);
    }
    // Said here rather than left to `followUp`'s silence: a run that finds failures and
    // opens nothing because the previous question is still unanswered has to say so, or
    // it reads as a run that decided the failures did not matter.
    if (triage.applied.length) lines.push(`Sorted ${triage.applied.length} failure(s) from ${triage.gateNames.join(", ")}: ${triage.applied.map((a) => `${a.id} ${a.verb}`).join(", ")}`);
    const open = followUpState(projectDir, `calibrate-triage-${target}`).open ?? followUpState(projectDir, `calibrate-${target}`).open;
    if (open && unruled.length) lines.push(`proposal/${open} is still open, so no second question is asked; rule it and run calibrate --skip-suite.`);

    return { text: lines.join("\n"), changed };
  },
  proposal() {
    return null;
  },
  preChecks(projectDir, ctx) {
    // Resolved onto `ctx` here, the one hook that sees both the config and the real
    // project directory before anything else runs, so `execute`, `postChecks`, `title`
    // and `followUp` all read the same target rather than each re-deriving the default.
    ctx.target = calibrateTarget(ctx);
    return [
      checkTargetOption("calibrate", ctx, {
        requireBaseUrl: true,
        missing: "calibrate needs --target <t>, or config.oracle.target for it to default to",
      }),
      checkSandboxPassword("calibrate", ctx, "calibrating"),
      checkCalibrateDomain(projectDir, ctx),
      checkCalibrateSkipSuite(projectDir, ctx),
    ];
  },
  postChecks(projectDir, ctx) {
    return [
      checkCalibrateResults(projectDir, ctx.target),
      checkCalibrateFailsAnswerable(projectDir, ctx.target),
      checkTests(projectDir, ctx),
    ];
  },
  // The question every failing row raises, asked once. Run after the calibration commit
  // has landed on `main`, so the proposal branches off a `main` that already holds the
  // results file the page is drawn from, and only on a successful run.
  followUp(projectDir, ctx) {
    const target = ctx.target;
    if (!target) return null;
    const { results } = readLatestResults(projectDir, target);
    if (!results) return null;
    const unruled = calibrateUnruledFailures(results);
    if (unruled.length === 0) return null;
    const { byId } = calibrateIndex(projectDir);

    // Sorted first. A failure nobody has sorted may be the adapter's, and the product owner
    // is never the one asked that; while any are unsorted, or a sorting is still waiting on
    // its ruling, nothing goes to the product owner at all.
    const unsorted = unruled.filter((r) => r.triage !== "product-question");
    const triageState = followUpState(projectDir, `calibrate-triage-${target}`);
    if (triageState.open) return null;
    if (unsorted.length) {
      const name = `calibrate-triage-${target}-${triageState.highest + 1}`;
      const { branch } = propose(projectDir, name, {
        gate: "G3",
        question: `${unsorted.length} criterion(s) fail against ${target}: which of them did this project's own adapter cause?`,
        recommendation: `Sort ${unsorted.slice(0, CALIBRATE_PAGE_CAP).map((r) => r.id).join(", ")} with a triage condition each, so the adapter's failures are fixed there and only product questions reach the product owner.`,
        page: triagePage(target, results.base_url ?? "", unsorted, byId),
      });
      return { name, gate: "G3", branch, failing: unsorted.length };
    }

    const { open, highest } = followUpState(projectDir, `calibrate-${target}`);
    if (open) return null;
    const name = `calibrate-${target}-${highest + 1}`;
    const { branch } = propose(projectDir, name, {
      gate: "G1",
      question: `${unruled.length} criterion(s) fail against ${target}: which of them is the application's fault, which the spec's, and which the test's?`,
      recommendation: `Rule on ${unruled.map((r) => r.id).join(", ")} with a calibration condition, so the next calibrate run can apply it.`,
      page: calibratePage(target, results.base_url ?? "", unruled, byId),
    });
    return { name, gate: "G1", branch, failing: unruled.length };
  },
};

// The `test-wrong` ruling records naming any of `ids`, dropped from every target's
// `tests/results/<target>/applied.yaml`. A `test-wrong` ruling says the criterion is right and
// its test is not; the record of it is what marks that criterion's row as already ruled on, so
// once `derive-tests` has written the test again the record has outlived its answer — left in
// place, the freshly written test's next failure would come back marked `ruled` and the
// product owner would never be asked about it.
//
// Only the per-id record in `rulings` is removed. The gate file stays named in `applied`, which
// is what stops a ruling that has already been acted on from being applied to the spec a
// second time.
export function dropTestWrongRulings(projectDir, ids) {
  const wanted = new Set(ids);
  const resultsDir = join(projectDir, "tests", "results");
  if (!wanted.size || !existsSync(resultsDir)) return [];
  const changed = [];
  for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = `tests/results/${entry.name}/applied.yaml`;
    const abs = join(projectDir, rel);
    if (!existsSync(abs)) continue;
    let doc;
    try { doc = parseYaml(readText(abs)) ?? {}; } catch { continue; }
    const rulings = Array.isArray(doc.rulings) ? doc.rulings : [];
    // The reviewer's `product-question` sorting of the same criterion goes too: it was a
    // verdict about the test that has just been replaced, and a test written again can fail
    // for a reason the adapter owns, so it is sorted afresh rather than sent straight on.
    const kept = rulings.filter((r) => !((r?.verb === "test-wrong" || r?.verb === "product-question") && wanted.has(r?.id)));
    if (kept.length === rulings.length) continue;
    writeText(abs, stringifyYaml({ ...doc, rulings: kept }));
    changed.push(rel);
  }
  return changed;
}

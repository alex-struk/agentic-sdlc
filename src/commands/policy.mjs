// `sdlc policy set`: propose a change to the `policy` block of `.sdlc/config.yaml`.
//
// Policy changes only through G-POL (`0043`), and a proposal is opened only by `propose`.
// `sdlc propose` by hand commits the page alone, and no stage may touch the configuration, so
// this is the command that carries a changed `.sdlc/config.yaml` into a proposal: the
// alternative is editing the project's configuration by hand, outside any ruling.
//
// The change is made to `main`'s copy of the file, because `main`'s is the policy it is
// ruled under and the one it replaces. It is made through the `yaml` library's Document,
// so the comments and layout of everything it does not touch survive. It is held to the
// schema and to the `config` check before anything is written, so a proposal that could
// never be merged into a working configuration is never opened.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { parse, parseDocument, Document, isMap, isScalar } from "yaml";
import { git, gitOk, gitRaw, assertCleanTree, assertOnMain, porcelainStatus } from "../lib/git.mjs";
import { checkConfigText } from "../checks/config.mjs";
import { propose, proposalPage } from "./propose.mjs";
import { CONFIG_PATH } from "../runner/ruling-config.mjs";
import schema from "../../schema/config.schema.json" with { type: "json" };
import { COMMANDS } from "../cli.mjs";

const GATE = "G-POL";
const POLICY_KEYS = Object.keys(schema.properties.policy.properties);
const NAME = /^[a-z0-9][a-z0-9-]*$/;

export const POLICY_USAGE = 'policy set <key>=<value> [--set <key>=<value> ...] [--unset <key> ...] --question "..." --recommendation "..." [--name <proposal-name>] [--dry-run]';

// A key as typed, `agents.backend` or `policy.agents.backend`, as the path under `policy`.
function policyPath(key) {
  const path = String(key).split(".");
  if (path[0] === "policy") path.shift();
  if (!path.length) throw new Error("policy set: name a key under policy (policy.<key>), not the block itself");
  if (path.some((p) => !p)) throw new Error(`policy set: ${key} is not a dotted key`);
  if (!POLICY_KEYS.includes(path[0])) {
    throw new Error(`policy set: ${path[0]} is not under policy; this command changes only the policy block, whose keys are ${POLICY_KEYS.join(", ")}`);
  }
  return path;
}

function parseSet(text) {
  const at = typeof text === "string" ? text.indexOf("=") : -1;
  if (at < 1) throw new Error(`policy set: ${JSON.stringify(text)} is not <key>=<value>`);
  const key = text.slice(0, at);
  const raw = text.slice(at + 1);
  const path = policyPath(key);
  if (!raw.trim()) throw new Error(`policy set: policy.${path.join(".")} has no value; to remove a key, use --unset ${path.join(".")}`);
  // The value is read as YAML, as the file would read it, and kept as a node so a flow map
  // typed on the command line is written as a flow map.
  const doc = parseDocument(raw);
  if (doc.errors.length) throw new Error(`policy set: the value of policy.${path.join(".")} is not YAML: ${doc.errors[0].message}`);
  return { kind: "set", path, node: doc.contents, value: doc.toJS() };
}

function parseUnset(key) {
  if (typeof key !== "string") throw new Error("policy set: --unset needs a key");
  return { kind: "unset", path: policyPath(key) };
}

const label = (path) => `policy.${path.join(".")}`;

function at(obj, path) {
  let v = obj;
  for (const p of path) {
    if (v === null || typeof v !== "object" || !(p in v)) return undefined;
    v = v[p];
  }
  return v;
}

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v;
}
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

// A value as one line of YAML, for the table of changes and for messages.
function show(v) {
  if (v === undefined) return null;
  return new Document(v).toString({ collectionStyle: "flow", lineWidth: 0 }).trim();
}

const lines = (t) => t.replace(/\n$/, "").split("\n");

// How one list of lines becomes another: each entry is `[op, line, i, j]`, where `op` is
// " " for a line both share, "-" for one only `x` has and "+" for one only `y` has, and `i`
// and `j` are where the walk stands in each. The files it is given are a configuration's
// length, so the quadratic table is a few thousand cells.
function lineOps(x, y) {
  const n = x.length, m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { ops.push([" ", x[i], i, j]); i++; j++; }
    else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) { ops.push(["+", y[j], i, j]); j++; }
    else { ops.push(["-", x[i], i, j]); i++; }
  }
  return ops;
}

// A line diff of two texts, in unified form with three lines of context.
export function unifiedDiff(a, b, { from = "a", to = "b", context = 3 } = {}) {
  const ops = lineOps(lines(a), lines(b));
  const changed = ops.map((o, k) => (o[0] === " " ? -1 : k)).filter((k) => k >= 0);
  if (!changed.length) return "";
  const hunks = [];
  for (const k of changed) {
    const last = hunks[hunks.length - 1];
    if (last && k - last.end <= 2 * context) last.end = k;
    else hunks.push({ start: k, end: k });
  }
  const out = [`--- ${from}`, `+++ ${to}`];
  for (const h of hunks) {
    const hunk = ops.slice(Math.max(0, h.start - context), Math.min(ops.length, h.end + context + 1));
    const aCount = hunk.filter((o) => o[0] !== "+").length;
    const bCount = hunk.filter((o) => o[0] !== "-").length;
    const aStart = hunk[0][2] + (aCount ? 1 : 0);
    const bStart = hunk[0][3] + (bCount ? 1 : 0);
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...hunk.map((o) => `${o[0]}${o[1]}`));
  }
  return `${out.join("\n")}\n`;
}

// The library writes a whole document in one style, and a file written by hand is rarely in
// it: `[a, b]` comes back as `[ a, b ]`, because one setting pads flow maps and sequences
// alike. So `main`'s file is written through the library unedited as well, and only the lines
// in which the edited rendering differs from that one are taken from it; every other line is
// `main`'s own. That needs the unedited rendering to match `main` line for line, and the
// result to read as the edited document does. Where either fails, the library's rendering is
// the result.
function overlay(mainText, baseline, edited) {
  const original = lines(mainText);
  const base = lines(baseline);
  if (original.length !== base.length) return edited;
  const out = [];
  for (const [op, line, i] of lineOps(base, lines(edited))) {
    if (op === " ") out.push(original[i]);
    else if (op === "+") out.push(line);
  }
  const text = `${out.join("\n")}\n`;
  try { return same(parse(text), parse(edited)) ? text : edited; }
  catch { return edited; }
}

// Applies the edits to `main`'s text and returns the new text. Everything is refused before
// anything is written: an edit that overlaps another, one that changes nothing, a key to
// unset that is not set.
function applyEdits(mainText, mainConfig, edits) {
  const keys = edits.map((e) => e.path.join("."));
  for (let a = 0; a < keys.length; a++) for (let b = a + 1; b < keys.length; b++) {
    const [p, q] = [keys[a], keys[b]];
    if (p === q || q.startsWith(`${p}.`) || p.startsWith(`${q}.`)) {
      throw new Error(`policy set: policy.${p} and policy.${q} overlap; name each key once`);
    }
  }
  const doc = parseDocument(mainText);
  const changes = [];
  for (const e of edits) {
    const full = ["policy", ...e.path];
    const before = at(mainConfig?.policy, e.path);
    if (e.kind === "unset") {
      if (before === undefined) throw new Error(`policy set: ${label(e.path)} is not set on main, so there is nothing to unset`);
      doc.deleteIn(full);
      // A map the removal leaves empty says nothing, so it goes too, up to the block itself.
      for (let k = full.length - 1; k > 1; k--) {
        const parent = doc.getIn(full.slice(0, k));
        if (isMap(parent) && parent.items.length === 0) doc.deleteIn(full.slice(0, k));
        else break;
      }
      changes.push({ key: label(e.path), before, after: undefined });
      continue;
    }
    if (same(before, e.value)) throw new Error(`policy set: ${label(e.path)} is already ${show(before)} on main`);
    // A value that replaces a scalar keeps the comment written beside it.
    const existing = doc.getIn(full, true);
    if (isScalar(existing) && isScalar(e.node)) {
      e.node.comment = existing.comment;
      e.node.commentBefore = existing.commentBefore;
      e.node.spaceBefore = existing.spaceBefore;
    }
    try { doc.setIn(full, e.node); }
    catch { throw new Error(`policy set: ${label(e.path)} cannot be set, because a key above it on main holds a value rather than a map`); }
    changes.push({ key: label(e.path), before, after: e.value });
  }
  // Line width 0: a flow map longer than a line is left on its one line rather than broken
  // across several.
  const options = { lineWidth: 0 };
  return { text: overlay(mainText, parseDocument(mainText).toString(options), doc.toString(options)), changes };
}

function page(changes, diff) {
  const cell = (v) => (v === undefined ? "*not set*" : `\`${show(v).replace(/\|/g, "\\|")}\``);
  return [
    "This proposal changes the `policy` block of `.sdlc/config.yaml`. A change to policy is ruled at",
    "G-POL, by the seat the policy on `main` names, and approving it merges the change onto `main`.",
    "",
    "## The change",
    "",
    "| Key | On `main` | Proposed |",
    "|---|---|---|",
    ...changes.map((c) => `| \`${c.key}\` | ${cell(c.before)} | ${cell(c.after)} |`),
    "",
    "## `.sdlc/config.yaml`",
    "",
    "```diff",
    diff.trimEnd(),
    "```",
  ].join("\n");
}

function slug(path) {
  return path.join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

// A proposal name is taken while a branch carries it or `main` holds its page or its gate
// file: a ruled proposal's branch may be gone, and its record is still under that name.
function nameTaken(projectDir, name) {
  if (git(["for-each-ref", "--format=%(refname)", `refs/heads/proposal/${name}`, `refs/remotes/*/proposal/${name}`], projectDir)) return true;
  return [`.sdlc/proposals/${name}.md`, `.sdlc/gates/${name}.yaml`].some((p) => gitOk(["cat-file", "-e", `main:${p}`], projectDir));
}

function proposalName(projectDir, requested, edits) {
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== "string" || !NAME.test(requested)) throw new Error("policy set: proposal name: lowercase letters, digits, hyphens");
    if (nameTaken(projectDir, requested)) throw new Error(`policy set: proposal ${requested} already exists; choose another --name`);
    return requested;
  }
  const base = `policy-${slug(edits[0].path)}`;
  let name = base;
  for (let n = 2; nameTaken(projectDir, name); n++) name = `${base}-${n}`;
  return name;
}

// Everything a dry run must leave as it found it: where HEAD is, what the tree holds and
// which branches exist.
function repositoryState(projectDir) {
  return [git(["rev-parse", "HEAD"], projectDir), porcelainStatus(projectDir), git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], projectDir)].join("\n");
}

export function policySet(projectDir, { set = [], unset = [], question, recommendation, name, dryRun = false } = {}) {
  if (!question || !recommendation || question === true || recommendation === true) {
    throw new Error("policy set needs --question and --recommendation");
  }
  const edits = [...set.map(parseSet), ...unset.map(parseUnset)];
  if (!edits.length) throw new Error(`policy set: name at least one change\n  usage: sdlc ${POLICY_USAGE}`);
  const dryRunState = dryRun ? repositoryState(projectDir) : null;

  if (!gitOk(["cat-file", "-e", `main:${CONFIG_PATH}`], projectDir)) throw new Error(`policy set: main carries no ${CONFIG_PATH}`);
  const mainText = gitRaw(["show", `main:${CONFIG_PATH}`], projectDir);
  const mainConfig = parse(mainText);
  const { text, changes } = applyEdits(mainText, mainConfig, edits);

  const checked = checkConfigText(text);
  if (!checked.ok) throw new Error(`policy set: the changed configuration is refused, and nothing was proposed:\n  ${checked.messages.join("\n  ")}`);
  const already = new Set(checkConfigText(mainText).warnings ?? []);
  const warnings = (checked.warnings ?? []).filter((w) => !already.has(w));

  const proposal = proposalName(projectDir, name, edits);
  const branch = `proposal/${proposal}`;
  const diff = unifiedDiff(mainText, text, { from: `main:${CONFIG_PATH}`, to: `${branch}:${CONFIG_PATH}` });
  const body = page(changes, diff);

  if (dryRun) {
    const preview = proposalPage(projectDir, { gate: GATE, question, recommendation, page: body, opened: new Date().toISOString() });
    // The structural half of "a dry run writes nothing", as `run --dry-run` has it: a change
    // that let a write slip in ahead of this return fails here, loudly, rather than leaving a
    // branch or a commit in somebody's project.
    if (repositoryState(projectDir) !== dryRunState) throw new Error("policy set --dry-run: the repository changed — a dry run must write nothing");
    return { dryRun: true, name: proposal, branch, gate: GATE, changes, diff, page: preview, warnings };
  }

  assertCleanTree(projectDir, "policy set");
  assertOnMain(projectDir, "policy set");
  writeFileSync(join(projectDir, CONFIG_PATH), text);
  try {
    propose(projectDir, proposal, { gate: GATE, question, recommendation, page: body, paths: [CONFIG_PATH] });
  } catch (e) {
    // `propose` failed before its commit; the file this command wrote goes back to `main`'s.
    if (gitOk(["rev-parse", "--verify", "--quiet", "refs/heads/main"], projectDir)) {
      git(["checkout", "-q", "main"], projectDir);
      git(["checkout", "-q", "main", "--", CONFIG_PATH], projectDir);
    }
    throw e;
  }
  return { dryRun: false, name: proposal, branch, gate: GATE, changes, diff, warnings };
}

const list = (v) => (v === undefined ? [] : [v].flat());

COMMANDS.policy = async ({ pos, flags }) => {
  const [sub, ...rest] = pos;
  if (sub !== "set") throw new Error(`policy: unknown subcommand ${sub ?? "(none)"}\n  usage: sdlc ${POLICY_USAGE}`);
  const dryRun = flags["dry-run"];
  if (dryRun !== undefined && dryRun !== true) throw new Error("policy set: --dry-run takes no value; put it after the changes");
  const r = policySet(process.cwd(), {
    set: [...rest, ...list(flags.set)], unset: list(flags.unset),
    question: flags.question, recommendation: flags.recommendation, name: flags.name, dryRun: dryRun === true,
  });
  for (const w of r.warnings) console.log(`warning: ${w}`);
  if (r.dryRun) {
    console.log(`dry run: would open ${r.branch} at ${r.gate}; nothing was written\n`);
    console.log(r.page);
  } else {
    console.log(`opened ${r.branch} at ${r.gate}\n`);
    console.log(r.diff);
  }
  return 0;
};

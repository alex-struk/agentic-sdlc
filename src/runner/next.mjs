// What runs next, read from the record on `main` (`docs/stages/next.md`).
//
// Everything here reads. The record is read out of git objects — `git show`, `git cat-file`,
// `git ls-tree`, `git grep` against the `main` commit — never out of the working tree, so the
// answer is the same whichever branch is checked out and whatever is uncommitted, and nothing
// is checked out, written or committed to get it.
//
// Three kinds of work can be ready at once, and each kind is ordered by the record:
//
//   proposals  an open proposal a seat played by an agent can rule now, or a build proposal
//              that has to be verified before anyone can rule it; oldest first
//   owed       a returned proposal to revise, open owed work (`src/spec/owed.mjs`) and stale
//              tests; upstream stage first, then the project's domain order
//   sequence   the next stage the phases call for (`docs/specs/` §15); the first phase whose
//              exit criterion is not met, and within it the sequence's own order
//
// Which kind goes first when more than one is ready is not in the record, and is
// `policy.next.order`. Work that only a person can move — a proposal at a seat a person
// holds, an escalation to a person, an escalation that reached the role that raised it — is
// reported as waiting and never offered as something to run.
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { git, gitOk } from "../lib/git.mjs";
import { parseConfig } from "../config/load.mjs";
import { nextOrder } from "../config/policy.mjs";
import { STAGES, stagesFor } from "../profiles.mjs";
import { openAcross } from "../spec/owed.mjs";
import { MISSING_TEST, openMissingTestsAt } from "../spec/missing-tests.mjs";
import { parseTasks } from "../checks/plan.mjs";
import { STAGES_BY_NAME, proposalFamily, revisableStages } from "../stages/registry.mjs";
import { stallReason } from "./escalation.mjs";
import { buildVerifiedOnBranch, simulatedRole } from "../commands/rule.mjs";

// The phases the sequence moves through, each with the exit criterion that closes it.
export const PHASES = Object.freeze([
  { number: 1, name: "Spec", exit: "every domain ratified, with no criterion still inferred or open" },
  { number: 2, name: "Tests", exit: "the contract approved, every domain's tests approved, and every calibration row pass or ruled" },
  { number: 3, name: "Design", exit: "every domain's catalogue approved" },
  { number: 4, name: "Build", exit: "the plan approved and every slice approved at G3" },
  { number: 5, name: "Operate", exit: "the rebuilt application deployed and operated" },
]);

// How a proposal's name maps to the stage that produced it and what it is about. Longer
// prefixes first, so a family whose name begins with another's is read as its own.
const ROUTES = [
  { prefix: "intent-", stage: "intent" },
  { prefix: "archaeology-", stage: "archaeology", subject: "domain" },
  { prefix: "ratify-", stage: "ratify", subject: "domain" },
  { prefix: "contract-v", stage: "contract" },
  { prefix: "derive-tests-", stage: "derive-tests", subject: "domain" },
  { prefix: "bind-adapter-", stage: "bind-adapter", subject: "target" },
  { prefix: "calibrate-triage-", stage: "calibrate", subject: "target" },
  { prefix: "calibrate-", stage: "calibrate", subject: "target" },
  { prefix: "design-", stage: "design", subject: "domain" },
  { prefix: "build-slice-", stage: "build", subject: "slice" },
  { prefix: "plan", stage: "plan", exact: /^plan(?:-\d+)?$/ },
];

// The flag each stage needs to say what it runs on.
const SUBJECT_OF = { archaeology: "domain", ratify: "domain", "derive-tests": "domain", design: "domain", "bind-adapter": "target", calibrate: "target", build: "slice", verify: "slice" };

// Stages whose returned proposal is taken up by `--revise`. `archaeology` revises from its
// returned ruling without an overlay, so it is not among the registry's revisable stages.
function revises(stage) {
  return stage === "archaeology" || revisableStages().includes(stage);
}

const stageRank = (stage) => { const i = STAGES.indexOf(stage); return i === -1 ? STAGES.length : i; };

// ── Reading the record ────────────────────────────────────────────────────────────────

// Several objects in one `git cat-file --batch` call, each as text or `null` where it does
// not exist.
function catMany(projectDir, objects) {
  const out = new Map();
  if (!objects.length) return out;
  const buf = execFileSync("git", ["cat-file", "--batch"], {
    cwd: projectDir, input: `${objects.join("\n")}\n`, maxBuffer: 512 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  });
  let pos = 0;
  for (const obj of objects) {
    const nl = buf.indexOf(10, pos);
    const header = buf.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    if (/ (missing|ambiguous)$/.test(header)) { out.set(obj, null); continue; }
    const size = Number(header.split(" ")[2]);
    out.set(obj, buf.subarray(pos, pos + size).toString("utf8"));
    pos += size + 1;
  }
  return out;
}

function lsTree(projectDir, rev, dir) {
  try { return git(["ls-tree", "--name-only", `${rev}:${dir}`], projectDir).split("\n").filter(Boolean); } catch { return []; }
}

function refs(projectDir, pattern) {
  try {
    return git(["for-each-ref", "--sort=creatordate", "--format=%(refname:short)", pattern], projectDir).split("\n").filter(Boolean);
  } catch { return []; }
}

function yamlOf(text) {
  if (text == null) return null;
  try { return parseYaml(text) ?? {}; } catch { return {}; }
}

function jsonOf(text) {
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Each spec file's criterion header on `rev`, by path.
function specHeaders(projectDir, rev) {
  let out = "";
  try { out = git(["grep", "-n", "-e", "^// criterion: @", rev, "--", "tests/acceptance"], projectDir); } catch { return []; }
  const headers = [];
  for (const line of out.split("\n")) {
    const m = /^[^:]+:tests\/acceptance\/([^/]+)\/[^:]+:1:\/\/ criterion: @(\S+) v(\d+)$/.exec(line);
    if (m) headers.push({ domain: m[1], id: m[2], version: Number(m[3]) });
  }
  return headers;
}

// A proposal's line of work and its place in it: `<family>` is the first, `<family>-<n>` the
// nth. A stage with a proposal prefix names its own families (`proposalFamily`); any other
// proposal is numbered by a trailing `-<n>` or `-v<n>`.
export function lineage(name) {
  const family = proposalFamily(name);
  if (family) {
    const m = /^-(\d+)$/.exec(name.slice(family.length));
    return { family, n: m ? Number(m[1]) : 1 };
  }
  const m = /^(.*?)-v?(\d+)$/.exec(name);
  return m ? { family: m[1], n: Number(m[2]) } : { family: name, n: 1 };
}

// The stage a proposal came from and what it is about, or `null` for a proposal no stage
// opens (one made with `sdlc propose`).
export function routeOf(name, config) {
  const domains = config?.project?.domains ?? [];
  const targets = [config?.oracle?.target, ...Object.keys(config?.targets ?? {})].filter(Boolean);
  for (const r of ROUTES) {
    if (r.exact ? !r.exact.test(name) : !name.startsWith(r.prefix)) continue;
    const rest = name.slice(r.prefix.length);
    if (!r.subject) return { stage: r.stage };
    if (r.subject === "slice") {
      const m = /^(\d+)(?:-\d+)?$/.exec(rest);
      return m ? { stage: r.stage, slice: Number(m[1]) } : null;
    }
    const list = r.subject === "domain" ? domains : targets;
    const hit = list.filter((x) => rest === x || rest.startsWith(`${x}-`)).sort((a, b) => b.length - a.length)[0];
    const route = { stage: r.stage, [r.subject]: hit ?? null };
    if (r.stage === "derive-tests" && hit && /^-stale-\d+$/.test(rest.slice(hit.length))) route.stale = true;
    return route;
  }
  return null;
}

// Everything `next` reads, from `rev`.
export function readRecord(projectDir, rev = "main") {
  if (!gitOk(["rev-parse", "--verify", "-q", `${rev}^{commit}`], projectDir)) {
    throw new Error(`next: this repository has no ${rev} branch to read the record from`);
  }
  const at = (path) => `${rev}:${path}`;
  const gateFiles = lsTree(projectDir, rev, ".sdlc/gates").filter((f) => f.endsWith(".yaml"));
  const proposalBranches = refs(projectDir, "refs/heads/proposal/");
  const returnedBranches = refs(projectDir, "refs/heads/returned/");
  const configText = catMany(projectDir, [at(".sdlc/config.yaml")]).get(at(".sdlc/config.yaml"));
  if (configText == null) throw new Error(`next: ${rev} has no .sdlc/config.yaml`);
  const { config } = parseConfig(configText);
  if (!config || typeof config !== "object") throw new Error(`next: .sdlc/config.yaml on ${rev} does not parse`);
  const domains = config.project?.domains ?? [];
  const targets = [...new Set([config.oracle?.target, ...Object.keys(config.targets ?? {})].filter(Boolean))];

  const wanted = [
    at("spec/criteria-index.json"), at("plan/tasks.md"),
    ...gateFiles.map((f) => at(`.sdlc/gates/${f}`)),
    ...domains.map((d) => at(`spec/domains/${d}.md`)),
    ...targets.flatMap((t) => [at(`tests/results/${t}/latest.json`), at(`tests/results/${t}/applied.yaml`)]),
    ...proposalBranches.flatMap((b) => {
      const name = b.slice("proposal/".length);
      return [`${b}:.sdlc/gates/${name}.yaml`, `${b}:.sdlc/proposals/${name}.md`];
    }),
  ];
  const objects = catMany(projectDir, wanted);

  const gates = new Map(gateFiles.map((f) => {
    const text = objects.get(at(`.sdlc/gates/${f}`));
    return [f.slice(0, -".yaml".length), { text, doc: yamlOf(text) }];
  }));
  let merged = new Set();
  try {
    merged = new Set(git(["branch", "--merged", rev, "--format=%(refname:short)", "--list", "proposal/*"], projectDir).split("\n").filter(Boolean));
  } catch { /* nothing merged */ }
  const proposals = proposalBranches.map((branch) => {
    const name = branch.slice("proposal/".length);
    const gateText = objects.get(`${branch}:.sdlc/gates/${name}.yaml`);
    const page = objects.get(`${branch}:.sdlc/proposals/${name}.md`);
    return { name, branch, merged: merged.has(branch), gateText, gate: yamlOf(gateText), gateCode: /^gate:\s*(\S+)/m.exec(page ?? "")?.[1] ?? null };
  });
  const index = jsonOf(objects.get(at("spec/criteria-index.json")));
  const tasks = parseTasks(objects.get(at("plan/tasks.md")) ?? "").slices;
  const domainIds = new Map(domains.map((d) => {
    const text = objects.get(at(`spec/domains/${d}.md`));
    return [d, text == null ? null : [...text.matchAll(/^### (\S+) · /gm)].map((m) => m[1])];
  }));
  const results = new Map(targets.map((t) => [t, {
    latest: jsonOf(objects.get(at(`tests/results/${t}/latest.json`))),
    applied: yamlOf(objects.get(at(`tests/results/${t}/applied.yaml`))),
    adapter: gitOk(["rev-parse", "-q", "--verify", at(`tests/adapters/${t}`)], projectDir) ? git(["rev-parse", at(`tests/adapters/${t}`)], projectDir) : "",
  }]));
  // Missing tests are read with the records nothing has written an entry for yet, which are
  // owed all the same (`src/spec/missing-tests.mjs`).
  const owed = [
    ...openAcross(projectDir, { rev, familyOf: proposalFamily }).filter((e) => e.kind !== MISSING_TEST),
    ...openMissingTestsAt(projectDir, rev),
  ];
  const names = [
    ...gates.keys(),
    ...proposalBranches.map((b) => b.slice("proposal/".length)),
    ...returnedBranches.map((b) => b.slice("returned/".length)),
  ];
  return { rev, config, domains, targets, gates, proposals, names, index, tasks, domainIds, results, owed, headers: specHeaders(projectDir, rev) };
}

// ── Commands ──────────────────────────────────────────────────────────────────────────

export function runCommand(stage, args = {}) {
  const flag = (k) => {
    if (SUBJECT_OF[stage] !== k && args[k] === undefined) return null;
    if (args[k] === undefined || args[k] === null) return SUBJECT_OF[stage] === k ? `--${k} <${k}>` : null;
    return `--${k} ${args[k]}`;
  };
  return ["sdlc run", stage, flag("domain"), flag("target"), flag("slice"), args.stale ? "--stale" : null, args.revise ? "--revise" : null]
    .filter(Boolean).join(" ");
}

function ruleCommand(name, persona) {
  return `sdlc rule ${name} --by ${persona}`;
}

function personCommand(name, role) {
  return `sdlc rule ${name} approve|return --by ${role ?? "<role>"}`;
}

// ── Deciding ──────────────────────────────────────────────────────────────────────────

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function subjectKey(stage, route) {
  const s = SUBJECT_OF[stage];
  return `${stage}\u0000${s ? route?.[s] ?? "" : ""}`;
}

function approvedFamily(record, family) {
  for (const [name, g] of record.gates) {
    if (g.doc?.verdict === "approve" && lineage(name).family === family) return true;
  }
  return false;
}

function approvedPrefix(record, prefix) {
  for (const [name, g] of record.gates) if (g.doc?.verdict === "approve" && name.startsWith(prefix)) return true;
  return false;
}

function ratified(record, domain) {
  const rows = (record.index?.criteria ?? []).filter((c) => c.domain === domain);
  if (!rows.some((c) => c.state === "accepted")) return false;
  if (rows.some((c) => c.state !== "accepted" && c.state !== "obsolete")) return false;
  const inIndex = new Set(rows.map((c) => c.id));
  return (record.domainIds.get(domain) ?? []).every((id) => inIndex.has(id));
}

function calibrated(record, target) {
  const rows = record.results.get(target)?.latest?.rows;
  if (!Array.isArray(rows)) return false;
  return rows.every((r) => ["pass", "not-testable", "attested"].includes(r?.result) || r?.ruled);
}

// The steps of the sequence this project's profile runs, in order, each with what closes it.
function sequenceSteps(record) {
  const { config, domains } = record;
  const has = new Set(stagesFor(config.profile));
  const oracle = has.has("calibrate") ? config.oracle?.target : null;
  const steps = [];
  const add = (phase, stage, args, done, after = []) => steps.push({ phase, stage, args, done, after, key: `${stage}:${JSON.stringify(args)}` });
  if (has.has("intent")) add(1, "intent", {}, approvedPrefix(record, "intent-"));
  if (has.has("archaeology")) {
    for (const d of domains) add(1, "archaeology", { domain: d }, approvedFamily(record, `archaeology-${d}`), has.has("intent") ? ["intent:{}"] : []);
    if (has.has("ratify")) for (const d of domains) add(1, "ratify", { domain: d }, ratified(record, d), [`archaeology:${JSON.stringify({ domain: d })}`]);
  }
  if (has.has("contract")) add(2, "contract", {}, approvedFamily(record, "contract"));
  const contract = has.has("contract") ? ["contract:{}"] : [];
  if (oracle && has.has("bind-adapter")) add(2, "bind-adapter", { target: oracle }, approvedFamily(record, `bind-adapter-${oracle}`), contract);
  if (has.has("derive-tests")) for (const d of domains) add(2, "derive-tests", { domain: d }, approvedFamily(record, `derive-tests-${d}`), contract);
  if (oracle) {
    const before = steps.filter((s) => s.phase === 2 && s.stage !== "contract").map((s) => s.key);
    add(2, "calibrate", { target: oracle }, calibrated(record, oracle), before);
  }
  if (has.has("design")) for (const d of domains) add(3, "design", { domain: d }, approvedFamily(record, `design-${d}`));
  if (has.has("plan")) add(4, "plan", {}, approvedFamily(record, "plan"));
  if (has.has("build")) {
    let previous = has.has("plan") ? "plan:{}" : null;
    for (const s of record.tasks) {
      const args = { slice: s.number };
      add(4, "build", args, approvedFamily(record, `build-slice-${s.number}`), previous ? [previous] : []);
      previous = `build:${JSON.stringify(args)}`;
    }
  }
  for (const stage of ["deploy", "operate"]) if (has.has(stage)) add(5, stage, {}, false);
  return steps;
}

// Every proposal branch not yet merged, sorted into what a seat played by an agent can rule
// now, what waits on a person, and what has been returned for its stage to revise.
function proposalState(projectDir, record) {
  const { config } = record;
  const newest = new Map();
  for (const n of record.names) {
    const { family, n: k } = lineage(n);
    newest.set(family, Math.max(newest.get(family) ?? 0, k));
  }
  const superseded = (name) => { const l = lineage(name); return (newest.get(l.family) ?? 0) > l.n; };
  const ready = [];
  const waiting = [];
  const returned = [];
  const inFlight = new Set();
  for (const p of record.proposals) {
    if (p.merged || superseded(p.name)) continue;
    // Open means what `openProposalOn` means: nobody has ruled it, on its branch or on
    // `main`. A ruling on the branch that `main` holds word for word is one `main` has
    // recorded, and the branch has nothing left waiting.
    const onMain = record.gates.get(p.name)?.text ?? null;
    const route = routeOf(p.name, config);
    const code = p.gateCode ?? p.gate?.gate ?? null;
    const seat = code ? config.policy?.gates?.[code] : null;
    if (p.gateText == null) {
      if (onMain != null) continue;
      if (route) inFlight.add(subjectKey(route.stage, route));
      const holder = seat?.holder ?? null;
      if (route?.stage === "build") {
        const verified = buildVerifiedOnBranch(projectDir, p.branch, p.name, config);
        if (!verified.ok && !verified.notPassed) {
          ready.push({ kind: "proposals", stage: "verify", args: { slice: route.slice }, command: runCommand("verify", { slice: route.slice }), name: p.name,
            why: `${p.name} is open at ${code ?? "G3"} and has no verify result for the application it carries; it is verified before it is ruled` });
          continue;
        }
        if (verified.notPassed && holder?.startsWith("agent:")) {
          ready.push({ kind: "proposals", stage: "rule", command: ruleCommand(p.name, holder), name: p.name,
            why: `${p.name} is open at ${code}, held by ${holder}, and did not pass verify, so it is ruled by name to return or escalate it` });
          continue;
        }
      }
      if (holder?.startsWith("agent:")) {
        ready.push({ kind: "proposals", stage: "rule", command: ruleCommand(p.name, holder), name: p.name, why: `${p.name} is open at ${code}, held by ${holder}` });
      } else {
        waiting.push({ on: holder ?? "a person", name: p.name, gate: code, command: personCommand(p.name, holder),
          why: holder ? `open at ${code}, held by ${holder}, a seat a person holds` : `open at ${code ?? "an unknown gate"}, and the policy names no holder for it` });
      }
      continue;
    }
    if (onMain != null && onMain === p.gateText) continue;
    const verdict = p.gate?.verdict;
    if (verdict === "escalated") {
      if (route) inFlight.add(subjectKey(route.stage, route));
      const target = p.gate.escalate_to ?? seat?.escalate_to ?? null;
      const stalled = (typeof p.gate.stalled === "string" && p.gate.stalled.trim()) || stallReason({ by: p.gate.by, escalateTo: target });
      if (stalled || !target) {
        waiting.push({ on: target ?? "a person", name: p.name, gate: code, command: personCommand(p.name, target),
          why: target ? `escalated at ${code} by ${p.gate.by} to ${target}, the role that raised it: a dead end only a person can rule` : `escalated at ${code} with no escalation target` });
      } else if (simulatedRole(config, target)) {
        ready.push({ kind: "proposals", stage: "rule", command: ruleCommand(p.name, `agent:${target}`), name: p.name,
          why: `${p.name} was escalated at ${code} by ${p.gate.by} to ${target}, a role an agent plays in this project` });
      } else {
        waiting.push({ on: target, name: p.name, gate: code, command: personCommand(p.name, target), why: `escalated at ${code} by ${p.gate.by} to ${target}, a role a person holds` });
      }
      continue;
    }
    if (verdict === "return") {
      if (!route || !STAGES_BY_NAME[route.stage]?.implemented) {
        waiting.push({ on: "its proposer", name: p.name, gate: code, command: "sdlc propose ...",
          why: `returned at ${code} by ${p.gate.by}; no stage produces it, so whoever opened it proposes it again` });
        continue;
      }
      inFlight.add(subjectKey(route.stage, route));
      const s = SUBJECT_OF[route.stage];
      const args = { ...(s ? { [s]: route[s] ?? undefined } : {}), ...(revises(route.stage) ? { revise: true } : {}) };
      returned.push({ kind: "owed", stage: route.stage, args, command: runCommand(route.stage, args), name: p.name,
        why: `${p.name} was returned at ${code} by ${p.gate.by}${revises(route.stage) ? "" : `; ${route.stage} is run again to take the ruling up`}` });
    }
  }
  return { ready, waiting, returned, inFlight };
}

// The open owed work as runnable items, grouped by the run that answers them.
function owedWork(record, inFlight) {
  const byId = new Map((record.index?.criteria ?? []).map((c) => [c.id, c]));
  const groups = new Map();
  const group = (stage, args, one, many) => {
    const key = `${stage}\u0000${JSON.stringify(args)}`;
    if (!groups.has(key)) groups.set(key, { stage, args, parts: new Map() });
    const parts = groups.get(key).parts;
    parts.set(one, { many, n: (parts.get(one)?.n ?? 0) + 1 });
  };
  const summary = new Map();
  for (const e of record.owed) {
    const k = `${e.kind}\u0000${e.stage}`;
    summary.set(k, { kind: e.kind, stage: e.stage, count: (summary.get(k)?.count ?? 0) + 1 });
    if (e.kind === "condition") continue;
    if (e.kind === "request") {
      const s = SUBJECT_OF[e.stage];
      group(e.stage, { ...(s ? { [s]: e[s] ?? undefined } : {}), revise: true }, "revision request", "revision requests");
    } else if (e.kind === "redo") {
      group("derive-tests", { domain: byId.get(e.id)?.domain ?? undefined, stale: true }, "test to derive again (redo)", "tests to derive again (redo)");
    } else if (e.kind === "recovery") {
      group("archaeology", { domain: e.domain ?? byId.get(e.id)?.domain ?? undefined, revise: true }, "criterion to recover again", "criteria to recover again");
    } else if (e.kind === "rebind") {
      const r = record.results.get(e.target);
      const found = (r?.applied?.rulings ?? []).filter((x) => x?.verb === "adapter-wrong" && x.id === e.id).at(-1);
      if (found?.adapter && r.adapter && found.adapter !== r.adapter) group("calibrate", { target: e.target }, "binding to check again now that its adapter has changed (rebind)", "bindings to check again now that their adapter has changed (rebind)");
      else group("bind-adapter", { target: e.target }, "binding to fix (rebind)", "bindings to fix (rebind)");
    } else if (e.kind === MISSING_TEST) {
      // A test owed by the writer is derived again in its domain; one owed a run is run by the
      // calibration of its target; one owed a run by verify is run when its slice is verified,
      // which the build sequence already brings about, so it is counted and not offered.
      if (e.stage === "derive-tests") group("derive-tests", { domain: e.domain ?? byId.get(e.id)?.domain ?? undefined, stale: true }, "missing test", "missing tests");
      else if (e.stage === "calibrate") group("calibrate", { target: e.target ?? record.config?.oracle?.target ?? undefined }, "missing test owed a run", "missing tests owed a run");
      else if (e.stage !== "verify") {
        const s = SUBJECT_OF[e.stage];
        group(e.stage, s === "domain" && e.domain ? { domain: e.domain } : {}, "missing test", "missing tests");
      }
    } else {
      const s = SUBJECT_OF[e.stage];
      group(e.stage, s && e[s] !== undefined ? { [s]: e[s] } : {}, `${e.kind} item`, `${e.kind} items`);
    }
  }
  const stale = new Map();
  for (const h of record.headers) {
    const c = byId.get(h.id);
    if (c && c.state === "accepted" && h.version < c.version) {
      if (!stale.has(h.domain)) stale.set(h.domain, []);
      stale.get(h.domain).push(h.id);
    }
  }
  for (const [domain, ids] of stale) for (let i = 0; i < ids.length; i += 1) group("derive-tests", { domain, stale: true }, "stale test", "stale tests");
  const items = [];
  for (const g of groups.values()) {
    if (inFlight.has(subjectKey(g.stage, g.args))) continue;
    const detail = [...g.parts].map(([one, { many, n }]) => plural(n, one, many)).join(", ");
    const where = g.args.domain ? ` in ${g.args.domain}` : g.args.target ? ` for target ${g.args.target}` : "";
    items.push({ kind: "owed", stage: g.stage, args: g.args, command: runCommand(g.stage, g.args), why: `${detail}${where} owed by ${g.stage}` });
  }
  return { items, summary: [...summary.values()], stale: [...stale].map(([domain, ids]) => ({ domain, ids })) };
}

function ordered(items, record) {
  const domainRank = (d) => { const i = record.domains.indexOf(d); return i === -1 ? record.domains.length : i; };
  return [...items].sort((a, b) => stageRank(a.stage) - stageRank(b.stage)
    || domainRank(a.args?.domain) - domainRank(b.args?.domain)
    || String(a.args?.target ?? "").localeCompare(String(b.args?.target ?? ""))
    || (a.args?.slice ?? 0) - (b.args?.slice ?? 0));
}

const WITHIN = {
  proposals: "oldest proposal first",
  owed: "upstream stage first, then the project's domain order",
  sequence: "the first phase whose exit criterion is not met, in the sequence's order",
};

// What runs next, and why, from the record on `rev`.
export function whatNext(projectDir, { rev = "main" } = {}) {
  const record = readRecord(projectDir, rev);
  const order = nextOrder(record.config);
  const props = proposalState(projectDir, record);
  const owed = owedWork(record, props.inFlight);

  const steps = sequenceSteps(record);
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const open = steps.filter((s) => !s.done);
  const phaseNumber = open.length ? open[0].phase : null;
  const phase = phaseNumber ? PHASES.find((p) => p.number === phaseNumber) : null;
  const sequence = [];
  let blocked = null;
  for (const s of open.filter((x) => x.phase === phaseNumber)) {
    if (!s.after.every((k) => byKey.get(k)?.done ?? true)) continue;
    if (props.inFlight.has(subjectKey(s.stage, s.args))) continue;
    if (!STAGES_BY_NAME[s.stage]?.implemented) { blocked ??= `the next stage in the sequence, ${s.stage}, is not implemented in this pipeline yet`; continue; }
    const where = s.args.domain ? ` for ${s.args.domain}` : s.args.target ? ` for target ${s.args.target}` : s.args.slice !== undefined ? ` for slice ${s.args.slice}` : "";
    sequence.push({ kind: "sequence", stage: s.stage, args: s.args, command: runCommand(s.stage, s.args),
      why: `phase ${phase.number} ${phase.name} is not complete (exit: ${phase.exit}), and ${s.stage}${where} is next in it` });
  }

  const byKind = {
    proposals: props.ready,
    owed: ordered([...props.returned, ...owed.items], record),
    sequence,
  };
  const ready = order.flatMap((kind) => (byKind[kind] ?? []).map((c) => ({ ...c, rule: ruleFor(kind, order, byKind) })));
  const next = ready[0] ?? null;
  const state = next ? "run" : props.waiting.length ? "waiting" : "idle";
  return {
    state,
    next,
    ready,
    waiting: props.waiting,
    owed: owed.summary,
    stale: owed.stale,
    phase: phase ? { ...phase } : null,
    complete: open.length === 0,
    blocked,
    order,
  };
}

function ruleFor(kind, order, byKind) {
  const others = order.filter((k) => k !== kind && byKind[k]?.length);
  const first = others.length ? `${kind} before ${others.join(" and ")} (policy.next.order: ${order.join(", ")})` : `the only kind of work ready is ${kind}`;
  return `${first}; within it, ${WITHIN[kind]}`;
}

// ── Printing ──────────────────────────────────────────────────────────────────────────

function idleLine(r) {
  if (r.blocked) return `nothing to run: ${r.blocked}`;
  if (r.complete) return "nothing to run: every phase this project's profile runs is complete";
  return "nothing to run: the work left is waiting on a proposal in flight";
}

export function formatNext(r) {
  const lines = [];
  if (r.next) {
    lines.push(`next: ${r.next.command}`, `  why: ${r.next.why}`, `  rule: ${r.next.rule}`);
  } else if (r.state === "waiting") {
    lines.push("next: nothing can run until a person acts");
  } else {
    lines.push(`next: ${idleLine(r)}`);
  }
  if (r.phase) lines.push(`  phase: ${r.phase.number} ${r.phase.name} — exit: ${r.phase.exit}`);
  if (r.ready.length > 1) {
    lines.push("also ready:");
    for (const c of r.ready.slice(1)) lines.push(`  ${c.command} — ${c.why}`);
  }
  if (r.waiting.length) {
    lines.push("waiting on a person:");
    for (const w of r.waiting) lines.push(`  ${w.on}: ${w.name} — ${w.why} — ${w.command}`);
  }
  const owed = r.owed.filter((o) => o.count);
  lines.push(`owed: ${owed.length ? owed.map((o) => `${o.count} ${o.kind} (${o.stage})`).join(", ") : "nothing open"}`);
  lines.push(`stale tests: ${r.stale.length ? r.stale.map((s) => `${s.ids.length} in ${s.domain}`).join(", ") : "none"}`);
  return lines.join("\n");
}

// The short block a run or a ruling ends with.
export function formatNextShort(r) {
  const lines = [];
  if (r.next) lines.push(`next: ${r.next.command}`, `  why: ${r.next.why}`);
  else if (r.state === "waiting") lines.push("next: nothing can run until a person acts");
  else lines.push(`next: ${idleLine(r)}`);
  const more = [];
  if (r.ready.length > 1) more.push(`${r.ready.length - 1} more ready`);
  if (r.waiting.length) more.push(`${plural(r.waiting.length, "proposal")} waiting on a person`);
  if (more.length) lines.push(`  (${more.join(", ")}: sdlc next)`);
  return lines.join("\n");
}

// Whether a `sdlc run` invocation is the run `next` names. A subject `next` could not name
// (`--domain <domain>` on a request that records none) matches any.
export function matchesNext(r, stage, inv = {}) {
  const c = r?.next;
  if (!c || c.command.startsWith("sdlc rule")) return false;
  if (c.stage !== stage) return false;
  for (const k of ["domain", "target", "slice"]) {
    const want = c.args?.[k];
    if (want === undefined || want === null) continue;
    if (String(want) !== String(inv[k] ?? "")) return false;
  }
  return Boolean(c.args?.stale) === Boolean(inv.stale) && Boolean(c.args?.revise) === Boolean(inv.revise);
}

// What `next` names, in words, for a refusal or a deviation record.
export function namedByNext(r) {
  if (r?.next) return r.next.command;
  if (r?.state === "waiting") return "nothing: every open item waits on a person";
  return `nothing: ${r ? idleLine(r).replace(/^nothing to run: /, "") : "the record could not be read"}`;
}

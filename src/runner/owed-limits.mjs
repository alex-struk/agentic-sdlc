// The bound on a send-back loop over owed work (`policy.loops.<kind>`, spec §7.1).
//
// Rebinding an adapter, re-deriving a test, re-recovering a requirement and a stage asked
// again and again by one line of work are each a loop between the stage that owes the work
// and whoever keeps sending it back. Each send is an entry on the owed list, and every entry
// stays on file once answered, so how many times an item has been sent is read off the list
// (`sends`, `src/spec/owed.mjs`).
//
// A run handed an item already sent more times than the limit still runs: the work is still
// owed and the stage is still the one to do it. What changes is who rules the result. The
// proposal it opens is escalated by the runner to its gate's escalation target, in the shape
// every runner-raised escalation has (`escalateOnBranch`), rather than put to the gate holder
// for another round of the loop that has already failed to close. The same shape as verify's
// return limit and ratify's follow-up limit: an item that keeps coming back is usually coming
// back for a reason another attempt will not find, and somebody with more authority decides.
// A gate that names nobody to escalate to refuses the run before anything is spent.
import { identityOf, isOpen, read, sends } from "../spec/owed.mjs";
import { owedLoopLimit } from "../config/policy.mjs";
import { proposalFamily } from "../stages/registry.mjs";
import { escalateOnBranch } from "./escalation.mjs";

// Everything a run is handed as owed work: the round of requests a `--revise` run opened by
// requests answers, and whatever the stage itself reads for this run (`owedHanded` on the
// stage: derive-tests' redo entries, bind-adapter's rebind entries, archaeology's outstanding
// recoveries).
export function handedOwed(projectDir, stage, ctx) {
  return [...(ctx?.revision?.requests ?? []), ...(stage.owedHanded?.(projectDir, ctx) ?? [])];
}

const familyOf = (name) => proposalFamily(name) ?? name;

// How an item is named to a person: the criterion for most kinds, the criterion and target
// for a binding, and the line of work for requests.
function label(kind, entry) {
  if (kind === "request") return `requests from ${familyOf(entry.from)}`;
  if (kind === "rebind") return `${entry.id} on ${entry.target}`;
  return entry.item;
}

// The handed items sent more times than their kind's limit, each with every reason it was
// sent for, oldest first. An item handed twice in one run is reported once.
export function owedOverLimit(projectDir, stage, ctx) {
  const lists = new Map();
  const seen = new Set();
  const over = [];
  for (const handed of handedOwed(projectDir, stage, ctx)) {
    const kind = handed?.kind;
    const limit = owedLoopLimit(ctx?.config, kind);
    if (limit === null) continue;
    if (!lists.has(kind)) lists.set(kind, read(projectDir, kind, { familyOf }));
    const all = lists.get(kind);
    const id = identityOf(handed);
    const entry = all.find((e) => isOpen(e) && identityOf(e) === id) ?? all.find((e) => identityOf(e) === id);
    if (!entry || seen.has(`${kind}\u0000${entry.item}`)) continue;
    const n = sends(all, entry.item);
    if (n <= limit) continue;
    seen.add(`${kind}\u0000${entry.item}`);
    over.push({
      kind, item: entry.item, label: label(kind, entry), sends: n, limit,
      whys: all.filter((e) => e.item === entry.item).map((e) => e.why),
    });
  }
  return over;
}

function describe(stageName, o) {
  return `${o.label}: sent to ${stageName} ${o.sends} times, past the limit of ${o.limit} that policy.loops.${o.kind} sets`;
}

// The pre-check every gated stage runs. It stashes what is over the limit on `ctx` for
// `finishStage` to escalate — on `ctx` rather than recomputed, so a run resumed after a crash
// escalates exactly what the run that started was told — and refuses a run whose gate names
// no escalation target, since the proposal would then have nowhere to go.
export function checkOwedLimits(projectDir, stage, ctx) {
  const id = "owed-limits";
  const over = owedOverLimit(projectDir, stage, ctx);
  ctx.owedOverLimit = over;
  if (!over.length || !stage.gate) return { id, ok: true, messages: [] };
  if (ctx.config?.policy?.gates?.[stage.gate]?.escalate_to) return { id, ok: true, messages: [] };
  return {
    id, ok: false,
    messages: [`policy.gates.${stage.gate} names no escalate_to. ${over.map((o) => describe(stage.name, o)).join("; ")}. `
      + `What ${stage.name} produces for it is escalated to ${stage.gate}'s escalation target; add escalate_to to ${stage.gate} in .sdlc/config.yaml`],
  };
}

// Escalates the proposal a run has just opened when it was handed anything over the limit,
// returning the role it went to, or `null` when nothing was.
export function escalateOverLimit(projectDir, stage, ctx, proposal) {
  const over = ctx?.owedOverLimit ?? [];
  if (!over.length || !proposal?.name || !stage.gate) return null;
  const escalateTo = ctx.config?.policy?.gates?.[stage.gate]?.escalate_to;
  if (!escalateTo) return null;
  const items = over.map((o) => [
    `- ${describe(stage.name, o)}. What each send asked for:`,
    ...o.whys.map((why, i) => `  ${i + 1}. ${String(why ?? "").replace(/\s+/g, " ").trim()}`),
  ].join("\n"));
  escalateOnBranch(projectDir, {
    name: proposal.name, gate: stage.gate, by: `runner:${stage.name}`, escalateTo,
    rationale: [
      `${stage.name} was handed owed work sent back to it more times than the project's policy allows, `
        + `so this proposal is ruled by ${escalateTo} rather than put to ${stage.gate}'s holder for another round.`,
      ...items,
    ].join("\n"),
  });
  return escalateTo;
}

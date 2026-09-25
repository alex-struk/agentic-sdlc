// Owed work: everything the pipeline has asked for across runs and not yet seen done, kept as
// one list of entries with one shape and a `kind` (`docs/operating-model.md` §6).
//
// An entry names what is owed (`item`), the stage that owes it (`stage`), why (`why`, in the
// words of whoever asked), who opened it at which ruling (`from`, `gate`, `by`, `at`), and
// whether it has been accounted for (`closed`: `{ outcome: "met" | "withdrawn", why, by, at }`,
// where `why` is the evidence for `met` and the reason for `withdrawn`). Whatever else a kind
// needs to say — a redo's criterion version, a rebind's target, a recovery's domain — sits
// beside those fields on the same entry.
//
// Five kinds are in use, each stored where it has always been:
//
//   condition  `.sdlc/conditions.yaml`         a plain condition on a return, owed by the
//                                               stage the proposal goes back to
//   request    `.sdlc/revision-requests.yaml`  `addressed-to <stage>: <why>` — a ruling
//                                               asking another stage to revise
//   redo       `tests/acceptance/redo.yaml`    a criterion whose test is to be derived again
//   rebind     `tests/adapters/rebind.yaml`    a binding a calibration found wanting
//   recovery   `spec/recovery.yaml`            a criterion to be recovered again
//
// Any other kind is stored in `.sdlc/owed.yaml`, in the shape above with nothing added, so a
// new kind of owed work needs no code here. Every file is the pipeline's own bookkeeping,
// written only through this module and never by an agent.
//
// What the kinds keep of their own is what a reader relies on. A condition is never a reason
// to start a run: only a `request` opens a `--revise` run with no returned ruling behind it
// (`requestedRevision`, `src/stages/proposals.mjs`), and a condition is shown to the run and
// its ruler as owed (`docs/decisions/0032-an-instruction-nobody-had-to-account-for.md`). A
// request is marked `taken` when a run takes it up, and cannot be withdrawn. A redo entry
// carries the criterion's version and the ruler's words verbatim. Closing a condition needs a
// reason, and closing anything needs one: an entry closed with nothing said about why is
// indistinguishable from one that was lost.
//
// Nothing is removed. A closed entry stays on file, which is what lets a later reader ask how
// many times an item was sent (`sends`) and what each attempt was told.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";
import { git } from "../lib/git.mjs";

export const OWED_PATH = ".sdlc/owed.yaml";

const OUTCOMES = ["met", "withdrawn"];

// Drops the fields every view carries that a kind with its own file derives rather than
// stores, so what is written back is exactly the kind's stored shape.
function without(entry, keys) {
  const out = { ...entry };
  for (const k of keys) delete out[k];
  return out;
}

// A closure written under `closed`, the way conditions have always been closed and the way
// redo and rebind entries are.
const closedField = (e) => e.closed ?? null;
const withClosed = (stored, closed) => (closed ? { ...stored, closed } : stored);

const KINDS = {
  condition: {
    path: ".sdlc/conditions.yaml",
    list: "conditions",
    outcomes: OUTCOMES,
    view: (s) => ({ ...s, item: s.ref, why: s.text, closed: closedField(s) }),
    store: (v) => {
      const rest = without(v, ["kind", "item", "why", "closed"]);
      return withClosed({ ref: rest.ref, text: rest.text ?? v.why, ...rest }, v.closed);
    },
    identity: (e) => e.ref,
    dedupe: "all",
  },
  request: {
    path: ".sdlc/revision-requests.yaml",
    list: "requests",
    outcomes: ["met"],
    // The line of work asking, so a stage asked again and again by one line of work is one
    // item sent several times. Entries filed before `family` was recorded name only the
    // proposal, and a caller that can resolve its family passes `familyOf`.
    view: (s, { familyOf }) => ({
      ...s,
      item: `${s.stage} <- ${s.family ?? familyOf?.(s.from) ?? s.from}`,
      closed: s.taken ? { outcome: "met", why: "taken up by a revision of this stage", at: s.taken } : null,
    }),
    store: (v) => {
      const rest = without(v, ["kind", "item", "closed", "taken"]);
      return v.closed ? { ...rest, taken: v.closed.at } : rest;
    },
    identity: (e) => `${e.stage}\u0000${e.from}\u0000${e.why}`,
    dedupe: "all",
    // One ruling routing several conditions to one stage asks once: they are halves of one
    // observation (`revisionRound`).
    round: (e) => `${e.from ?? ""}\u0000${e.gate ?? ""}\u0000${e.by ?? ""}`,
  },
  redo: {
    path: "tests/acceptance/redo.yaml",
    list: "redo",
    outcomes: ["met"],
    view: (s) => ({ ...s, item: s.id, stage: "derive-tests", closed: closedField(s) }),
    store: (v) => withClosed(without(v, ["kind", "item", "stage", "closed"]), v.closed),
    identity: (e) => e.id,
    dedupe: "open",
  },
  rebind: {
    path: "tests/adapters/rebind.yaml",
    list: "rebind",
    outcomes: ["met"],
    view: (s) => ({ ...s, item: `${s.target}:${s.id}`, stage: "bind-adapter", closed: closedField(s) }),
    store: (v) => withClosed(without(v, ["kind", "item", "stage", "closed"]), v.closed),
    identity: (e) => `${e.target}:${e.id}`,
    dedupe: "open",
  },
  recovery: {
    path: "spec/recovery.yaml",
    list: "recovery",
    outcomes: ["met"],
    // `answered` is the runner's stamp of what the re-recovery produced; it is the closure.
    view: (s) => ({
      ...s,
      item: s.id,
      stage: "archaeology",
      closed: s.answered !== undefined && s.answered !== null
        ? { outcome: "met", why: s.answered?.removed ? "the recovery removed the row" : `recovered again at v${s.answered?.version}` }
        : null,
    }),
    store: (v) => {
      const rest = without(v, ["kind", "item", "stage", "closed", "answered"]);
      if (!v.closed) return rest;
      return { ...rest, answered: v.answered ?? { why: v.closed.why } };
    },
    identity: (e) => `${e.id}\n${e.why}`,
    dedupe: "all",
  },
};

// Every kind the engine has no file for shares one, in the entry shape itself.
function sharedKind(kind) {
  return {
    path: OWED_PATH,
    list: "owed",
    shared: true,
    outcomes: OUTCOMES,
    view: (s) => ({ ...s, closed: closedField(s) }),
    store: (v) => withClosed({ kind, ...without(v, ["kind", "closed"]) }, v.closed),
    identity: (e) => e.item,
    dedupe: "open",
  };
}

function def(kind) {
  if (!kind || typeof kind !== "string") throw new Error(`owed work needs a kind, got ${JSON.stringify(kind)}`);
  return KINDS[kind] ?? sharedKind(kind);
}

// The project-relative file a kind is kept in.
export function owedPath(kind) {
  return def(kind).path;
}

// The kinds with a file of their own.
export const OWED_KINDS = Object.freeze(Object.keys(KINDS));

function rawList(text, d) {
  let parsed;
  try { parsed = parseYaml(text ?? ""); } catch { return []; }
  return Array.isArray(parsed?.[d.list]) ? parsed[d.list] : [];
}

function viewsFrom(raw, kind, d, opts) {
  return raw
    .filter((s) => s && typeof s === "object" && (!d.shared || s.kind === kind))
    .map((s) => ({ kind, ...d.view(s, opts ?? {}) }));
}

// A kind's entries as one text holds them — a working tree's file, or one read out of a
// commit — in the order they were filed. Text that does not parse holds nothing: this list is
// one stage's input rather than its subject, and a stage refusing to run because a
// bookkeeping file is malformed is a stage stopped by something nobody can see from where
// they are standing.
export function entriesIn(kind, text, opts) {
  const d = def(kind);
  return viewsFrom(rawList(text, d), kind, d, opts);
}

// Every entry of a kind in the working tree, open and closed.
export function read(projectDir, kind, opts) {
  const d = def(kind);
  const p = join(projectDir, d.path);
  if (!existsSync(p)) return [];
  return viewsFrom(rawList(readText(p), d), kind, d, opts);
}

// Every entry of a kind as a commit holds it — `main` unless told otherwise. A ruling has the
// proposal's own branch checked out, and a branch cut before an entry was filed does not carry
// it: a guard reading the checkout would refuse a reference that is perfectly good, and a
// prompt reading it would show a stage or a ruler a different list from the one the ruling is
// judged against. A commit with no such file owes nothing.
export function readAt(projectDir, kind, rev = "main", opts) {
  try { return entriesIn(kind, git(["show", `${rev}:${def(kind).path}`], projectDir), opts); }
  catch { return []; }
}

export function isOpen(entry) {
  return Boolean(entry) && !entry.closed;
}

// Replaces a kind's entries on disk with `views`, written in the kind's stored shape. A kind
// sharing `.sdlc/owed.yaml` leaves every other kind's entries where they were. Returns the
// project-relative path.
function writeAll(projectDir, kind, views) {
  const d = def(kind);
  const p = join(projectDir, d.path);
  const stored = views.map((v) => d.store(v));
  if (!d.shared) {
    writeText(p, stringifyYaml({ [d.list]: stored }));
    return d.path;
  }
  const others = existsSync(p) ? rawList(readText(p), d).filter((s) => s?.kind !== kind) : [];
  writeText(p, stringifyYaml({ [d.list]: [...others, ...stored] }));
  return d.path;
}

// Rewrites a kind's whole list through `change`, for a caller whose write is not an opening or
// a closing — the runner's own recovery stamp, which overwrites whatever a session wrote in
// its place. `null` when `change` returns the list unchanged, so nothing is written for a
// rewrite that changed nothing.
export function rewrite(projectDir, kind, change) {
  const before = read(projectDir, kind);
  const after = change(before.map((e) => ({ ...e })));
  if (JSON.stringify(after) === JSON.stringify(before)) return null;
  return writeAll(projectDir, kind, after);
}

// Files the entries not already on file. What counts as already on file is the kind's own
// identity — a condition's reference, a request's stage, proposal and words, a redo's
// criterion — checked against every entry for a kind whose repeat is a replay (a condition, a
// request, a recovery) and against open entries for one whose repeat is a second send (a redo,
// a rebind): an item closed and then asked for again is owed again, and the first reason given
// for an open item is the one kept.
//
// Returns the path it wrote and the entries it added, so a caller reports exactly what it
// changed rather than claiming an entry it did not make.
export function open(projectDir, kind, entries) {
  if (!entries?.length) return { path: null, added: [] };
  const d = def(kind);
  const list = read(projectDir, kind);
  const held = new Set(list.filter((e) => d.dedupe === "all" || isOpen(e)).map(d.identity));
  const added = [];
  for (const entry of entries) {
    const v = { kind, ...entry, closed: null };
    if (!v.why && v.text) v.why = v.text;
    const id = d.identity(v);
    if (held.has(id)) continue;
    held.add(id);
    added.push(v);
  }
  if (!added.length) return { path: null, added: [] };
  const written = writeAll(projectDir, kind, [...list, ...added]);
  return { path: written, added: entriesIn(kind, stringifyYaml({ [d.list]: added.map(d.store) })) };
}

function checkClosure(kind, d, closure) {
  if (!d.outcomes.includes(closure?.outcome)) {
    throw new Error(d.outcomes.length === 1
      ? `a ${kind} entry is closed as ${d.outcomes[0]}, not ${closure?.outcome}`
      : `an owed entry is closed as met or withdrawn, not ${closure?.outcome}`);
  }
  if (!String(closure.why ?? "").trim()) {
    throw new Error(`closing a ${kind} entry as ${closure.outcome} needs ${closure.outcome === "met" ? "evidence" : "a reason"}`);
  }
}

// Closes every open entry `match` accepts, as met with evidence or withdrawn with a reason.
// The entry keeps everything it was opened with, so why it was asked for survives its being
// answered. `null` where nothing open matches: closing what does not exist, or what somebody
// has already closed, is a closing about nothing and the caller refuses it rather than
// recording it.
export function close(projectDir, kind, match, { outcome, why, by, at = new Date().toISOString(), ...more } = {}) {
  const d = def(kind);
  const closure = { outcome, why, ...(by !== undefined ? { by } : {}), at, ...more };
  checkClosure(kind, d, closure);
  const list = read(projectDir, kind);
  let hit = false;
  const next = list.map((e) => {
    if (!isOpen(e) || !match(e)) return e;
    hit = true;
    return { ...e, closed: closure };
  });
  return hit ? writeAll(projectDir, kind, next) : null;
}

// Several entries settled in one write: each of `close` closed as met at `when`, and each of
// `defer` left open with the account of why the run that had it could not answer it.
//
// All of it moves or none of it does. A set settled one entry at a time can be interrupted
// half way and leave a file saying one half of a round was answered and the other never
// asked, so the entries are matched whole before anything is written, each against an open
// entry not already matched, and one that no longer matches anything (a round settled twice,
// a file edited underneath) writes nothing and returns `null`.
export function settle(projectDir, kind, { close: closing = [], defer = [] } = {}, when = new Date().toISOString()) {
  if (!closing.length && !defer.length) return null;
  const d = def(kind);
  const list = read(projectDir, kind);
  const used = new Set();
  const index = (entry) => {
    const i = list.findIndex((e, n) => !used.has(n) && isOpen(e) && d.identity(e) === d.identity(entry));
    if (i !== -1) used.add(i);
    return i;
  };
  const closeAt = closing.map(index);
  const deferAt = defer.map((x) => index(x?.entry));
  if ([...closeAt, ...deferAt].some((i) => i === -1)) return null;
  const closure = { outcome: "met", why: "taken up", at: when };
  checkClosure(kind, d, closure);
  closeAt.forEach((i) => { list[i] = { ...list[i], closed: closure }; });
  deferAt.forEach((i, n) => {
    list[i] = { ...list[i], deferred: { at: when, why: defer[n]?.why ?? "", proposal: defer[n]?.proposal ?? "" } };
  });
  return writeAll(projectDir, kind, list);
}

// The kinds a listing across kinds reads: every kind with a file of its own, and whatever
// kinds were filed in `.sdlc/owed.yaml`, read off that file rather than off a list here.
function across(projectDir, { kinds, rev, familyOf } = {}) {
  let names = kinds;
  if (!names) {
    let text = "";
    try {
      if (rev) text = git(["show", `${rev}:${OWED_PATH}`], projectDir);
      else if (existsSync(join(projectDir, OWED_PATH))) text = readText(join(projectDir, OWED_PATH));
    } catch { text = ""; }
    const shared = rawList(text, { list: "owed" }).map((s) => s?.kind).filter((k) => typeof k === "string" && !KINDS[k]);
    names = [...OWED_KINDS, ...new Set(shared)];
  }
  return names.flatMap((kind) => (rev ? readAt(projectDir, kind, rev, { familyOf }) : read(projectDir, kind, { familyOf })));
}

// What a stage owes: every open entry naming it, across kinds (or the ones named), in the
// order each kind's file holds them. `rev` reads a commit's lists instead of the working tree.
export function openFor(projectDir, stage, opts = {}) {
  return across(projectDir, opts).filter((e) => isOpen(e) && e.stage === stage);
}

// What a line of work owes: every open entry opened by a ruling on one of its proposals.
// `familyOf` names the family of a proposal an entry records no family for.
export function openForFamily(projectDir, family, opts = {}) {
  const familyOf = opts.familyOf;
  return across(projectDir, opts).filter((e) => isOpen(e) && (e.family ?? familyOf?.(e.from)) === family);
}

// How many times an item has been sent to the stage that owes it: every entry ever filed for
// it, open or closed, with the entries one ruling filed together counted once. The count is
// what a loop limit reads (`policy.loops.<kind>`).
export function sends(entries, item) {
  const rounds = new Set();
  (entries ?? []).forEach((e, i) => {
    if (e?.item !== item) return;
    const d = def(e.kind);
    rounds.add(d.round ? d.round(e) : `#${i}`);
  });
  return rounds.size;
}

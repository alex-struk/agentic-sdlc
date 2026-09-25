import { SEAT_AGENT, seatKind, seatLabel } from "./seat.mjs";

// What ran an agent turn: the backend, the model and the CLI's version, as `runAgent`
// returns them on `engine`, and for a turn in a container the image that ran it and the egress
// allowlist it could reach (`docs/decisions/0061`). Every record of a turn carries it — the run record, the journal,
// the proposal page, an agent ruling's gate file — and every page that shows a turn names it
// in these words, so the Markdown record and the HTML site cannot come to describe the same
// turn differently.
//
// A model that is empty is one the CLI chose for itself: the project configured none, and
// the CLI does not report which it used. That is said, not left blank, since a blank reads as
// a record that lost the value.

export function engineShort(engine) {
  if (!engine?.backend) return "";
  return engine.model ? `${engine.backend} ${engine.model}` : `${engine.backend}, the CLI's default model`;
}

// Where the turn ran, for a turn in a container; empty for one on the host, whose label reads
// exactly as it always has.
export function isolationLabel(engine) {
  if (engine?.isolation !== "container") return "";
  return `in container ${engine.image || "(unknown image)"} with egress ${engine.egress || "(unknown)"}`;
}

export function engineLabel(engine) {
  const short = engineShort(engine);
  if (!short) return "";
  const ran = engine.version ? `${short} (${engine.version})` : short;
  const where = isolationLabel(engine);
  return where ? `${ran}, ${where}` : ran;
}

// The front-matter lines a journal entry, a proposal page and a gate file carry: the three
// that name what ran the turn, and where it ran — `container <image>` with its egress list, or
// `none` for a turn on the host. The
// strings go through `JSON.stringify` for the reason every other hand-written front matter in
// this codebase does: a colon or a quote inside a value can never break the block.
export function engineFrontMatter(engine) {
  if (!engine?.backend) return [];
  const lines = [`backend: ${engine.backend}`, `model: ${JSON.stringify(engine.model ?? "")}`, `cli: ${JSON.stringify(engine.version ?? "")}`];
  if (engine.isolation === "container") {
    lines.push(`isolation: ${JSON.stringify(`container ${engine.image ?? ""}`.trim())}`, `egress: ${JSON.stringify(engine.egress ?? "")}`);
  } else lines.push('isolation: "none"');
  return lines;
}

// The engine a record read back off disk carries, or null for one that names none — a
// person's ruling, a deterministic stage, anything written before records named one.
export function engineOf(record) {
  if (!record?.backend) return null;
  const engine = { backend: String(record.backend), model: String(record.model ?? ""), version: String(record.cli ?? "") };
  const m = String(record.isolation ?? "").match(/^container(?:\s+(\S+))?$/);
  if (m) Object.assign(engine, { isolation: "container", image: m[1] ?? "", egress: String(record.egress ?? "") });
  return engine;
}

// The seat, with the engine beside it where a persona agent ruled. A person's ruling and the
// runner's verdict ran on no agent, so they are shown exactly as `seatLabel` shows them.
export function seatWithEngine(heldBy, engine) {
  const seat = seatLabel(heldBy);
  if (seatKind(heldBy) !== SEAT_AGENT || !engine?.backend) return seat;
  const ran = `${seat} · ${engine.model ? `${engine.backend} ${engine.model}` : engine.backend}`;
  return engine.isolation === "container" ? `${ran} · container` : ran;
}

import { SEAT_AGENT, seatKind, seatLabel } from "./seat.mjs";

// What ran an agent turn: the backend, the model and the CLI's version, as `runAgent`
// returns them on `engine`. Every record of a turn carries it — the run record, the journal,
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

export function engineLabel(engine) {
  const short = engineShort(engine);
  if (!short) return "";
  return engine.version ? `${short} (${engine.version})` : short;
}

// The three front-matter lines a journal entry, a proposal page and a gate file carry. The
// strings go through `JSON.stringify` for the reason every other hand-written front matter in
// this codebase does: a colon or a quote inside a value can never break the block.
export function engineFrontMatter(engine) {
  if (!engine?.backend) return [];
  return [`backend: ${engine.backend}`, `model: ${JSON.stringify(engine.model ?? "")}`, `cli: ${JSON.stringify(engine.version ?? "")}`];
}

// The engine a record read back off disk carries, or null for one that names none — a
// person's ruling, a deterministic stage, anything written before records named one.
export function engineOf(record) {
  if (!record?.backend) return null;
  return { backend: String(record.backend), model: String(record.model ?? ""), version: String(record.cli ?? "") };
}

// The seat, with the engine beside it where a persona agent ruled. A person's ruling and the
// runner's verdict ran on no agent, so they are shown exactly as `seatLabel` shows them.
export function seatWithEngine(heldBy, engine) {
  const seat = seatLabel(heldBy);
  if (seatKind(heldBy) !== SEAT_AGENT || !engine?.backend) return seat;
  return `${seat} · ${engine.model ? `${engine.backend} ${engine.model}` : engine.backend}`;
}

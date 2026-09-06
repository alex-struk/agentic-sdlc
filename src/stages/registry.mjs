import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readText } from "../lib/fsx.mjs";
import { changedPaths } from "../lib/git.mjs";
import { STAGES } from "../profiles.mjs";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "skills");

function skillPath(name) {
  return join(SKILLS_DIR, `${name}.md`);
}

function checkProbeFile(projectDir) {
  const id = "probe-file";
  const p = join(projectDir, "app", "PROBE.md");
  if (!existsSync(p)) return { id, ok: false, messages: ["app/PROBE.md is missing"] };
  const text = readText(p);
  if (!text.includes("the runner works")) return { id, ok: false, messages: ["app/PROBE.md does not contain \"the runner works\""] };
  return { id, ok: true, messages: [] };
}

// `probe` proves the runner end to end: an isolated session, a workspace mode, a
// post-check, a journal entry. It is not one of the fifteen pipeline stages in
// src/profiles.mjs and is added to the registry only, never to STAGES there.
const probe = {
  name: "probe",
  title: "probe the runner",
  skill: skillPath("probe"),
  workspace: "project",
  gate: null,
  collect: [],
  implemented: true,
  prompt() {
    return "Create app/PROBE.md containing today's date and the sentence 'the runner works'. Then stop.";
  },
  // No gate, so there is nothing to put a question or a recommendation to.
  proposal() {
    return null;
  },
  preChecks() {
    return [];
  },
  postChecks(projectDir) {
    return [checkProbeFile(projectDir)];
  },
};

function checkBriefExists(projectDir) {
  const id = "brief-file";
  const p = join(projectDir, "intent", "brief.md");
  if (!existsSync(p)) return { id, ok: false, messages: ["intent/brief.md is missing: the tech lead writes the brief"] };
  return { id, ok: true, messages: [] };
}

// The file an `intent` run is judged by: whatever changed under `intent/` other than
// the brief itself. Computed fresh from git status rather than passed in, since it is
// needed both by a post-check and, once that post-check has passed, by `proposal` —
// which the stage contract calls with `ctx` alone, no `projectDir`.
function changedIntentFiles(projectDir) {
  return changedPaths(projectDir).filter((p) => p.startsWith("intent/") && p !== "intent/brief.md");
}

function checkIntentFile(projectDir) {
  const id = "intent-file";
  const changed = changedIntentFiles(projectDir);
  if (changed.length !== 1) {
    const found = changed.length ? `: ${changed.join(", ")}` : "";
    return { id, ok: false, messages: [`expected exactly one new or changed file under intent/ besides brief.md, found ${changed.length}${found}`] };
  }
  const [file] = changed;
  const full = join(projectDir, file);
  if (!existsSync(full)) return { id, ok: false, messages: [`${file} was deleted, not written`], file };
  const text = readText(full);
  const messages = [];
  if (text.includes("{{")) messages.push(`${file} still has a {{placeholder}} unfilled`);
  if (!/^## Open questions/m.test(text)) messages.push(`${file} is missing an "## Open questions" heading`);
  return { id, ok: messages.length === 0, messages, file };
}

function checkIntentScope(projectDir) {
  const id = "intent-scope";
  const outside = changedPaths(projectDir).filter((p) => !p.startsWith("intent/") && p !== "constitution.md");
  if (outside.length) return { id, ok: false, messages: [`intent may only change intent/ and constitution.md, but also touched: ${outside.join(", ")}`] };
  return { id, ok: true, messages: [] };
}

// The recommendation on an intent proposal is the first sentence of the agent's own
// journal text, not a re-derivation of it: whatever the agent decided to say first is
// what a reader sees first. Falls back to the whole (trimmed) text when it holds no
// sentence-ending punctuation, and to a fixed line when there is no text at all.
function firstSentence(text) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "no journal text was recorded";
  const match = trimmed.match(/^[^.!?]*[.!?]/);
  return (match ? match[0] : trimmed).trim();
}

// `intent` interviews `intent/brief.md` — the written stakeholder brief a tech lead
// supplies — and turns it into exactly one `intent/<slug>.md`, never inventing an
// answer the brief does not give. It holds gate G0: the opened proposal asks whether
// this is the right problem and outcome before any later stage builds on it.
const intent = {
  name: "intent",
  title: "intent",
  skill: skillPath("intent"),
  workspace: "project",
  gate: "G0",
  collect: [],
  implemented: true,
  prompt() {
    return [
      "Read intent/brief.md. Interview it using the grilling discipline described in your skill instructions: work through the intent template one question at a time, answer each only from what the brief actually says, and mark anything the brief does not answer as an open question rather than guessing at it.",
      "Write exactly one file, intent/<slug>.md, built from intent/.template.md, where <slug> is the brief's title lowercased with spaces and punctuation turned into hyphens. Fill in every section the template asks for, and list every open question under its own \"## Open questions\" heading — including ones nobody has answered yet.",
      "If the brief defines a term that constitution.md's J4 domain-language table does not already have a row for, add one. Touch no other file, and do not edit intent/brief.md itself.",
      "Finish with your journal entry.",
    ].join("\n\n");
  },
  proposal(ctx) {
    const file = ctx.intentFile ?? "intent/untitled.md";
    const slug = file.slice("intent/".length, -".md".length);
    return {
      name: `intent-${slug}`,
      question: "Is this the right problem and outcome?",
      recommendation: firstSentence(ctx.agentText),
    };
  },
  preChecks(projectDir) {
    return [checkBriefExists(projectDir)];
  },
  // `ctx` is the same object `runStage`/`resume` also hand to `proposal` a moment later
  // in the same `finishStage` call, so the file this discovers is stashed on it here —
  // the only way `proposal(ctx)` can name the right slug without a `projectDir` of its
  // own to look one up with.
  postChecks(projectDir, ctx) {
    const fileCheck = checkIntentFile(projectDir);
    if (fileCheck.ok) ctx.intentFile = fileCheck.file;
    return [fileCheck, checkIntentScope(projectDir)];
  },
};

// Every real pipeline stage (archaeology, design, build, …) is a stub until its own
// task lands: calling `prompt` fails loudly and by name, so `sdlc run <stage>` reports
// a clear reason instead of quietly doing nothing.
function stub(name) {
  return {
    name,
    title: name,
    skill: skillPath(name),
    workspace: "project",
    gate: null,
    collect: [],
    implemented: false,
    prompt() {
      throw new Error(`stage ${name} is not implemented yet`);
    },
    proposal() {
      return null;
    },
    preChecks() {
      return [];
    },
    postChecks() {
      return [];
    },
  };
}

export const STAGES_BY_NAME = Object.fromEntries(STAGES.map((name) => [name, stub(name)]));
STAGES_BY_NAME.probe = probe;
STAGES_BY_NAME.intent = intent;

export function stageFor(name) {
  const stage = STAGES_BY_NAME[name];
  if (!stage) throw new Error(`unknown stage: ${name}`);
  return stage;
}

// Test-only escape hatch: registers a stage object under its own name so a test can
// exercise `runStage`/`finishStage` against behaviour (a failing pre-check, a
// deliberately unimplemented stub) that no real stage in `profiles.mjs` exhibits yet,
// without needing a new task to land first.
export function registerStage(stage) {
  STAGES_BY_NAME[stage.name] = stage;
}

export function skillText(name) {
  const preamble = readText(join(SKILLS_DIR, "_preamble.md"));
  const stage = stageFor(name);
  return `${preamble}\n${readText(stage.skill)}`;
}

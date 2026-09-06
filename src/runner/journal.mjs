import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { readText, writeText } from "../lib/fsx.mjs";

function journalDir(projectDir) {
  return join(projectDir, ".sdlc", "journal");
}

// Front matter is written by hand (not via yaml.stringify) so its shape matches every
// other hand-written front matter block in this codebase (see propose.mjs, rule.mjs):
// JSON.stringify wraps the string fields so a colon or quote inside a title can never
// break the fence, and the whole block still parses as plain YAML on the way back in.
export function writeJournal(projectDir, { stage, title, body, metrics = {} }) {
  const dir = journalDir(projectDir);
  const existing = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
  const num = String(existing.length + 1).padStart(3, "0");
  const path = join(dir, `${num}-${stage}.md`);
  const { cost = 0, turns = 0, session = "" } = metrics;
  const front = [
    `stage: ${JSON.stringify(stage)}`,
    `title: ${JSON.stringify(title)}`,
    `at: ${JSON.stringify(new Date().toISOString())}`,
    `cost: ${cost}`,
    `turns: ${turns}`,
    `session: ${JSON.stringify(session)}`,
  ].join("\n");
  writeText(path, `---\n${front}\n---\n\n${body}`);
  return path;
}

export function readJournal(projectDir) {
  const dir = journalDir(projectDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  return files.map((file) => {
    const text = readText(join(dir, file));
    const m = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
    if (!m) return { file, stage: "", title: "", at: "", cost: 0, turns: 0, session: "", body: text };
    const front = parse(m[1]) ?? {};
    return {
      file,
      stage: front.stage ?? "",
      title: front.title ?? "",
      at: front.at ?? "",
      cost: front.cost ?? 0,
      turns: front.turns ?? 0,
      session: front.session ?? "",
      body: m[2],
    };
  });
}

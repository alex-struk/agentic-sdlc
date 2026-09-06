import { existsSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fsx.mjs";

export function checkConstitution(projectDir, ctx = {}) {
  const id = "constitution";
  const p = join(projectDir, "constitution.md");
  if (!existsSync(p)) return { id, ok: false, messages: ["constitution.md is missing"] };
  const text = readText(p);
  const messages = [];
  if (/\{\{[^}]*\}\}/.test(text)) messages.push("constitution.md still contains {{placeholders}}");
  const articles = text.split(/^### /m).slice(1);
  for (const a of articles) {
    const title = a.split("\n")[0].trim();
    if (!/^P\d+ /.test(title)) continue;
    const src = a.match(/^Source:\s*(.+)$/m);
    if (!src) messages.push(`${title.split(" ")[0]}: no "Source:" line (a URL, or the word convention)`);
    else if (!(src[1].trim() === "convention" || /^https?:\/\//.test(src[1].trim())))
      messages.push(`${title.split(" ")[0]}: Source must be a URL or "convention"`);
  }
  if (articles.filter((a) => /^P\d+ /.test(a)).length === 0) messages.push("no platform articles (### P1 …) found");
  return { id, ok: messages.length === 0, messages };
}

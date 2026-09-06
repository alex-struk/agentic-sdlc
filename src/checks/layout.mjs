import { existsSync } from "node:fs";
import { join } from "node:path";
import { stagesFor } from "../profiles.mjs";

const ALWAYS = ["constitution.md", ".sdlc/config.yaml", ".sdlc/lock.json", "intent", "spec", "spec/features",
  "spec/contract", "plan", "app", "evidence/pr-evidence.md", "tests/acceptance", "tests/adapters", "tests/seed"];
const BY_STAGE = { design: ["design"] };

export function checkLayout(projectDir, ctx = {}) {
  const id = "layout";
  const profile = ctx.config?.profile ?? "rebuild";
  const required = [...ALWAYS];
  for (const s of stagesFor(profile)) for (const p of BY_STAGE[s] ?? []) required.push(p);
  const messages = required.filter((p) => !existsSync(join(projectDir, p))).map((p) => `missing: ${p}`);
  return { id, ok: messages.length === 0, messages };
}
